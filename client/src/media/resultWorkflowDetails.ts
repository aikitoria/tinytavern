import { compileMediaWorkflow, type MediaJob } from '@tinytavern/shared';

/** Read once when opening a result; never consult the current workflow or editor. */
export function resultWorkflowDetails(
  job: Pick<MediaJob, 'workflowSnapshot' | 'workflowValues' | 'seed'>,
) {
  const snapshot = job.workflowSnapshot;
  let available = false;
  let parameters = Object.entries(job.workflowValues).map(([label, value]) => ({ label, value }));
  if (snapshot) {
    try {
      parameters = compileMediaWorkflow(snapshot.json).controls.map((control) => ({
        label: control.label,
        value: job.workflowValues[control.key] ?? control.value,
      }));
      available = true;
    } catch {
      // Older snapshots may no longer compile. Keep their saved overrides readable.
    }
  }
  return {
    name: snapshot?.name ?? 'Unavailable',
    seed: job.seed,
    available,
    parameters: parameters.map(({ label, value }) => ({
      label,
      value: typeof value === 'boolean' ? (value ? 'On' : 'Off') : String(value) || '(empty)',
    })),
  };
}
