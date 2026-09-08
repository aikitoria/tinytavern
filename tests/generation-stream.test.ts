import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import type { BuiltPrompt } from '../server/src/prompt.ts';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { stmt, toConversation } = await import('../server/src/db.ts');
const { startGeneration, stopAllGenerations, mergeLiveBuffers } =
  await import('../server/src/generation.ts');
const { getMessage } = await import('../server/src/tree.ts');
const { getSettings, putSettings } = await import('../server/src/settingsStore.ts');
const endpointId = Number(
  stmt(
    "INSERT INTO endpoints (name, base_url, created_at) VALUES ('Test', 'http://test.invalid', 1)",
  ).run().lastInsertRowid,
);
putSettings({ ...getSettings(), activeEndpointId: endpointId });
const conversation = toConversation(
  stmt(
    "INSERT INTO conversations (title, created_at, updated_at) VALUES ('Stream', 1, 1) RETURNING *",
  ).get()!,
);
const prompt: BuiltPrompt = {
  messages: [{ role: 'user', content: 'Hello' }],
  reasoningPrefill: null,
  messagePrefill: null,
  namePrefill: 'Hal:',
  disabledPrefillSpeakerNote: null,
  charName: 'Hal',
  userName: 'User',
};
const requests: {
  signal: AbortSignal;
  stream: ReadableStreamDefaultController<Uint8Array>;
  messages: { role: string; content: string }[];
}[] = [];
const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();
const frame = (delta: object) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
function message() {
  return Number(
    stmt(
      "INSERT INTO messages (conversation_id, role, content, status, created_at) VALUES (?, 'assistant', '', 'streaming', 1)",
    ).run(conversation.id).lastInsertRowid,
  );
}
globalThis.fetch = async (_, init) => {
  const signal = init!.signal!;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(stream) {
        requests.push({ signal, stream, messages: JSON.parse(String(init!.body)).messages });
        signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
      },
    }),
  );
};
mock.timers.enable({ apis: ['setTimeout', 'Date'] });
const timers = mock.method(globalThis, 'setTimeout');
try {
  const mid = message();
  startGeneration(conversation, mid, undefined, { prompt });
  await flush();
  const active = requests.at(-1)!;
  const timerCount = timers.mock.callCount();
  for (let index = 0; index < 32; index++) {
    active.stream.enqueue(encoder.encode(': heartbeat\n\n'));
    await flush();
  }
  assert.equal(timers.mock.callCount(), timerCount, 'Network chunks do not allocate idle timers');
  active.stream.enqueue(encoder.encode('data: null\ndata: malformed\n'));
  active.stream.enqueue(encoder.encode(frame({ content: 42, reasoning_content: {} })));
  for (const content of [' H', 'a', 'l', ':', ' Hello']) {
    active.stream.enqueue(encoder.encode(frame({ content })));
    await flush();
  }
  assert.equal(mergeLiveBuffers([getMessage(mid)!])[0]!.content, ' Hello');
  for (let index = 0; index < 4; index++) {
    mock.timers.tick(90_000);
    assert(!active.signal.aborted, 'An active chat stream survives beyond two minutes');
    // Heartbeats count as activity even when they carry no model tokens.
    active.stream.enqueue(encoder.encode(': heartbeat\n\n'));
    await flush();
  }
  active.stream.enqueue(encoder.encode(frame({ reasoning: 'Thought' })));
  active.stream.close();
  await flush();
  assert.equal(getMessage(mid)!.status, 'done');
  assert.equal(getMessage(mid)!.content, 'Hello');
  assert.equal(getMessage(mid)!.reasoning, 'Thought');
  mock.timers.tick(120_000);
  assert(!active.signal.aborted, 'Finalization clears the idle watchdog');

  const retryId = message();
  startGeneration(conversation, retryId, undefined, { prompt });
  await flush();
  const stalled = requests.at(-1)!;
  mock.timers.tick(90_000);
  stalled.stream.enqueue(encoder.encode(frame({ content: 'Ha' })));
  await flush();
  mock.timers.tick(119_999);
  assert(!stalled.signal.aborted, 'Content renews the full inactivity window');
  mock.timers.tick(1);
  await flush();
  assert(stalled.signal.aborted);
  assert.equal(getMessage(retryId)!.status, 'streaming', 'Foreground idle failures are retried');
  assert.equal(mergeLiveBuffers([getMessage(retryId)!])[0]!.content, 'Ha');
  mock.timers.tick(1000);
  await flush();
  const retry = requests.at(-1)!;
  assert.notEqual(retry, stalled);
  assert.deepEqual(retry.messages.at(-1), { role: 'assistant', content: 'Hal: Ha' });
  retry.stream.enqueue(encoder.encode(frame({ content: 'ppy' })));
  retry.stream.close();
  await flush();
  assert.equal(getMessage(retryId)!.status, 'done');
  assert.equal(getMessage(retryId)!.content, 'Happy', 'Held prefix survives the idle retry once');

  // A request that stalls before returning response headers has the same deadline.
  let waitingSignal!: AbortSignal;
  globalThis.fetch = (_, init) =>
    new Promise((_, reject) => {
      waitingSignal = init!.signal!;
      waitingSignal.addEventListener('abort', () => reject(waitingSignal.reason), { once: true });
    });
  const waitingId = message();
  startGeneration(conversation, waitingId, undefined, { prompt, background: true });
  mock.timers.tick(120_000);
  await flush();
  assert(waitingSignal.aborted);
  assert.equal(getMessage(waitingId)!.status, 'error');
  assert.match(getMessage(waitingId)!.genMeta?.error ?? '', /Upstream idle timeout/);
  console.log('Chat stream decoding, prefix holdback, activity watchdog and idle retry passed');
} finally {
  stopAllGenerations();
  timers.mock.restore();
  mock.timers.reset();
  globalThis.fetch = originalFetch;
}
