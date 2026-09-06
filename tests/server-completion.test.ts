import assert from 'node:assert/strict';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { stmt } = await import('../server/src/db.ts');
const { chatCompletionOnce, streamChatCompletion } = await import('../server/src/generation.ts');
const { getSettings, putSettings } = await import('../server/src/settingsStore.ts');
const endpointId = Number(
  stmt(
    'INSERT INTO endpoints (name, base_url, api_key, model, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('test', 'https://upstream.invalid/v1///', 'secret', 'test-model', Date.now())
    .lastInsertRowid,
);
putSettings({ ...getSettings(), activeEndpointId: endpointId });

const originalFetch = globalThis.fetch;
let reply = () => new Response();
let wire: Record<string, unknown> = {};
globalThis.fetch = async (url, init) => {
  assert.equal(url, 'https://upstream.invalid/v1/chat/completions');
  assert.equal(init?.method, 'POST');
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret');
  assert(init?.signal);
  wire = JSON.parse(String(init?.body));
  return reply();
};
const messages = [{ role: 'user' as const, content: 'hello' }];
const frame = (delta: Record<string, unknown>) =>
  `data: ${JSON.stringify({ choices: [{ delta }] })}\n`;
try {
  reply = () => Response.json({ choices: [{ message: { content: 'one shot' } }] });
  assert.equal(await chatCompletionOnce(null, messages, 23), 'one shot');
  assert.deepEqual(wire, { model: 'test-model', messages, stream: false, max_tokens: 23 });

  // Unterminated final frames survive parsing; malformed frames are ignored.
  reply = () =>
    new Response(
      `data: null\ndata: malformed\n${frame({ content: 'hé' })}${frame({ content: '🦊' }).trimEnd()}`,
    );
  const deltas: string[] = [];
  assert.equal(await streamChatCompletion(null, messages, 71, (text) => deltas.push(text)), 'hé🦊');
  assert.deepEqual(deltas, ['hé', '🦊']);
  assert.deepEqual(wire, { model: 'test-model', messages, stream: true, max_tokens: 71 });

  for (const [delta, diagnosis] of [
    [{ refusal: 'no thanks' }, /The model refused: no thanks/],
    [{ reasoning_content: 'thinking' }, /only reasoning/],
    [{}, /empty reply/],
  ] as const) {
    reply = () => new Response(frame(delta));
    await assert.rejects(
      streamChatCompletion(null, messages, 71, () => {}),
      diagnosis,
    );
  }
  reply = () => new Response('busy', { status: 429 });
  await assert.rejects(
    streamChatCompletion(null, messages, 71, () => {}),
    /Upstream error 429: busy/,
  );

  let cancelled = false;
  reply = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frame({ content: 'first' })));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  const failure = new Error('consumer failure');
  await assert.rejects(
    streamChatCompletion(null, messages, 71, () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(cancelled, true);
} finally {
  globalThis.fetch = originalFetch;
}
console.log('Server completion transport regressions passed');
