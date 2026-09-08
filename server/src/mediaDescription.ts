import { randomUUID } from 'node:crypto';
import {
  mediaJobActive,
  mediaWorkflowKey,
  type ImageDescriptionProgress,
} from '@tinytavern/shared';
import { createMediaJob, startMediaJob, cancelMediaJob, deleteMediaJob } from './mediaJobs.ts';
import {
  mediaJobRow,
  mediaLive,
  observeMediaJob,
  requireMediaJob,
  type MediaJobRow,
} from './mediaJobStore.ts';
import { tickMediaWorker } from './mediaWorker.ts';
import { getSettings } from './settingsStore.ts';
import { HttpError } from './router.ts';
import { transaction } from './db.ts';

export function descriptionWorkflow(workflowId?: string) {
  const settings = getSettings().mediaRendering;
  const id = workflowId ?? settings.defaults[mediaWorkflowKey('image-describe', 0)];
  const workflow = settings.workflows.find(
    (item) => item.id === id && item.operation === 'image-describe',
  );
  if (!workflow)
    throw new HttpError(400, 'Add a Describe image workflow in Settings → Media rendering');
  return {
    comfyUrl: settings.comfyUrl,
    timeoutSeconds: settings.jobTimeoutSeconds,
    workflow,
    temporary: true,
  };
}

/** Gallery descriptions are temporary jobs; only the explicit gallery PATCH saves text. */
export async function describeImage(
  assetId: number,
  configuration: ReturnType<typeof descriptionWorkflow>,
  signal: AbortSignal,
  onProgress: (update: ImageDescriptionProgress) => void,
): Promise<string> {
  signal.throwIfAborted();
  const job = transaction(() => {
    const draft = createMediaJob(
      {
        requestKey: randomUUID(),
        operation: 'image-describe',
        workflowId: configuration.workflow.id,
        inputs: [{ slot: 'source', assetId }],
      },
      undefined,
      JSON.stringify(configuration),
    );
    startMediaJob(requireMediaJob(draft.id), {}, false);
    return requireMediaJob(draft.id);
  });
  let unsubscribe = () => {};
  let rejectWait: ((reason: unknown) => void) | undefined;
  const abort = () => {
    const current = mediaJobRow(job.id);
    if (current && mediaJobActive(current.state)) cancelMediaJob(current);
    queueMicrotask(tickMediaWorker);
    rejectWait?.(signal.reason);
  };
  try {
    return await new Promise<string>((resolve, reject) => {
      rejectWait = reject;
      const update = (row: MediaJobRow) => {
        const { value, max, node, graph } = mediaLive.get(row.id)?.progress ?? {};
        onProgress({ state: row.state, progress: { value, max, node, graph } });
        if (row.state === 'succeeded') resolve(row.prompt);
        else if (row.state === 'failed' || row.state === 'cancelled') {
          reject(new Error(row.error ?? 'Prompt generation cancelled'));
        }
      };
      unsubscribe = observeMediaJob(job.id, update);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else {
        update(job);
        queueMicrotask(tickMediaWorker);
      }
    });
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', abort);
    const current = mediaJobRow(job.id);
    if (current && !mediaJobActive(current.state)) deleteMediaJob(current);
  }
}
