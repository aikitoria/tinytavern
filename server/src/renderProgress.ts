import type { Ctx } from './router.ts';
import { HttpError } from './router.ts';

/** Job-scoped SSE listeners shared by avatar and gallery renders. Random job
 * ids are capability-like: progress reaches only the client that opened the
 * matching stream instead of being broadcast to every connected browser. */
const listenersByJob = new Map<string, Set<Ctx['res']>>();

export function renderJobId(raw: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(raw)) throw new HttpError(400, 'invalid render job id');
  return raw;
}

function publish(jobId: string, event: Record<string, unknown>): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of listenersByJob.get(jobId) ?? []) {
    if (!res.destroyed && !res.writableEnded) res.write(payload);
  }
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
  for (const res of listeners) {
    if (!res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  }
}

export async function streamRenderProgress(ctx: Ctx): Promise<void> {
  const jobId = renderJobId(ctx.params.id ?? '');
  let listeners = listenersByJob.get(jobId);
  if (!listeners) {
    listeners = new Set();
    listenersByJob.set(jobId, listeners);
  }
  listeners.add(ctx.res);
  ctx.res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // Send headers immediately so the client can register before submitting the
  // render without racing the first sampler event.
  ctx.res.write(': ready\n\n');
  await new Promise<void>((resolve) => {
    ctx.res.once('close', resolve);
  });
  listeners.delete(ctx.res);
  if (listeners.size === 0 && listenersByJob.get(jobId) === listeners) {
    listenersByJob.delete(jobId);
  }
  if (!ctx.res.writableEnded) ctx.res.end();
}
