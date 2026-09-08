import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import type { Endpoint } from '@tinytavern/shared';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { streamEndpointCompletion } = await import('../server/src/generation.ts');
const { streamTextCompletion } = await import('../client/src/state/api.ts');
const endpoint: Endpoint = {
  id: 1,
  name: 'Test',
  baseUrl: 'http://endpoint.invalid/v1',
  apiKey: '',
  hasApiKey: false,
  models: [],
  model: null,
  createdAt: 0,
  prefillMode: 'vllm',
  genParams: {},
};
const originalFetch = globalThis.fetch;
function upstream(delta: object, finishReason?: string) {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`;
}
try {
  for (const field of ['reasoning_content', 'reasoning']) {
    globalThis.fetch = async () =>
      new Response(
        [
          upstream({ [field]: 'Check the lighting. ' }),
          upstream({ [field]: 'Choose the camera angle.' }),
          upstream({ content: 'A bright scene', [field]: 'Do not append this to the preview' }),
          upstream({ [field]: 'Late reasoning is not displayed' }),
          upstream({}, 'stop'),
          'data: [DONE]\n\n',
        ].join(''),
      );
    const events: object[] = [];
    const prompt = await streamEndpointCompletion(
      endpoint,
      [{ role: 'user', content: 'Generate a prompt' }],
      1024,
      (d) => events.push({ d }),
      undefined,
      {
        messagePrefill: 'Photo: ',
        reasoningPrefill: 'Think carefully',
        onReasoning: (r) => events.push({ r }),
        requireComplete: true,
      },
    );
    assert.equal(prompt, 'Photo: A bright scene');
    assert.deepEqual(events, [
      { r: 'Think carefully' },
      { r: 'Check the lighting. ' },
      { r: 'Choose the camera angle.' },
      { d: 'Photo: ' },
      { d: 'A bright scene' },
    ]);
    globalThis.fetch = async () =>
      new Response(
        [...events, { done: true }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      );
    let displayedReasoning = '';
    let visiblePrompt = '';
    const output = await streamTextCompletion(
      '/prompt',
      {},
      (_, text) => {
        displayedReasoning = '';
        visiblePrompt = text;
      },
      'test prompt',
      undefined,
      (delta) => {
        assert.equal(visiblePrompt, '', 'Reasoning arrives before editable prompt text');
        displayedReasoning += delta;
      },
    );
    assert.equal(output, prompt);
    assert.equal(visiblePrompt, prompt);
    assert.equal(displayedReasoning, '');
  }
  globalThis.fetch = async () =>
    new Response(upstream({ reasoning_content: 'No final prompt' }) + 'data: [DONE]\n\n');
  let onlyReasoning = '';
  await assert.rejects(
    streamEndpointCompletion(
      endpoint,
      [],
      1024,
      () => assert.fail('Reasoning must not become prompt text'),
      undefined,
      { onReasoning: (delta) => (onlyReasoning += delta) },
    ),
    /only reasoning/,
  );
  assert.equal(onlyReasoning, 'No final prompt');
  globalThis.fetch = async () => new Response('data: {"r":"Still thinking"}\n\n');
  await assert.rejects(
    streamTextCompletion('/prompt', {}, () => assert.fail('No content arrived'), 'test prompt'),
    /ended before completion/,
  );
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let requestSignal!: AbortSignal;
    globalThis.fetch = async (_, options) => {
      requestSignal = options!.signal!;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            controller = stream;
            requestSignal.addEventListener('abort', () => stream.error(requestSignal.reason), {
              once: true,
            });
          },
        }),
      );
    };
    let thinking = '';
    const running = streamEndpointCompletion(endpoint, [], 1024, () => {}, undefined, {
      onReasoning: (delta) => {
        thinking += delta;
      },
      requireComplete: true,
    });
    await flush();
    for (let step = 0; step < 4; step++) {
      mock.timers.tick(90_000);
      assert(!requestSignal.aborted, 'An active reasoning stream survives beyond two minutes');
      controller.enqueue(new TextEncoder().encode(upstream({ reasoning_content: 'Thinking. ' })));
      await flush();
    }
    assert.equal(thinking, 'Thinking. '.repeat(4));
    controller.enqueue(
      new TextEncoder().encode(
        upstream({ content: 'Finished prompt' }, 'stop') + 'data: [DONE]\n\n',
      ),
    );
    controller.close();
    assert.equal(await running, 'Finished prompt');
    mock.timers.tick(120_000);
    assert(!requestSignal.aborted, 'Completion clears the idle watchdog');

    const stalled = streamEndpointCompletion(endpoint, [], 1024, () => {});
    const stalledResult = assert.rejects(stalled, /Upstream idle timeout/);
    await flush();
    mock.timers.tick(90_000);
    controller.enqueue(new TextEncoder().encode(upstream({ reasoning: 'Still here' })));
    await flush();
    mock.timers.tick(119_999);
    assert(!requestSignal.aborted, 'Reasoning renews the full inactivity window');
    mock.timers.tick(1);
    await stalledResult;

    globalThis.fetch = (_, options) =>
      new Promise((_, reject) => {
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), {
          once: true,
        });
      });
    const waiting = streamEndpointCompletion(endpoint, [], 1024, () => {});
    const waitingResult = assert.rejects(waiting, /Upstream idle timeout/);
    mock.timers.tick(120_000);
    await waitingResult;
  } finally {
    mock.timers.reset();
  }
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  'Prompt reasoning streams separately, supports both endpoint fields, clears at content, and never becomes a saved prompt',
);
