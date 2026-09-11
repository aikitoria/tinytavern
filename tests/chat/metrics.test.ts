import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { generationTokensPerSecond, type CompletionUsage } from '@tinytavern/shared';
import { CompletionMetrics } from '../../server/src/generation/completionMetrics.ts';
import { completionDataReader } from '../../server/src/generation/completionStream.ts';

test('Mina terminal usage is independent of choices and replaces cumulative counts', () => {
  const usage: CompletionUsage = {};
  const deltas: string[] = [];
  const finished: (string | null)[] = [];
  const read = completionDataReader(
    (content, reasoning) => {
      if (content || reasoning) deltas.push(content || reasoning);
    },
    (reason) => finished.push(reason),
    (value) => Object.assign(usage, value),
  );
  for (const frame of [
    { choices: [{ delta: { role: 'assistant', content: '' } }], usage: null },
    { choices: [{ delta: { reasoning_content: 'Think' } }], usage: null },
    { choices: [{ delta: { content: 'Answer' } }], usage: null },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: null },
    {
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 11,
        prompt_tokens_details: { cached_tokens: 80 },
        completion_tokens_details: { reasoning_tokens: 6, text_tokens: 5 },
      },
    },
  ])
    read(JSON.stringify(frame));
  read('data is malformed');
  read('null');
  read(JSON.stringify({ choices: [], usage: { completion_tokens: 11 } }));
  read('[DONE]');
  assert.deepEqual(deltas, ['Think', 'Answer']);
  assert.deepEqual(finished, ['stop', null]);
  assert.deepEqual(usage, {
    promptTokens: 100,
    completionTokens: 11,
    cachedTokens: 80,
    reasoningTokens: 6,
    textTokens: 5,
  });
  read(
    JSON.stringify({
      usage: {
        prompt_tokens: -1,
        completion_tokens: '20',
        prompt_tokens_details: { cached_tokens: 1.5 },
        completion_tokens_details: { reasoning_tokens: null },
      },
    }),
  );
  assert.equal(usage.completionTokens, 11);
  assert.equal(usage.promptTokens, 100);
  assert.equal(usage.cachedTokens, 80);
  assert.throws(
    () => read(JSON.stringify({ error: { message: 'KV cache ran out of pages' } })),
    /KV cache ran out of pages/,
  );
});

test('generation rate uses first-to-last output arrivals and excludes setup and terminal frames', () => {
  let now = 1000;
  const metrics = new CompletionMetrics(() => now);
  now = 1500;
  assert.equal(metrics.output('', '', ''), false, 'Role and heartbeat frames are not output');
  now = 2000;
  metrics.output('', 'Thinking', '');
  now = 3000;
  metrics.output('Assistant:', '', '', '');
  now = 4000;
  metrics.output('Answer', '', '');
  now = 5000;
  metrics.output(' end', '', '');
  now = 9000;
  metrics.data.completionTokens = 31;
  metrics.finish('done');
  assert.deepEqual(metrics.data, {
    firstTokenMs: 1000,
    lastTokenMs: 4000,
    firstReasoningMs: 1000,
    firstContentMs: 3000,
    completionTokens: 31,
    elapsedMs: 8000,
    status: 'done',
  });
  assert.equal(generationTokensPerSecond(metrics.data), 10);
  now = 10000;
  metrics.output('late', '', '');
  metrics.finish('error');
  assert.equal(metrics.data.elapsedMs, 8000);
  assert.equal(metrics.data.status, 'done');
  assert.equal(generationTokensPerSecond(metrics.data), 10);
  for (const value of [
    {},
    { firstTokenMs: 1, lastTokenMs: 5 },
    { completionTokens: 1, firstTokenMs: 1, lastTokenMs: 5 },
    { completionTokens: 100, firstTokenMs: 1, lastTokenMs: 1 },
  ])
    assert.equal(generationTokensPerSecond(value), undefined);
});
