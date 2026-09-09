import { createMemo } from 'solid-js';
import {
  compileMediaWorkflow,
  type MediaAsset,
  type MediaJob,
  type MediaWorkflow,
  type MediaWorkflowInput,
  type MediaWorkflowValues,
} from '@tinytavern/shared';

/** Job/value refreshes must not recreate the workflow controls and their DOM. */
export function createMediaWorkflowControls(source: () => string | undefined) {
  const json = createMemo(() => source() ?? '');
  return createMemo(() => {
    try {
      return { controls: json() ? compileMediaWorkflow(json()).controls : [], error: '' };
    } catch (err) {
      return { controls: [], error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Locked controls describe the captured job, even when a local draft or settings differ. */
export function mediaWorkflowView(
  job: MediaJob | undefined,
  selectedId: string,
  workflows: MediaWorkflow[],
  draftValues: MediaWorkflowValues,
  locked: boolean,
) {
  const id = locked && job ? (job.workflowSnapshot?.id ?? job.workflowId ?? '') : selectedId;
  const snapshot = job?.workflowSnapshot;
  return {
    id,
    workflow: snapshot?.id === id ? snapshot : workflows.find((workflow) => workflow.id === id),
    values: locked && job ? job.workflowValues : draftValues,
  };
}

export function imageWorkflowDefaults(
  controls: MediaWorkflowInput[],
  image: Pick<MediaAsset, 'width' | 'height'>,
): MediaWorkflowValues {
  const values: MediaWorkflowValues = {};
  if (!image.width || !image.height || image.width <= 0 || image.height <= 0) return values;
  const imageRatio = image.width / image.height;
  for (const control of controls) {
    if (control.type !== 'select' || control.input !== 'aspect_ratio') continue;
    let closest: string | undefined;
    let closestDistance = Infinity;
    for (const option of control.options) {
      const match = /^(\d+):(\d+)\b/.exec(option);
      if (!match) continue;
      const ratio = Number(match[1]) / Number(match[2]);
      // Compare proportions symmetrically, so portrait and landscape behave alike.
      const distance = Math.max(imageRatio / ratio, ratio / imageRatio);
      if (distance < closestDistance) {
        closest = option;
        closestDistance = distance;
      }
    }
    if (closest !== undefined) values[control.key] = closest;
  }
  return values;
}
