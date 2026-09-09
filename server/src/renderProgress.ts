import type { Ctx } from './router.ts';
import { HttpError } from './router.ts';
import { streamResponse } from './routes/streamResponse.ts';

interface Listener {
  send: (event: unknown) => void;
  finish: () => void;
}
/** Random job IDs restrict avatar/gallery progress to matching SSE listeners. */
const listenersByJob = new Map<string, Set<Listener>>();

export function renderJobId(raw: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(raw)) throw new HttpError(400, 'invalid render job id');
  return raw;
}

function publish(jobId: string, event: Record<string, unknown>): void {
  for (const listener of listenersByJob.get(jobId) ?? []) listener.send(event);
}

export function publishRenderProgress(jobId: string, value: number, max: number): void {
  publish(jobId, { value, max });
}

export function publishRenderPreview(jobId: string, preview: string): void {
  publish(jobId, { preview });
}

export function finishRenderProgress(jobId: string): void {
  const listeners = listenersByJob.get(jobId);
  if (!listeners) return;
  listenersByJob.delete(jobId);
  for (const listener of listeners) listener.finish();
}

export function streamRenderProgress(ctx: Ctx): Response {
  const jobId = renderJobId(ctx.params.id ?? '');
  return streamResponse(ctx.req, async (send, signal) => {
    let listeners = listenersByJob.get(jobId);
    if (!listeners) listenersByJob.set(jobId, (listeners = new Set()));
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const listener = { send, finish };
    listeners.add(listener);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
    try {
      await done;
    } finally {
      signal.removeEventListener('abort', finish);
      listeners.delete(listener);
      if (!listeners.size && listenersByJob.get(jobId) === listeners) listenersByJob.delete(jobId);
    }
  });
}
