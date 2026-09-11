import { compileMediaWorkflow, type MediaJob, type MediaWorkflow } from '@tinytavern/shared';

/** Resolve labels from the saved workflow and values from the result. */
export function resultWorkflowDetails(
  job: Pick<MediaJob, 'workflowId' | 'workflowValues' | 'seed'>,
  workflows: MediaWorkflow[],
) {
  const workflow = workflows.find((workflow) => workflow.id === job.workflowId);
  let available = false;
  let parameters = Object.entries(job.workflowValues).map(([label, value]) => ({ label, value }));
  if (workflow) {
    try {
      parameters = compileMediaWorkflow(workflow.json).controls.map((control) => ({
        label: control.label,
        value: job.workflowValues[control.key] ?? control.value,
      }));
      available = true;
    } catch {
      // Keep saved overrides readable if the current workflow cannot compile.
    }
  }
  return {
    name: workflow?.name ?? 'Unavailable',
    seed: job.seed,
    available,
    parameters: parameters.map(({ label, value }) => ({
      label,
      value: typeof value === 'boolean' ? (value ? 'On' : 'Off') : String(value) || '(empty)',
    })),
  };
}
