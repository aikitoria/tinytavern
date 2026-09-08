import { mediaCharacterNames } from './mediaCharacters.ts';
import { mediaJobActive } from '@tinytavern/shared';
import { stmt, toConversation, toMediaAsset, transaction } from './db.ts';
import { HttpError } from './router.ts';
import { positiveId } from './validation.ts';
import { requireExpectedActiveLeaf } from './concurrency.ts';
import { appendMessage, markMessageDirty } from './tree.ts';
import { broadcastTree } from './sync.ts';
import { broadcast, invalidate } from './events.ts';
import { discardSpeculativeSwipes } from './speculation.ts';
import { deleteImageFiles } from './images.ts';
import {
  cancelMediaJob,
  deleteMediaJob,
  deleteMediaJobRecord,
  touchMediaConversation,
} from './mediaJobs.ts';
import {
  mediaDraft,
  mediaLive,
  mediaJobDto,
  publishMediaJob,
  requireMediaJob,
  updateMediaJob,
  type MediaJobRow,
} from './mediaJobStore.ts';

export function mediaDraftJobs(row: MediaJobRow): MediaJobRow[] {
  if (!row.draft_id) {
    return [row];
  }
  return stmt('SELECT * FROM media_jobs WHERE draft_id = ? ORDER BY created_at, id').all(
    row.draft_id,
  ) as unknown as MediaJobRow[];
}

function requireOpenDraft(row: MediaJobRow, body: Record<string, unknown>) {
  if (!row.draft_id) {
    throw new HttpError(400, 'This job is not part of a draft');
  }
  const draft = mediaDraft(row.draft_id);
  if (draft.state !== 'open' || body.expectedDraftRevision !== draft.revision) {
    throw new HttpError(409, 'The media draft changed; refresh and retry');
  }
  return draft;
}

function candidate(row: MediaJobRow, value: unknown) {
  const assetId = positiveId(String(value), 'asset ID');
  const source = stmt(`
    SELECT j.* FROM media_jobs j JOIN media_owners o
      ON o.owner_type = 'job' AND o.owner_id = j.id AND o.slot LIKE 'output:%'
    WHERE j.draft_id = ? AND j.state = 'succeeded' AND o.asset_id = ?
  `).get(row.draft_id!, assetId) as unknown as MediaJobRow | undefined;
  if (!source) {
    throw new HttpError(409, 'This variation is no longer available');
  }
  const asset = toMediaAsset(stmt('SELECT * FROM media_assets WHERE id = ?').get(assetId)!);
  return { source, asset };
}

export function selectMediaVariation(row: MediaJobRow, body: Record<string, unknown>) {
  const draft = requireOpenDraft(row, body);
  const { asset } = candidate(row, body.assetId);
  stmt(`UPDATE media_drafts SET selected_asset_id = ?, revision = revision + 1 WHERE id = ?`).run(
    asset.id,
    draft.id,
  );
  publishMediaJob(row.id);
  return mediaJobDto(requireMediaJob(row.id));
}

/** Only the chosen result receives a durable destination owner. */
export function acceptMediaVariation(row: MediaJobRow, body: Record<string, unknown>) {
  const draft = requireOpenDraft(row, body);
  const { source, asset } = candidate(row, body.assetId);
  const jobs = mediaDraftJobs(row);
  if (jobs.some((job) => mediaJobActive(job.state))) {
    throw new HttpError(409, 'Finish or cancel the running variation before accepting a result');
  }
  const conversation =
    source.context_conversation_id === null
      ? null
      : stmt('SELECT * FROM conversations WHERE id = ?').get(source.context_conversation_id);
  if (source.destination === 'chat') {
    if (!conversation) {
      throw new HttpError(409, 'The destination conversation was deleted');
    }
    requireExpectedActiveLeaf(
      Number(conversation.id),
      body.expectedActiveLeafId as number | null | undefined,
      body.expectedMutationRevision as number | undefined,
    );
  }
  const paths = stmt(`SELECT a.path FROM media_assets a JOIN media_owners o ON o.asset_id = a.id
    WHERE o.owner_type = 'job' AND o.owner_id IN (SELECT id FROM media_jobs WHERE draft_id = ?)`)
    .all(draft.id)
    .map((entry) => String(entry.path));
  const accepted = transaction(() => {
    if (source.destination === 'chat') {
      const chat = toConversation(conversation!);
      discardSpeculativeSwipes(chat.id);
      const message = appendMessage(
        chat.id,
        'tool',
        source.prompt,
        chat.activeLeafId,
        'done',
        null,
        'Media prompt',
      );
      stmt('UPDATE messages SET images_json = ?, render_recipe_id = ? WHERE id = ?').run(
        JSON.stringify([asset.url]),
        asset.recipeId,
        message.id,
      );
      updateMediaJob(source.id, { message_id: message.id });
      markMessageDirty(chat.id, message.id);
      touchMediaConversation(chat.id);
      broadcastTree(chat.id);
    } else {
      const character =
        conversation?.character_id === null || !conversation
          ? null
          : stmt('SELECT id, name FROM characters WHERE id = ?').get(conversation.character_id!);
      const now = Date.now();
      stmt(`INSERT INTO gallery_items (character_name, source_conversation_id,
        prompt, image, image_width, image_height, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        mediaCharacterNames(asset.id) || character?.name || 'Media tools',
        source.context_conversation_id,
        source.prompt,
        asset.url,
        asset.width,
        asset.height,
        now,
        now,
      );
      invalidate('gallery');
    }
    stmt(`UPDATE media_drafts SET state = 'accepted', selected_asset_id = ?, revision = revision + 1
      WHERE id = ?`).run(asset.id, draft.id);
    stmt(`DELETE FROM media_owners WHERE owner_type = 'job' AND owner_id = ?
      AND slot LIKE 'output:%'`).run(source.id);
    updateMediaJob(source.id, { outputs_json: JSON.stringify([asset.id]) });
    const result = mediaJobDto(requireMediaJob(source.id));
    for (const job of jobs) {
      deleteMediaJobRecord(job.id);
    }
    return result;
  });
  for (const job of jobs) {
    mediaLive.delete(job.id);
    broadcast({ t: 'mediaJobDeleted', id: job.id });
  }
  deleteImageFiles(paths);
  return accepted;
}

export function discardMediaDraft(row: MediaJobRow, body: Record<string, unknown>): void {
  const draft = requireOpenDraft(row, body);
  const jobs = mediaDraftJobs(row);
  if (
    body.onlyUnstarted === true &&
    jobs.some((job) => job.started_at !== null || job.state !== 'draft')
  ) {
    throw new HttpError(409, 'Generation has started in this draft; its work was kept');
  }
  stmt(`UPDATE media_drafts SET state = 'discarding', revision = revision + 1 WHERE id = ?`).run(
    draft.id,
  );
  for (const job of jobs) {
    if (mediaJobActive(job.state)) {
      const cancelled = cancelMediaJob(job);
      if (!mediaJobActive(cancelled.state)) {
        deleteMediaJob(requireMediaJob(job.id));
      }
    } else {
      deleteMediaJob(job);
    }
  }
}

/** Remote execution must stop before discarded jobs release their input/result owners. */
export function cleanupDiscardedMediaDraft(row: MediaJobRow): void {
  if (
    row.draft_id &&
    !mediaJobActive(row.state) &&
    mediaDraft(row.draft_id).state === 'discarding'
  ) {
    deleteMediaJob(row);
  }
}
