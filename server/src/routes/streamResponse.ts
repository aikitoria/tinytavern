const encoder = new TextEncoder();

/** Own the HTTP stream; validation runs before creation and completion releases caller guards. */
export function streamResponse(
  req: Request,
  run: (send: (data: unknown) => void, signal: AbortSignal) => Promise<void>,
  onFinish?: () => void,
): Response {
  const abort = new AbortController();
  const onAbort = () => abort.abort(req.signal.reason);
  req.signal.addEventListener('abort', onAbort, { once: true });
  if (req.signal.aborted) onAbort();
  let closed = false;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const send = (data: unknown) => {
          if (closed || abort.signal.aborted) return;
          // Bound slow-consumer memory without delaying other requests or token callbacks.
          if ((controller.desiredSize ?? 0) <= 0) {
            closed = true;
            const error = new Error('stream consumer is too slow');
            abort.abort(error);
            controller.error(error);
            return;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };
        controller.enqueue(encoder.encode(': ready\n\n'));
        void (async () => {
          try {
            await run(send, abort.signal);
            send({ done: true });
          } catch (err) {
            send({ error: err instanceof Error ? err.message : String(err) });
          } finally {
            req.signal.removeEventListener('abort', onAbort);
            if (!closed) {
              closed = true;
              controller.close();
            }
            onFinish?.();
          }
        })();
      },
      cancel(reason) {
        closed = true;
        abort.abort(reason);
      },
    },
    { highWaterMark: 1024 * 1024, size: (bytes) => bytes?.byteLength ?? 0 },
  );
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'private, no-store',
    },
  });
}
