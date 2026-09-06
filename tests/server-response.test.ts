import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { streamResponse } from '../server/src/routes/streamResponse.ts';

function response(destroyed = false) {
  return Object.assign(new EventEmitter(), {
    destroyed,
    writableEnded: false,
    frames: [] as unknown[],
    writeHead(status: number, headers: Record<string, string>) {
      assert.equal(status, 200);
      assert.equal(headers['content-type'], 'text/event-stream');
    },
    write(frame: string) {
      this.frames.push(JSON.parse(frame.slice(6)));
    },
    end() {
      this.writableEnded = true;
    },
  });
}

const success = response();
await streamResponse(success as unknown as ServerResponse, async (send) => {
  send({ d: 'immediate' });
  assert.deepEqual(success.frames, [{ d: 'immediate' }], 'token callbacks write synchronously');
  await Promise.resolve();
  send({ d: 'flushed suffix' });
});
assert.deepEqual(success.frames, [{ d: 'immediate' }, { d: 'flushed suffix' }, { done: true }]);
assert.equal(success.listenerCount('close'), 0);
assert.ok(success.writableEnded);

const stale = response();
await streamResponse(stale as unknown as ServerResponse, async (send) => {
  send({ d: 'discard this draft' });
  throw new Error('conversation branch changed');
});
assert.deepEqual(
  stale.frames,
  [{ d: 'discard this draft' }, { error: 'conversation branch changed' }],
  'failed final validation never emits done',
);
assert.equal(stale.listenerCount('close'), 0);

for (const alreadyClosed of [false, true]) {
  const closed = response(alreadyClosed);
  await streamResponse(closed as unknown as ServerResponse, async (send, signal) => {
    if (!alreadyClosed) closed.emit('close');
    assert.ok(signal.aborted);
    send({ d: 'late output' });
    throw new Error('aborted');
  });
  assert.deepEqual(closed.frames, [], 'closed response suppresses output, done and errors');
  assert.equal(closed.listenerCount('close'), 0);
}
console.log(
  'HTTP SSE response: immediate delivery, finalization ordering, errors, aborts and cleanup passed.',
);
