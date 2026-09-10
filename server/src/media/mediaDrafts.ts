import { insertGalleryAsset } from './galleryStore.ts';
import { mediaJobActive } from '@tinytavern/shared';
import { stmt, toConversation, toMediaAsset, transaction } from '../db/db.ts';
import { HttpError } from '../http/router.ts';
import { positiveId } from '../http/validation.ts';
import { requireExpectedActiveLeaf } from '../conversations/concurrency.ts';
import { appendMessage, markMessageDirty } from '../conversations/tree.ts';
import { broadcastTree } from '../realtime/sync.ts';
import { invalidate } from '../realtime/events.ts';
import { discardSpeculativeSwipes } from '../generation/speculation.ts';
import { cancelMediaJob, deleteMediaJob, touchMediaConversation } from './mediaJobs.ts';
import {
  mediaDraft,
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
  return mediaDraftJobsById(row.draft_id);
}

export function mediaDraftJobsById(id: number): MediaJobRow[] {
  return stmt('SELECT * FROM media_jobs WHERE draft_id = ? ORDER BY created_at, id').all(
    id,
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

function textCandidate(row: MediaJobRow) {
  if (row.state !== 'succeeded' || !row.result_text?.trim())
    throw new HttpError(409, 'This text variation is no longer available');
  if (row.destination !== 'chat')
    throw new HttpError(400, 'Text results can be added to a chat; the gallery requires media');
  return { source: row, asset: null };
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

/** Keep the cancellation ledger and its input owners until the worker confirms completion. */
export function cancelMediaVariation(row: MediaJobRow) {
  if (row.draft_id && mediaJobActive(row.state)) {
    stmt(`UPDATE media_jobs SET configuration_json =
      json_set(COALESCE(configuration_json, '{}'), '$.discardOnCancel', json('true'))
      WHERE id = ?`).run(row.id);
  }
  const result = cancelMediaJob(requireMediaJob(row.id));
  cleanupDiscardedMediaDraft(requireMediaJob(row.id));
  return result;
}

/** Save one result without closing the draft or releasing its other variations. */
export function acceptMediaVariation(row: MediaJobRow, body: Record<string, unknown>) {
  const draft = requireOpenDraft(row, body);
  const { source, asset } =
    body.assetId === null ? textCandidate(row) : candidate(row, body.assetId);
  // The message FK is the saved-text identity and is cleared when that message is deleted.
  if (asset ? draft.savedAssetIds.includes(asset.id) : source.message_id !== null)
    return mediaJobDto(source);
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
  transaction(() => {
    if (source.destination === 'chat') {
      const chat = toConversation(conversation!);
      discardSpeculativeSwipes(chat.id);
      const message = appendMessage(
        chat.id,
        'tool',
        asset ? source.prompt : source.result_text!,
        chat.activeLeafId,
        'done',
        null,
        asset ? 'Media prompt' : 'Media result',
      );
      if (asset)
        stmt('UPDATE messages SET images_json = ?, render_recipe_id = ? WHERE id = ?').run(
          JSON.stringify([asset.url]),
          asset.recipeId,
          message.id,
        );
      updateMediaJob(source.id, { message_id: message.id });
      markMessageDirty(chat.id, message.id);
      touchMediaConversation(chat.id);
      broadcastTree(chat.id);
    } else if (asset) {
      insertGalleryAsset(asset, {
        conversationId: source.context_conversation_id,
        prompt: source.prompt,
      });
      invalidate('gallery');
    }
    stmt(`UPDATE media_drafts SET selected_asset_id = ?, revision = revision + 1
      WHERE id = ?`).run(asset?.id ?? draft.selectedAssetId, draft.id);
  });
  publishMediaJob(source.id);
  if (row.id !== source.id) publishMediaJob(row.id);
  return mediaJobDto(requireMediaJob(source.id));
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

/** Remote execution must stop before discarded drafts or variations release their owners. */
export function cleanupDiscardedMediaDraft(row: MediaJobRow): void {
  if (
    row.draft_id &&
    !mediaJobActive(row.state) &&
    (mediaDraft(row.draft_id).state === 'discarding' ||
      (row.state === 'cancelled' &&
        JSON.parse(row.configuration_json ?? '{}').discardOnCancel === true))
  ) {
    deleteMediaJob(row);
  }
}
