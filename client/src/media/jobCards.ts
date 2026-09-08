import { mediaJobActive, type MediaJob } from '@tinytavern/shared';

export const MEDIA_JOB_STATUS: Record<MediaJob['state'], string> = {
  draft: 'Draft',
  preparing: 'Preparing prompt',
  ready: 'Prompt ready',
  submitting: 'Submitting',
  reconciling: 'Checking submission',
  queued: 'Queued',
  rendering: 'Rendering',
  downloading: 'Saving result',
  cancelling: 'Cancelling',
  succeeded: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const MEDIA_INPUT_LABELS: Record<MediaJob['inputs'][number]['slot'], string> = {
  source: 'Source image',
  first_frame: 'First frame',
  reference1: 'Reference 1',
  reference2: 'Reference 2',
  reference3: 'Reference 3',
};

export interface MediaJobGroup {
  id: string;
  job: MediaJob;
  jobs: MediaJob[];
  createdAt: number;
}

/** Keep a running variation visible even when a newer, idle variation exists. */
export function groupMediaJobs(jobs: MediaJob[]): MediaJobGroup[] {
  const groups = new Map<string, MediaJobGroup>();
  for (const job of jobs) {
    if (job.operation === 'image-describe') continue;
    const id = job.draft?.id ?? job.id;
    const group = groups.get(id);
    if (!group) {
      groups.set(id, { id, job, jobs: [job], createdAt: job.createdAt });
      continue;
    }
    group.jobs.push(job);
    group.createdAt = Math.max(group.createdAt, job.createdAt);
    const active = mediaJobActive(job.state);
    const previousActive = mediaJobActive(group.job.state);
    if (
      (active && !previousActive) ||
      (active === previousActive &&
        (job.createdAt > group.job.createdAt ||
          (job.createdAt === group.job.createdAt && job.id > group.job.id)))
    )
      group.job = job;
  }
  return [...groups.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/** Bound card text work; show the newest tokens during generation. */
export function jobPromptExcerpt(
  job: Pick<MediaJob, 'state' | 'prompt' | 'reasoning' | 'instruction'>,
) {
  if (job.state === 'preparing') {
    const text = job.prompt || job.reasoning || '';
    return {
      label: job.prompt ? 'Writing prompt…' : 'Thinking…',
      text: text.length > 420 ? `…${text.slice(-420)}` : text,
    };
  }
  const text = job.prompt || job.instruction;
  return {
    label: job.prompt ? 'Prompt' : 'Instruction',
    text: text.length > 420 ? `${text.slice(0, 420)}…` : text,
  };
}
