import { setMediaCharacters, mediaCharacterNames } from './mediaCharacters.ts';
import { stmt, transaction, invalidateMediaAsset, toMediaAsset } from './db.ts';
import { invalidate } from './events.ts';
import {
  mediaJobRow,
  requireMediaJob,
  updateMediaJob,
  publishMediaJob,
  mediaLive,
  type MediaJobConfiguration,
} from './mediaJobStore.ts';
import { deleteMediaJob, syncMediaJobMessage, touchMediaConversation } from './mediaJobs.ts';
import type { DownloadedMedia } from './mediaFiles.ts';
import type { MediaJobState } from '@tinytavern/shared';
import { saveMediaRecipe } from './mediaRecipes.ts';
import { deleteImageFiles } from './images.ts';

/** A remote-file ledger ID is a stable ingestion key across retries and restarts. */
export function ingestedMedia(jobId: string, remoteFileId: number) {
  const row = stmt(`
    SELECT a.* FROM media_assets a JOIN media_owners o ON o.asset_id = a.id
    WHERE o.owner_type = 'job' AND o.owner_id = ? AND o.slot = ?
  `).get(jobId, `output:${remoteFileId}`);
  return row ? toMediaAsset(row) : null;
}

export function recordMediaResult(
  jobId: string,
  remoteFileId: number,
  media: DownloadedMedia,
): number {
  return transaction(() => {
    const job = requireMediaJob(jobId);
    const configuration = JSON.parse(job.configuration_json!) as MediaJobConfiguration;
    saveMediaRecipe(configuration, JSON.parse(job.inputs_json), job.prompt, {
      id: job.id,
      instruction: job.instruction,
      seed: job.seed,
    });
    const result = stmt(`
      INSERT INTO media_assets (
        path, kind, mime, byte_size, width, height, duration, recipe_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      media.path,
      media.kind,
      media.mime,
      media.byteSize,
      media.width,
      media.height,
      media.duration,
      job.id,
      Date.now(),
    );
    const assetId = Number(result.lastInsertRowid);
    setMediaCharacters(assetId, configuration.characterIds ?? []);
    stmt(`
      INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
      VALUES (?, 'job', ?, ?)
    `).run(assetId, jobId, `output:${remoteFileId}`);

    const outputs = JSON.parse(job.outputs_json) as number[];
    outputs.push(assetId);
    updateMediaJob(jobId, { outputs_json: JSON.stringify(outputs) });
    invalidateMediaAsset(media.path);
    return assetId;
  });
}

export function finishMediaJob(
  jobId: string,
  state: MediaJobState,
  error: string | null = null,
): void {
  const current = mediaJobRow(jobId);
  if (!current) {
    return;
  }
  transaction(() => {
    const prompt = mediaLive.get(jobId)?.prompt ?? current.prompt;
    const job = updateMediaJob(jobId, { state, error, prompt });
    syncMediaJobMessage(job);
  });
  releaseDeletedMediaInputs(jobId);
  mediaLive.delete(jobId);
  publishMediaJob(jobId);
}

/** Active work may finish using a source that was deleted during generation. */
export function releaseDeletedMediaInputs(jobId: string): void {
  const deletedInputs = stmt(`SELECT a.path FROM media_assets a
    JOIN media_owners o ON o.asset_id = a.id
    WHERE o.owner_type = 'job' AND o.owner_id = ? AND o.slot LIKE 'input:%'
      AND a.reference_deleted = 1`).all(jobId);
  stmt(`DELETE FROM media_owners WHERE owner_type = 'job' AND owner_id = ?
    AND slot LIKE 'input:%' AND EXISTS
      (SELECT 1 FROM media_assets WHERE id = media_owners.asset_id AND reference_deleted = 1)`).run(
    jobId,
  );
  // completeMediaJob can call this inside its attachment transaction.
  if (deletedInputs.length) {
    queueMicrotask(() => deleteImageFiles(deletedInputs.map((input) => String(input.path))));
  }
}

/** Publish every final attachment together, after all requested files are durable. */
export function completeMediaJob(jobId: string): void {
  const saved = transaction(() => {
    const job = requireMediaJob(jobId);
    if (job.state !== 'downloading') {
      return;
    }
    const config = JSON.parse(job.configuration_json!) as MediaJobConfiguration;
    const assets = (JSON.parse(job.outputs_json) as number[]).map((id) => {
      const row = stmt('SELECT * FROM media_assets WHERE id = ?').get(id);
      if (!row) {
        throw new Error('A downloaded media asset is missing');
      }
      return toMediaAsset(row);
    });
    if (assets.length === 0) {
      throw new Error('Comfy produced no matching final media');
    }
    if (job.draft_id !== null) {
      stmt(`UPDATE media_drafts SET selected_asset_id = ?, revision = revision + 1
        WHERE id = ? AND state = 'open'`).run(assets[0]!.id, job.draft_id);
    } else if (job.destination === 'chat') {
      const message =
        job.message_id === null
          ? null
          : stmt(`
        SELECT conversation_id, images_json FROM messages WHERE id = ?
      `).get(job.message_id);
      if (!message) {
        finishMediaJob(jobId, 'cancelled');
        return;
      }
      const images = JSON.parse(String(message.images_json)) as string[];
      images.push(...assets.map((asset) => asset.url));
      stmt('UPDATE messages SET images_json = ?, active_image = ? WHERE id = ?').run(
        JSON.stringify(images),
        images.length - 1,
        job.message_id!,
      );
      touchMediaConversation(Number(message.conversation_id));
    } else if (!config.temporary) {
      const character =
        job.context_conversation_id === null
          ? null
          : stmt(`
        SELECT c.id, c.name FROM characters c
        JOIN conversations conv ON conv.character_id = c.id WHERE conv.id = ?
      `).get(job.context_conversation_id);
      const now = Date.now();
      const gallery = config.galleryOutput;
      for (const asset of assets) {
        stmt(`
          INSERT INTO gallery_items (
            character_name, source_conversation_id, prompt, image,
            image_width, image_height, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          mediaCharacterNames(asset.id) ||
            gallery?.characterName ||
            character?.name ||
            'Media tools',
          job.context_conversation_id,
          job.prompt,
          asset.url,
          asset.width,
          asset.height,
          now,
          now,
        );
      }
      invalidate('gallery');
    }
    if (!config.temporary && job.draft_id === null) {
      // Hand off ownership atomically with the attachments. Deleting a result still deletes
      // its file unless another message/gallery copy or reference input owns it.
      stmt(`DELETE FROM media_owners
        WHERE owner_type = 'job' AND owner_id = ? AND slot LIKE 'output:%'`).run(job.id);
    }
    finishMediaJob(jobId, 'succeeded');
    return !config.temporary && job.draft_id === null;
  });
  if (saved) {
    deleteMediaJob(requireMediaJob(jobId));
  }
}
