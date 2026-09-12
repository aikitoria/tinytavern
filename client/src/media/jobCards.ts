import { mediaJobActive, type MediaAsset, type MediaJob } from '@tinytavern/shared';

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

export interface MediaJobGroup {
  id: number;
  job: MediaJob;
  jobs: MediaJob[];
  createdAt: number;
}

export interface MediaJobResult {
  job: MediaJob;
  asset: MediaAsset;
}

export interface MediaVariation {
  job: MediaJob;
  asset?: MediaAsset;
}

export function compareMediaJobs(a: MediaJob, b: MediaJob): number {
  return a.createdAt - b.createdAt || a.id - b.id;
}

/** Input is chronological. A pending attempt keeps its position when its finished outputs arrive. */
export function mediaVariations(jobs: readonly MediaJob[]): MediaVariation[] {
  return jobs
    .filter((job) => job.state !== 'cancelled')
    .flatMap((job) =>
      job.state === 'succeeded' && job.outputs.length ? job.outputs.map((asset) => ({ job, asset })) : [{ job }],
    );
}

export function mediaVariationIndex(
  variations: readonly MediaVariation[],
  viewed: { jobId: number; assetId?: number } | null,
  selectedAssetId: number | null | undefined,
) {
  const index = viewed
    ? variations.findIndex(
        (item) => item.job.id === viewed.jobId && (!viewed.assetId || item.asset?.id === viewed.assetId),
      )
    : selectedAssetId == null
      ? -1
      : variations.findIndex((item) => item.asset?.id === selectedAssetId);
  return index < 0 ? variations.length - 1 : index;
}

/** Input is chronological. Finished outputs and running attempts keep their independent preview positions. */
export function mediaJobPreviews(jobs: readonly MediaJob[]) {
  const results: MediaJobResult[] = [];
  const pending: MediaJob[] = [];
  for (const job of jobs) {
    if (job.state === 'succeeded') {
      for (const asset of job.outputs) results.push({ job, asset });
    } else if (mediaJobActive(job.state)) {
      pending.push(job);
    }
  }
  return { results, pending };
}

function jobPriority(job: MediaJob): number {
  if (mediaJobActive(job.state)) {
    return 2;
  }
  return job.state === 'cancelled' ? 0 : 1;
}

/** Keep running attempts prominent and cancelled-only prompt discussions reachable. */
export function groupMediaJobs(jobs: MediaJob[]): MediaJobGroup[] {
  const groups = new Map<number, MediaJobGroup>();
  for (const job of jobs) {
    if (job.temporary || (job.draft && job.state === 'cancelled' && job.draft.conversationId == null)) continue;
    const id = job.draft ? -job.draft.id : job.id;
    const group = groups.get(id);
    if (!group) {
      groups.set(id, { id, job, jobs: [job], createdAt: job.createdAt });
      continue;
    }
    group.jobs.push(job);
    group.createdAt = Math.max(group.createdAt, job.createdAt);
    const priority = jobPriority(job);
    const previousPriority = jobPriority(group.job);
    if (
      priority > previousPriority ||
      (priority === previousPriority &&
        (job.createdAt > group.job.createdAt || (job.createdAt === group.job.createdAt && job.id > group.job.id)))
    )
      group.job = job;
  }
  for (const group of groups.values()) group.jobs.sort(compareMediaJobs);
  return [...groups.values()].sort((a, b) => b.createdAt - a.createdAt || a.id - b.id);
}

/** Keep full text for scrolling and preserve the prefix while tokens stream. */
export function jobPromptExcerpt(job: Pick<MediaJob, 'state' | 'prompt' | 'reasoning' | 'instruction' | 'textResult'>) {
  if (job.state === 'preparing') {
    const text = job.prompt || job.reasoning || '';
    return {
      label: job.prompt ? 'Writing prompt…' : 'Thinking…',
      text,
    };
  }
  const text = job.textResult || job.prompt || job.instruction;
  return {
    label: job.textResult ? 'Result' : job.prompt ? 'Prompt' : 'Instruction',
    text,
  };
}
