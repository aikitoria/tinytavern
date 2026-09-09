import {
  mediaJobActive,
  newRequestId,
  type MediaJobInput,
  type MediaJobInputSnapshot,
} from '@tinytavern/shared';
import { cancelMediaJob, createMediaJob, deleteMediaJob, startMediaJob } from './mediaJobs.ts';
import { transaction } from '../db/db.ts';
import {
  mediaJobRow,
  observeMediaJob,
  requireMediaJob,
  type MediaJobRow,
  type MediaJobConfiguration,
} from './mediaJobStore.ts';
import { tickMediaWorker } from './mediaWorker.ts';

/** Capture and start atomically; consumption schedules the worker and owns cleanup. */
export function startTemporaryMediaJob(
  configuration: MediaJobConfiguration,
  inputs: MediaJobInput[],
  prompt = '',
  inputSnapshots?: MediaJobInputSnapshot[],
): MediaJobRow {
  return transaction(() => {
    const draft = createMediaJob(
      {
        requestKey: newRequestId(),
        operation: configuration.workflow.operation,
        workflowId: configuration.workflow.id,
        inputs,
        prompt,
        destination: 'gallery',
      },
      undefined,
      JSON.stringify({ ...configuration, temporary: true }),
      inputSnapshots,
    );
    startMediaJob(requireMediaJob(draft.id), {}, false);
    return requireMediaJob(draft.id);
  });
}

/** Keep the temporary result owned until consumption finishes, including asynchronous reads. */
export async function consumeTemporaryMediaJob<T>(
  job: MediaJobRow,
  options: { signal?: AbortSignal; onProgress?: (row: MediaJobRow) => void },
  consume: (row: MediaJobRow) => T | Promise<T>,
): Promise<T> {
  const { signal, onProgress } = options;
  let unsubscribe = () => {};
  let rejectWait: (reason: unknown) => void = () => {};
  const abort = () => rejectWait(signal?.reason ?? new Error('Media generation cancelled'));
  try {
    const completed = await new Promise<MediaJobRow>((resolve, reject) => {
      rejectWait = reject;
      const update = (row: MediaJobRow) => {
        try {
          onProgress?.(row);
          if (row.state === 'succeeded') resolve(row);
          else if (row.state === 'failed' || row.state === 'cancelled') {
            reject(new Error(row.error ?? 'Media generation cancelled'));
          }
        } catch (error) {
          reject(error);
        }
      };
      unsubscribe = observeMediaJob(job.id, update);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else {
        update(requireMediaJob(job.id));
        queueMicrotask(tickMediaWorker);
      }
    });
    signal?.throwIfAborted();
    const result = await consume(completed);
    signal?.throwIfAborted();
    return result;
  } finally {
    unsubscribe();
    signal?.removeEventListener('abort', abort);
    let current = mediaJobRow(job.id);
    if (current) {
      if (mediaJobActive(current.state)) {
        // The worker releases ownership once remote execution has actually stopped.
        cancelMediaJob(current);
        queueMicrotask(tickMediaWorker);
        current = mediaJobRow(job.id);
      }
      if (current && !mediaJobActive(current.state)) deleteMediaJob(current);
    }
  }
}
