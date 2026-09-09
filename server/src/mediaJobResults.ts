import { setMediaCharacters } from './mediaCharacters.ts';
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
import { insertGalleryAsset } from './galleryStore.ts';

/** A remote-file ledger ID is a stable ingestion key across retries and restarts. */
export function ingestedMedia(jobId: number, remoteFileId: number) {
  const row = stmt(`
    SELECT a.* FROM media_assets a JOIN media_owners o ON o.asset_id = a.id
    WHERE o.owner_type = 'job' AND o.owner_id = ? AND o.slot = ?
  `).get(jobId, `output:${remoteFileId}`);
  return row ? toMediaAsset(row) : null;
}

export function recordMediaResult(
  jobId: number,
  remoteFileId: number,
  media: DownloadedMedia,
): number {
  return transaction(() => {
    const job = requireMediaJob(jobId);
    const configuration = JSON.parse(job.configuration_json!) as MediaJobConfiguration;
    const recipeId = saveMediaRecipe(configuration, JSON.parse(job.inputs_json), job.prompt, {
      id: job.recipe_id ?? undefined,
      instruction: job.instruction,
      seed: job.seed,
    });
    const result = stmt(`
      UPDATE media_assets SET kind = ?, mime = ?, byte_size = ?, width = ?, height = ?,
        duration = ?, recipe_id = ?, created_at = ? WHERE path = ? RETURNING id
    `).get(
      media.kind,
      media.mime,
      media.byteSize,
      media.width,
      media.height,
      media.duration,
      recipeId,
      Date.now(),
      media.path,
    );
    if (!result) throw new Error('The downloaded media asset reservation is missing');
    const assetId = Number(result.id);
    setMediaCharacters(assetId, configuration.characterIds ?? []);
    stmt(`
      INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
      VALUES (?, 'job', ?, ?)
    `).run(assetId, jobId, `output:${remoteFileId}`);

    const outputs = JSON.parse(job.outputs_json) as number[];
    outputs.push(assetId);
    updateMediaJob(jobId, { recipe_id: recipeId, outputs_json: JSON.stringify(outputs) });
    invalidateMediaAsset(media.path);
    return assetId;
  });
}

export function finishMediaJob(
  jobId: number,
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
export function releaseDeletedMediaInputs(jobId: number): void {
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
export function completeMediaJob(jobId: number): void {
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
      for (const asset of assets) {
        insertGalleryAsset(asset, {
          conversationId: job.context_conversation_id,
          prompt: job.prompt,
          characterName: config.galleryOutput?.characterName,
        });
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
