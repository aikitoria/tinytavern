import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { mediaJobActive, type Message, type MediaJobInputSnapshot } from '@tinytavern/shared';
import { IMAGES_DIR, stmt, toMediaAsset, transaction } from './db.ts';
import {
  createMediaJob,
  createMediaJobFromRecipe,
  startMediaJob,
  cancelMediaJob,
  deleteMediaJob,
} from './mediaJobs.ts';
import {
  mediaLive,
  mediaJobRow,
  observeMediaJob,
  requireMediaJob,
  updateMediaJob,
  type MediaJobConfiguration,
  type MediaJobRow,
} from './mediaJobStore.ts';
import { tickMediaWorker } from './mediaWorker.ts';
import { getMediaRecipe, messageRecipeId } from './mediaRecipes.ts';
import { HttpError } from './router.ts';

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
export function startImageMediaJob(request: ImageRenderRequest): MediaJobRow {
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
    queueMicrotask(tickMediaWorker);
    return requireMediaJob(draft.id);
  });
}

/** Interactive callers retain the durable local result until they save or discard it. */
export async function renderImageAsset(request: ImageRenderRequest) {
  const job = startImageMediaJob(request);
  let unsubscribe = () => {};
  let rejectWait: ((reason: unknown) => void) | undefined;
  const release = () => {
    unsubscribe();
    request.signal?.removeEventListener('abort', onAbort);
    const current = mediaJobRow(job.id);
    if (current && !mediaJobActive(current.state)) {
      deleteMediaJob(current);
    }
  };
  const onAbort = () => {
    const current = mediaJobRow(job.id);
    if (current && mediaJobActive(current.state)) {
      cancelMediaJob(current);
      queueMicrotask(tickMediaWorker);
    }
    rejectWait?.(request.signal?.reason ?? new Error('Image generation cancelled'));
  };
  try {
    await new Promise<void>((resolve, reject) => {
      rejectWait = reject;
      const update = (row: MediaJobRow) => {
        const progress = mediaLive.get(row.id)?.progress;
        if (progress?.value !== undefined && progress.max !== undefined) {
          request.onProgress?.(progress.value, progress.max);
        }
        if (progress?.preview) {
          request.onPreview?.(progress.preview);
        }
        if (row.state === 'succeeded') {
          resolve();
        } else if (row.state === 'failed' || row.state === 'cancelled') {
          reject(new Error(row.error ?? 'Image generation cancelled'));
        }
      };
      unsubscribe = observeMediaJob(job.id, update);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      update(requireMediaJob(job.id));
    });
    request.signal?.throwIfAborted();
    const current = requireMediaJob(job.id);
    const assetId = (JSON.parse(current.outputs_json) as number[])[0];
    const assetRow = stmt('SELECT * FROM media_assets WHERE id = ?').get(assetId!);
    if (!assetRow) {
      throw new Error('The saved image result is unavailable');
    }
    const asset = toMediaAsset(assetRow);
    return {
      ext: extname(asset.url),
      path: asset.url,
      promptId: current.comfy_prompt_id!,
      release,
    };
  } catch (err) {
    release();
    throw err;
  }
}

/** Only the avatar preview needs the raster bytes in the HTTP response. */
export async function renderImageBuffer(request: ImageRenderRequest) {
  const result = await renderImageAsset(request);
  try {
    const data = await readFile(join(IMAGES_DIR, basename(result.path)), {
      signal: request.signal,
    });
    return { ...result, data };
  } catch (err) {
    result.release();
    throw err;
  }
}
