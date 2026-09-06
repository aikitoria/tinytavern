/** Data-line SSE reader: synchronous callbacks avoid a promise per token.
 * Returning false cancels the stream. */
export async function readSseData(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void | boolean,
  onChunk?: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  const processLine = (line: string) => {
    line = line.trimStart();
    return !line.startsWith('data:') || onData(line.slice(5).trim()) !== false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        buffer += decoder.decode();
      } else {
        onChunk?.();
        buffer += decoder.decode(value, { stream: true });
      }
      let start = 0;
      let end: number;
      while ((end = buffer.indexOf('\n', start)) !== -1) {
        if (!processLine(buffer.slice(start, end))) return;
        start = end + 1;
      }
      buffer = buffer.slice(start);
      if (done) {
        if (buffer) processLine(buffer);
        return;
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
