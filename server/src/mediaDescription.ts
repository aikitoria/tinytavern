import { mediaWorkflowKey, type ImageDescriptionProgress } from '@tinytavern/shared';
import { mediaLive } from './mediaJobStore.ts';
import { consumeTemporaryMediaJob, startTemporaryMediaJob } from './temporaryMediaJob.ts';
import { getSettings } from './settingsStore.ts';
import { HttpError } from './router.ts';

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
  return consumeTemporaryMediaJob(
    startTemporaryMediaJob(configuration, [{ slot: 'source', assetId }]),
    {
      signal,
      onProgress: (row) => {
        const { value, max, node, graph } = mediaLive.get(row.id)?.progress ?? {};
        onProgress({ state: row.state, progress: { value, max, node, graph } });
      },
    },
    (row) => row.prompt,
  );
}
