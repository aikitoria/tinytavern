import type { MediaJob, MediaWorkflow } from '@tinytavern/shared';

/** Historical details never infer labels or values from a mutable workflow. */
export function resultWorkflowDetails(
  job: Pick<MediaJob, 'workflowId' | 'workflowValues' | 'seed' | 'workflowName' | 'workflowParameters'>,
  _workflows?: MediaWorkflow[],
) {
  const available = job.workflowParameters !== undefined;
  const parameters =
    job.workflowParameters ?? Object.entries(job.workflowValues).map(([label, value]) => ({ label, value }));
  return {
    name: job.workflowName ?? 'Unavailable',
    seed: job.seed,
    available,
    parameters: parameters.map(({ label, value }) => ({
      label,
      value: typeof value === 'boolean' ? (value ? 'On' : 'Off') : String(value) || '(empty)',
    })),
  };
}
