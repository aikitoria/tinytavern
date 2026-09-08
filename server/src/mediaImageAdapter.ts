import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Message, MediaJobInputSnapshot } from '@tinytavern/shared';
import { IMAGES_DIR, stmt, toMediaAsset, transaction } from './db.ts';
import { createMediaJob, createMediaJobFromRecipe, startMediaJob } from './mediaJobs.ts';
import {
  mediaLive,
  requireMediaJob,
  updateMediaJob,
  type MediaJobConfiguration,
  type MediaJobRow,
} from './mediaJobStore.ts';
import { tickMediaWorker } from './mediaWorker.ts';
import { getMediaRecipe, messageRecipeId } from './mediaRecipes.ts';
import { HttpError } from './router.ts';
import { consumeTemporaryMediaJob } from './temporaryMediaJob.ts';

export interface ImageRenderRequest {
  configuration: MediaJobConfiguration;
  inputs: MediaJobInputSnapshot[];
  prompt: string;
  signal?: AbortSignal;
  onProgress?: (value: number, max: number) => void;
  onPreview?: (preview: string) => void;
}

/** A chat swipe reuses the full recipe, including image-edit inputs and output selection. */
export function startMessageImageRender(
  message: Message,
  recipeId = messageRecipeId(message),
): MediaJobRow {
  if (!recipeId) {
    throw new HttpError(400, 'The message has no rendering recipe');
  }
  if (getMediaRecipe(recipeId).configuration.workflow.operation.startsWith('video')) {
    throw new HttpError(400, 'Use the video tool to rerun a video');
  }
  const result = transaction(() => {
    const draft = createMediaJobFromRecipe(recipeId, {
      requestKey: randomUUID(),
      prompt: message.content,
      contextConversationId: message.conversationId,
      destination: 'chat',
    });
    const job = requireMediaJob(draft.id);
    const configuration = JSON.parse(job.configuration_json!) as MediaJobConfiguration;
    updateMediaJob(job.id, {
      message_id: message.id,
      configuration_json: JSON.stringify({ ...configuration, messageRenderOnly: true }),
    });
    startMediaJob(requireMediaJob(job.id), {}, false);
    return requireMediaJob(job.id);
  });
  queueMicrotask(tickMediaWorker);
  return result;
}

/** Interactive image callers use the same workflow snapshots and background worker. */
function startImageMediaJob(request: ImageRenderRequest): MediaJobRow {
  request.signal?.throwIfAborted();
  const configuration: MediaJobConfiguration = {
    ...request.configuration,
    temporary: true,
  };
  return transaction(() => {
    const draft = createMediaJob(
      {
        requestKey: randomUUID(),
        operation: configuration.workflow.operation,
        workflowId: configuration.workflow.id,
        prompt: request.prompt,
        inputs: request.inputs,
        destination: 'gallery',
      },
      undefined,
      JSON.stringify(configuration),
      request.inputs,
    );
    startMediaJob(requireMediaJob(draft.id), {}, false);
    return requireMediaJob(draft.id);
  });
}

/** Only the avatar preview needs raster bytes; the temporary asset is released after reading. */
export async function renderImageBuffer(request: ImageRenderRequest) {
  return consumeTemporaryMediaJob(
    startImageMediaJob(request),
    {
      signal: request.signal,
      onProgress: (row) => {
        const progress = mediaLive.get(row.id)?.progress;
        if (progress?.value !== undefined && progress.max !== undefined) {
          request.onProgress?.(progress.value, progress.max);
        }
        if (progress?.preview) request.onPreview?.(progress.preview);
      },
    },
    async (row) => {
      const assetId = (JSON.parse(row.outputs_json) as number[])[0];
      const assetRow = stmt('SELECT * FROM media_assets WHERE id = ?').get(assetId!);
      if (!assetRow) throw new Error('The saved image result is unavailable');
      const asset = toMediaAsset(assetRow);
      const data = await readFile(join(IMAGES_DIR, basename(asset.url)), {
        signal: request.signal,
      });
      return { ext: extname(asset.url), data };
    },
  );
}
