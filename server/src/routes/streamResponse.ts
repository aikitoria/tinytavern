import type { ServerResponse } from 'node:http';

/** Own HTTP streaming only; callers finish validation and flushing before returning. */
export async function streamResponse(
  res: ServerResponse,
  run: (send: (data: unknown) => void, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const abort = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) abort.abort();
  };
  const send = (data: unknown) => {
    if (!abort.signal.aborted) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  res.on('close', onClose);
  if (res.destroyed) abort.abort();
  try {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    try {
      await run(send, abort.signal);
      send({ done: true });
    } catch (err) {
      send({ error: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    res.off('close', onClose);
    res.end();
  }
}
