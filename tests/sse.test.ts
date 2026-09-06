import assert from 'node:assert/strict';
import { readSseData } from '../shared/src/sse.ts';

const encoder = new TextEncoder();
function stream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

// Split at every byte boundary, including within UTF-8 code points and CRLF.
// Ignore comments/metadata and retain an unterminated final data line.
const bytes = encoder.encode(
  ': keepalive\r\nevent: token\r\ndata: hé🦊\r\n\r\ndata:\n  data: tail',
);
for (let boundary = 0; boundary <= bytes.length; boundary++) {
  const body = stream([bytes.subarray(0, boundary), bytes.subarray(boundary)]);
  const seen: string[] = [];
  let chunks = 0;
  await readSseData(
    body,
    (data) => {
      seen.push(data);
    },
    () => {
      chunks++;
    },
  );
  assert.deepEqual(seen, ['hé🦊', '', 'tail']);
  assert.equal(chunks, 2);
  assert.equal(body.locked, false);
}

// EOF must flush decoder state even when a truncated code point remains.
const incomplete = stream([new Uint8Array([...encoder.encode('data: '), 0xc3])]);
const flushed: string[] = [];
await readSseData(incomplete, (data) => {
  flushed.push(data);
});
assert.deepEqual(flushed, ['�']);

// Every frame in a chunk reaches its callback before the next read/promise turn.
const seen: string[] = [];
await readSseData(stream([encoder.encode('data: first\ndata: second\n')]), (data) => {
  seen.push(data);
  if (data === 'first') queueMicrotask(() => assert.deepEqual(seen, ['first', 'second']));
});

for (const stop of ['return', 'throw'] as const) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: first\ndata: second\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const seen: string[] = [];
  const failure = new Error('callback failed');
  const reading = readSseData(body, (data) => {
    seen.push(data);
    if (stop === 'throw') throw failure;
    return false;
  });
  if (stop === 'throw') await assert.rejects(reading, (error) => error === failure);
  else await reading;
  assert.deepEqual(seen, ['first']);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
}

// Upstream read failures survive cleanup and release the body lock.
const failure = new Error('connection lost');
const broken = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.error(failure);
  },
});
await assert.rejects(
  readSseData(broken, () => {}),
  (error) => error === failure,
);
assert.equal(broken.locked, false);

console.log('SSE stream regressions passed');
