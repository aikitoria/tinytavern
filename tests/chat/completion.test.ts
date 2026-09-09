import { insertFixture, conversationFixture, messageFixture } from '../support/fixtures.ts';
import { mockFetch, controlledStream, upstreamFrame } from '../support/streams.ts';
import assert from 'node:assert/strict';
import { databaseCase } from '../support/database.ts';

databaseCase('server completion', async () => {
  const { stmt } = await import('../../server/src/db/db.ts');
  const { chatCompletionOnce, streamChatCompletion } =
    await import('../../server/src/generation/generation.ts');
  const { getSettings, putSettings } = await import('../../server/src/settings/settingsStore.ts');
  const endpointId = insertFixture('endpoints', {
    name: 'test',
    base_url: 'https://upstream.invalid/v1///',
    api_key: 'secret',
    model: 'test-model',
    created_at: 1,
  });
  putSettings({ ...getSettings(), activeEndpointId: endpointId });

  const originalFetch = globalThis.fetch;
  let reply = () => new Response();
  let wire: Record<string, unknown> = {};
  mockFetch((url, init) => {
    assert.equal(url, 'https://upstream.invalid/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret');
    assert(init?.signal);
    wire = JSON.parse(String(init?.body));
    return reply();
  });
  const messages = [{ role: 'user' as const, content: 'hello' }];
  try {
    reply = () => Response.json({ choices: [{ message: { content: 'one shot' } }] });
    assert.equal(await chatCompletionOnce(null, messages, 23), 'one shot');
    assert.deepEqual(wire, { model: 'test-model', messages, stream: false, max_tokens: 23 });

    // Unterminated final frames survive parsing; malformed frames are ignored.
    reply = () =>
      new Response(
        `data: null\ndata: malformed\n${upstreamFrame({ content: 'hé' })}${upstreamFrame({ content: '🦊' }).trimEnd()}`,
      );
    const deltas: string[] = [];
    assert.equal(
      await streamChatCompletion(null, messages, 71, (text) => deltas.push(text)),
      'hé🦊',
    );
    assert.deepEqual(deltas, ['hé', '🦊']);
    assert.deepEqual(wire, { model: 'test-model', messages, stream: true, max_tokens: 71 });

    for (const [finish, error] of [
      ['', /ended before a complete reply/],
      ['data: [DONE]\n\n', null],
      ['data: {"choices":[{"finish_reason":"stop"}]}\n\n', null],
      ['data: {"choices":[{"finish_reason":"length"}]}\n\n', /truncated by the token limit/],
      [
        'data: {"choices":[{"finish_reason":"content_filter"}]}\n\n',
        /ended before a complete reply/,
      ],
    ] as const) {
      reply = () => new Response(upstreamFrame({ content: 'Prompt' }) + finish);
      const complete = streamChatCompletion(null, messages, 71, () => {}, undefined, {
        requireComplete: true,
      });
      if (error) await assert.rejects(complete, error);
      else assert.equal(await complete, 'Prompt');
    }
    reply = () => new Response(upstreamFrame({ content: 'hé' }) + upstreamFrame({ content: '🦊' }));

    stmt("UPDATE endpoints SET prefill_mode = 'vllm', gen_params_json = ? WHERE id = ?").run(
      JSON.stringify({ temperature: 0, maxTokens: 99, reasoningEffort: 'high' }),
      endpointId,
    );
    const seeded: string[] = [];
    const options = {
      useEndpointParameters: true,
      reasoningPrefill: 'Think',
      messagePrefill: 'Seed: ',
    };
    assert.equal(
      await streamChatCompletion(
        null,
        messages,
        71,
        (text) => seeded.push(text),
        undefined,
        options,
      ),
      'Seed: hé🦊',
    );
    assert.deepEqual(seeded, ['Seed: ', 'hé', '🦊']);
    assert.deepEqual(wire, {
      model: 'test-model',
      stream: true,
      temperature: 0,
      max_tokens: 99,
      reasoning_effort: 'high',
      continue_final_message: true,
      add_generation_prompt: false,
      messages: [...messages, { role: 'assistant', content: 'Seed: ', reasoning_content: 'Think' }],
    });

    stmt(`UPDATE endpoints SET system_prompt_prefix = ?, system_prompt_suffix = ?,
      reasoning_prefill_prefix = ? WHERE id = ?`).run(
      'Prefix\n',
      '\nSuffix',
      'Global\n',
      endpointId,
    );
    reply = () => Response.json({ choices: [{ message: { content: 'one shot' } }] });
    assert.equal(await chatCompletionOnce(null, messages, 23), 'one shot');
    assert.deepEqual(wire.messages, [
      { role: 'system', content: 'Prefix\n\nSuffix' },
      ...messages,
      { role: 'assistant', content: '', reasoning_content: 'Global\n' },
    ]);
    const withSystem = [{ role: 'system' as const, content: 'Task system' }, ...messages];
    reply = () => new Response(upstreamFrame({ content: 'Prompt' }));
    assert.equal(
      await streamChatCompletion(null, withSystem, 71, () => {}, undefined, options),
      'Seed: Prompt',
    );
    assert.deepEqual(wire.messages, [
      { role: 'system', content: 'Prefix\nTask system\nSuffix' },
      ...messages,
      { role: 'assistant', content: 'Seed: ', reasoning_content: 'Global\nThink' },
    ]);
    assert.equal(withSystem[0]!.content, 'Task system');

    for (const [delta, diagnosis] of [
      [{ refusal: 'no thanks' }, /The model refused: no thanks/],
      [{ reasoning_content: 'thinking' }, /only reasoning/],
      [{}, /empty reply/],
    ] as const) {
      reply = () => new Response(upstreamFrame(delta));
      await assert.rejects(
        streamChatCompletion(null, messages, 71, () => {}),
        diagnosis,
      );
      await assert.rejects(
        streamChatCompletion(
          null,
          messages,
          71,
          () => assert.fail('No generated content to emit'),
          undefined,
          options,
        ),
        diagnosis,
      );
    }
    reply = () => new Response('busy', { status: 429 });
    await assert.rejects(
      streamChatCompletion(null, messages, 71, () => {}),
      /Upstream error 429: busy/,
    );

    const consumer = controlledStream();
    consumer.write(upstreamFrame({ content: 'first' }));
    reply = () => new Response(consumer.body);
    const failure = new Error('consumer failure');
    await assert.rejects(
      streamChatCompletion(null, messages, 71, () => {
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(consumer.cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

databaseCase('generation stream', async () => {
  const { jest } = await import('bun:test');

  const { setImmediate: flush } = await import('node:timers/promises');

  type BuiltPrompt = import('../../server/src/generation/prompt.ts').BuiltPrompt;
  const { stmt, toConversation } = await import('../../server/src/db/db.ts');
  const { startGeneration, stopAllGenerations, mergeLiveBuffers } =
    await import('../../server/src/generation/generation.ts');
  const { getMessage } = await import('../../server/src/conversations/tree.ts');
  const { getSettings, putSettings } = await import('../../server/src/settings/settingsStore.ts');
  const endpointId = insertFixture('endpoints', {
    name: 'Test',
    base_url: 'http://test.invalid',
    created_at: 1,
  });
  putSettings({ ...getSettings(), activeEndpointId: endpointId });
  const cid = conversationFixture({ title: 'Stream' });
  const conversation = toConversation(stmt('SELECT * FROM conversations WHERE id = ?').get(cid)!);
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
    stream: ReturnType<typeof controlledStream>;
    messages: { role: string; content: string }[];
  }[] = [];
  const originalFetch = globalThis.fetch;
  const message = () => messageFixture(cid, { content: '', status: 'streaming' });
  mockFetch((_, init) => {
    const signal = init!.signal!;
    const stream = controlledStream(signal);
    requests.push({ signal, stream, messages: JSON.parse(String(init!.body)).messages });
    return new Response(stream.body);
  });
  jest.useFakeTimers();
  const timers = jest.spyOn(globalThis, 'setTimeout');
  try {
    const mid = message();
    startGeneration(conversation, mid, undefined, { prompt });
    await flush();
    const active = requests.at(-1)!;
    const timerCount = timers.mock.calls.length;
    for (let index = 0; index < 32; index++) {
      active.stream.write(': heartbeat\n\n');
      await flush();
    }
    assert.equal(
      timers.mock.calls.length,
      timerCount,
      'Network chunks do not allocate idle timers',
    );
    active.stream.write('data: null\ndata: malformed\n');
    active.stream.write(upstreamFrame({ content: 42, reasoning_content: {} }));
    for (const content of [' H', 'a', 'l', ':', ' Hello']) {
      active.stream.write(upstreamFrame({ content }));
      await flush();
    }
    assert.equal(mergeLiveBuffers([getMessage(mid)!])[0]!.content, ' Hello');
    for (let index = 0; index < 4; index++) {
      jest.advanceTimersByTime(90_000);
      assert(!active.signal.aborted, 'An active chat stream survives beyond two minutes');
      // Heartbeats count as activity even when they carry no model tokens.
      active.stream.write(': heartbeat\n\n');
      await flush();
    }
    active.stream.write(upstreamFrame({ reasoning: 'Thought' }));
    active.stream.close();
    await flush();
    assert.equal(getMessage(mid)!.status, 'done');
    assert.equal(getMessage(mid)!.content, 'Hello');
    assert.equal(getMessage(mid)!.reasoning, 'Thought');
    jest.advanceTimersByTime(120_000);
    assert(!active.signal.aborted, 'Finalization clears the idle watchdog');

    stmt(`UPDATE endpoints SET system_prompt_prefix = ?, system_prompt_suffix = ?,
      reasoning_prefill_prefix = ? WHERE id = ?`).run(
      'Prefix\n',
      '\nSuffix',
      'Global\n',
      endpointId,
    );
    const retryPrompt = { ...prompt, reasoningPrefill: 'Template reasoning' };
    const retryId = message();
    startGeneration(conversation, retryId, undefined, { prompt: retryPrompt });
    await flush();
    const stalled = requests.at(-1)!;
    assert.deepEqual(stalled.messages[0], { role: 'system', content: 'Prefix\n\nSuffix' });
    assert.deepEqual(stalled.messages.at(-1), {
      role: 'assistant',
      content: 'Hal:',
      reasoning_content: 'Global\nTemplate reasoning',
    });
    stmt(
      "UPDATE endpoints SET system_prompt_prefix = 'Changed', reasoning_prefill_prefix = 'Changed' WHERE id = ?",
    ).run(endpointId);
    jest.advanceTimersByTime(90_000);
    stalled.stream.write(upstreamFrame({ content: 'Ha' }));
    await flush();
    jest.advanceTimersByTime(119_999);
    assert(!stalled.signal.aborted, 'Content renews the full inactivity window');
    jest.advanceTimersByTime(1);
    await flush();
    assert(stalled.signal.aborted);
    assert.equal(getMessage(retryId)!.status, 'streaming', 'Foreground idle failures are retried');
    assert.equal(mergeLiveBuffers([getMessage(retryId)!])[0]!.content, 'Ha');
    jest.advanceTimersByTime(1000);
    await flush();
    const retry = requests.at(-1)!;
    assert.notEqual(retry, stalled);
    assert.deepEqual(
      retry.messages[0],
      stalled.messages[0],
      'Retries retain the captured endpoint additions',
    );
    assert.deepEqual(retry.messages.at(-1), {
      role: 'assistant',
      content: 'Hal: Ha',
      reasoning_content: 'Global\nTemplate reasoning',
    });
    retry.stream.write(upstreamFrame({ content: 'ppy' }));
    retry.stream.close();
    await flush();
    assert.equal(getMessage(retryId)!.status, 'done');
    assert.equal(getMessage(retryId)!.content, 'Happy', 'Held prefix survives the idle retry once');
    assert.equal(getMessage(retryId)!.reasoning, 'Global\nTemplate reasoning');
    assert.deepEqual(prompt.messages, [{ role: 'user', content: 'Hello' }]);

    // A request that stalls before returning response headers has the same deadline.
    let waitingSignal!: AbortSignal;
    mockFetch(
      (_, init) =>
        new Promise((_, reject) => {
          waitingSignal = init!.signal!;
          waitingSignal.addEventListener('abort', () => reject(waitingSignal.reason), {
            once: true,
          });
        }),
    );
    const waitingId = message();
    startGeneration(conversation, waitingId, undefined, { prompt, background: true });
    jest.advanceTimersByTime(120_000);
    await flush();
    assert(waitingSignal.aborted);
    assert.equal(getMessage(waitingId)!.status, 'error');
    assert.match(getMessage(waitingId)!.genMeta?.error ?? '', /Upstream idle timeout/);
  } finally {
    stopAllGenerations();
    timers.mockRestore();
    jest.useRealTimers();
    globalThis.fetch = originalFetch;
  }
});

databaseCase('generation persistence', async () => {
  const { setImmediate: flush } = await import('node:timers/promises');

  const { jest } = await import('bun:test');

  type BuiltPrompt = import('../../server/src/generation/prompt.ts').BuiltPrompt;
  const { stmt, toConversation } = await import('../../server/src/db/db.ts');
  const { startGeneration, stopGeneration, stopAllGenerations, mergeLiveBuffers } =
    await import('../../server/src/generation/generation.ts');
  const { getMessage } = await import('../../server/src/conversations/tree.ts');
  const { getSettings, putSettings } = await import('../../server/src/settings/settingsStore.ts');
  const { getConversationRevision } =
    await import('../../server/src/conversations/conversationRevision.ts');
  const endpointId = insertFixture('endpoints', {
    name: 'test',
    base_url: 'https://upstream.invalid/v1',
    model: 'test-model',
    created_at: 1,
  });
  putSettings({ ...getSettings(), activeEndpointId: endpointId });
  const cid = conversationFixture({ title: 'Persistence' });
  const conversation = toConversation(stmt('SELECT * FROM conversations WHERE id = ?').get(cid)!);
  const prompt: BuiltPrompt = {
    messages: [{ role: 'user', content: 'Hello' }],
    reasoningPrefill: null,
    messagePrefill: null,
    namePrefill: null,
    disabledPrefillSpeakerNote: null,
    charName: 'Assistant',
    userName: 'User',
  };
  const streams: ReturnType<typeof controlledStream>[] = [];
  const originalFetch = globalThis.fetch;
  mockFetch(() => {
    const stream = controlledStream();
    streams.push(stream);
    return new Response(stream.body);
  });
  function append(stream: ReturnType<typeof controlledStream>, content: string, reasoning = '') {
    stream.write(upstreamFrame({ content, reasoning_content: reasoning }));
  }
  const message = (role = 'assistant') =>
    messageFixture(cid, { role, content: '', status: 'streaming', image_pending: 1 });
  function begin(mid: number, resume?: { content: string; reasoning: string }) {
    startGeneration(conversation, mid, resume, { prompt, background: true });
    return streams.at(-1)!;
  }
  try {
    const mid = message();
    const stream = begin(mid);
    append(stream, ' First', ' Think');
    jest.useFakeTimers();
    jest.advanceTimersByTime(650); // A reintroduced periodic flush would fire here.
    await flush();
    jest.useRealTimers();
    assert.equal(getMessage(mid)!.content, '');
    assert.equal(getMessage(mid)!.reasoning, null);
    assert.equal(getMessage(mid)!.model, null);
    assert.equal(mergeLiveBuffers([getMessage(mid)!])[0]!.content, ' First');
    const revision = getConversationRevision(cid);
    append(stream, ' reply ', ' more ');
    stream.close();
    await flush();
    assert.equal(getMessage(mid)!.content, 'First reply');
    assert.equal(getMessage(mid)!.reasoning, 'Think more');
    assert.equal(getMessage(mid)!.model, 'test-model');
    assert.equal(getMessage(mid)!.status, 'done');
    assert.equal(getMessage(mid)!.imagePending, true);
    assert.equal(getConversationRevision(cid), revision + 1);

    stmt("UPDATE messages SET status = 'streaming' WHERE id = ?").run(mid);
    const old = begin(mid, { content: 'First reply', reasoning: 'Think more' });
    append(old, ' continued');
    await flush();
    assert.equal(getMessage(mid)!.content, 'First reply');
    stopGeneration(mid);
    assert.equal(getMessage(mid)!.content, 'First reply continued');
    assert.equal(getMessage(mid)!.status, 'stopped');
    assert.equal(getMessage(mid)!.imagePending, false);
    stmt("UPDATE messages SET status = 'streaming' WHERE id = ?").run(mid);
    const next = begin(mid, { content: 'First reply continued', reasoning: 'Think more' });
    append(old, ' stale');
    old.close();
    append(next, ' successor');
    await flush();
    assert.equal(
      mergeLiveBuffers([getMessage(mid)!])[0]!.content,
      'First reply continued successor',
    );
    next.close();
    await flush();
    assert.equal(getMessage(mid)!.content, 'First reply continued successor');

    const failed = message();
    const failingStream = begin(failed);
    append(failingStream, 'Partial', 'Reason');
    await flush();
    failingStream.error(new Error('fatal test failure'));
    await flush();
    assert.equal(getMessage(failed)!.status, 'error');
    assert.equal(getMessage(failed)!.content, 'Partial');
    assert.equal(getMessage(failed)!.reasoning, 'Reason');
    assert.equal(getMessage(failed)!.imagePending, false);

    const deleted = message();
    const deletedStream = begin(deleted);
    append(deletedStream, 'Gone');
    await flush();
    stmt('DELETE FROM messages WHERE id = ?').run(deleted);
    const beforeDeleteFinal = getConversationRevision(cid);
    deletedStream.close();
    await flush();
    assert.equal(getMessage(deleted), undefined);
    assert.equal(getConversationRevision(cid), beforeDeleteFinal);

    const pending = ['assistant', 'tool'].map((role) => {
      const id = message(role);
      const controller = begin(id);
      append(controller, role);
      return { id, controller, role };
    });
    await flush();
    stopAllGenerations();
    for (const { id, controller, role } of pending) {
      assert.equal(getMessage(id)!.content, role);
      assert.equal(getMessage(id)!.status, 'stopped');
      controller.close();
    }
    await flush();
  } finally {
    stopAllGenerations();
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
  }
});

databaseCase('prompt reasoning', async () => {
  type Endpoint = import('@tinytavern/shared').Endpoint;
  const { streamEndpointCompletion } = await import('../../server/src/generation/generation.ts');
  const { streamTextCompletion } = await import('../../client/src/state/api.ts');
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
    systemPromptPrefix: '',
    systemPromptSuffix: '',
    reasoningPrefillPrefix: '',
    genParams: {},
  };
  const originalFetch = globalThis.fetch;
  try {
    for (const field of ['reasoning_content', 'reasoning']) {
      mockFetch(
        () =>
          new Response(
            [
              upstreamFrame({ [field]: 'Check the lighting. ' }),
              upstreamFrame({ [field]: 'Choose the camera angle.' }),
              upstreamFrame({
                content: 'A bright scene',
                [field]: 'Do not append this to the preview',
              }),
              upstreamFrame({ [field]: 'Late reasoning is not displayed' }),
              upstreamFrame({}, 'stop'),
              'data: [DONE]\n\n',
            ].join(''),
          ),
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
      mockFetch(
        () =>
          new Response(
            [...events, { done: true }]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(''),
          ),
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
    mockFetch(
      () =>
        new Response(upstreamFrame({ reasoning_content: 'No final prompt' }) + 'data: [DONE]\n\n'),
    );
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
    mockFetch(() => new Response('data: {"r":"Still thinking"}\n\n'));
    await assert.rejects(
      streamTextCompletion('/prompt', {}, () => assert.fail('No content arrived'), 'test prompt'),
      /ended before completion/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
