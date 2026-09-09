const encoder = new TextEncoder();

export function mockFetch(
  handler: (...args: Parameters<typeof fetch>) => Response | Promise<Response>,
): void {
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) =>
    handler(...args)) as typeof fetch;
}

export function upstreamFrame(delta: object, finishReason?: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`;
}

/** Explicit writes preserve network boundaries and let tests drive races without timers. */
export function controlledStream(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    body,
    get cancelled() {
      return cancelled;
    },
    write: (chunk: string | Uint8Array) =>
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk),
    close: () => controller.close(),
    error: (error: unknown) => controller.error(error),
  };
}

export function streamBody(chunks: Iterable<string | Uint8Array>): ReadableStream<Uint8Array> {
  const stream = controlledStream();
  for (const chunk of chunks) stream.write(chunk);
  stream.close();
  return stream.body;
}

export function byteResponse(text: string): Response {
  // Split every UTF-8 sequence and line delimiter at network boundaries.
  return new Response(streamBody(Array.from(encoder.encode(text), (byte) => Uint8Array.of(byte))));
}
