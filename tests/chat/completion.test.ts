import assert from 'node:assert/strict';
import { databaseCase } from '../support/database.ts';

databaseCase('server completion', async () => {
  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const { stmt } = await import('../../server/src/db.ts');
  const { chatCompletionOnce, streamChatCompletion } =
    await import('../../server/src/generation.ts');
  const { getSettings, putSettings } = await import('../../server/src/settingsStore.ts');
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
  globalThis.fetch = (async (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    assert.equal(url, 'https://upstream.invalid/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret');
    assert(init?.signal);
    wire = JSON.parse(String(init?.body));
    return reply();
  }) as unknown as typeof fetch;
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
      reply = () => new Response(frame({ content: 'Prompt' }) + finish);
      const complete = streamChatCompletion(null, messages, 71, () => {}, undefined, {
        requireComplete: true,
      });
      if (error) await assert.rejects(complete, error);
      else assert.equal(await complete, 'Prompt');
    }
    reply = () => new Response(frame({ content: 'hé' }) + frame({ content: '🦊' }));

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
});

databaseCase('generation stream', async () => {
  const { jest } = await import('bun:test');

  const { setImmediate: flush } = await import('node:timers/promises');

  type BuiltPrompt = import('../../server/src/prompt.ts').BuiltPrompt;
  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const { stmt, toConversation } = await import('../../server/src/db.ts');
  const { startGeneration, stopAllGenerations, mergeLiveBuffers } =
    await import('../../server/src/generation.ts');
  const { getMessage } = await import('../../server/src/tree.ts');
  const { getSettings, putSettings } = await import('../../server/src/settingsStore.ts');
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
  globalThis.fetch = (async (
    _: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const signal = init!.signal!;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          requests.push({ signal, stream, messages: JSON.parse(String(init!.body)).messages });
          signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
        },
      }),
    );
  }) as unknown as typeof fetch;
  jest.useFakeTimers();
  const timers = jest.spyOn(globalThis, 'setTimeout');
  try {
    const mid = message();
    startGeneration(conversation, mid, undefined, { prompt });
    await flush();
    const active = requests.at(-1)!;
    const timerCount = timers.mock.calls.length;
    for (let index = 0; index < 32; index++) {
      active.stream.enqueue(encoder.encode(': heartbeat\n\n'));
      await flush();
    }
    assert.equal(
      timers.mock.calls.length,
      timerCount,
      'Network chunks do not allocate idle timers',
    );
    active.stream.enqueue(encoder.encode('data: null\ndata: malformed\n'));
    active.stream.enqueue(encoder.encode(frame({ content: 42, reasoning_content: {} })));
    for (const content of [' H', 'a', 'l', ':', ' Hello']) {
      active.stream.enqueue(encoder.encode(frame({ content })));
      await flush();
    }
    assert.equal(mergeLiveBuffers([getMessage(mid)!])[0]!.content, ' Hello');
    for (let index = 0; index < 4; index++) {
      jest.advanceTimersByTime(90_000);
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
    jest.advanceTimersByTime(120_000);
    assert(!active.signal.aborted, 'Finalization clears the idle watchdog');

    const retryId = message();
    startGeneration(conversation, retryId, undefined, { prompt });
    await flush();
    const stalled = requests.at(-1)!;
    jest.advanceTimersByTime(90_000);
    stalled.stream.enqueue(encoder.encode(frame({ content: 'Ha' })));
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
    assert.deepEqual(retry.messages.at(-1), { role: 'assistant', content: 'Hal: Ha' });
    retry.stream.enqueue(encoder.encode(frame({ content: 'ppy' })));
    retry.stream.close();
    await flush();
    assert.equal(getMessage(retryId)!.status, 'done');
    assert.equal(getMessage(retryId)!.content, 'Happy', 'Held prefix survives the idle retry once');

    // A request that stalls before returning response headers has the same deadline.
    let waitingSignal!: AbortSignal;
    globalThis.fetch = ((_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      new Promise((_, reject) => {
        waitingSignal = init!.signal!;
        waitingSignal.addEventListener('abort', () => reject(waitingSignal.reason), { once: true });
      })) as unknown as typeof fetch;
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

  type BuiltPrompt = import('../../server/src/prompt.ts').BuiltPrompt;
  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const { db, stmt, toConversation } = await import('../../server/src/db.ts');
  const { startGeneration, stopGeneration, stopAllGenerations, mergeLiveBuffers } =
    await import('../../server/src/generation.ts');
  const { getMessage } = await import('../../server/src/tree.ts');
  const { getSettings, putSettings } = await import('../../server/src/settingsStore.ts');
  const { getConversationRevision } = await import('../../server/src/conversationRevision.ts');
  const endpointId = Number(
    stmt('INSERT INTO endpoints (name, base_url, model, created_at) VALUES (?, ?, ?, ?)').run(
      'test',
      'https://upstream.invalid/v1',
      'test-model',
      Date.now(),
    ).lastInsertRowid,
  );
  putSettings({ ...getSettings(), activeEndpointId: endpointId });
  const cid = Number(
    stmt('INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)').run(
      'Persistence',
      Date.now(),
      Date.now(),
    ).lastInsertRowid,
  );
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
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          streams.push(controller);
        },
      }),
    )) as unknown as typeof fetch;
  const encoder = new TextEncoder();
  function append(
    stream: ReadableStreamDefaultController<Uint8Array>,
    content: string,
    reasoning = '',
  ) {
    stream.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content, reasoning_content: reasoning } }] })}\n\n`,
      ),
    );
  }
  function message(role = 'assistant') {
    return Number(
      stmt(
        "INSERT INTO messages (conversation_id, role, content, status, image_pending, created_at) VALUES (?, ?, '', 'streaming', 1, ?)",
      ).run(cid, role, Date.now()).lastInsertRowid,
    );
  }
  function begin(mid: number, resume?: { content: string; reasoning: string }) {
    startGeneration(conversation, mid, resume, { prompt, background: true });
    return streams.at(-1)!;
  }
  async function settle() {
    await flush();
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
    await settle();
    assert.equal(getMessage(mid)!.content, 'First reply');
    assert.equal(getMessage(mid)!.reasoning, 'Think more');
    assert.equal(getMessage(mid)!.model, 'test-model');
    assert.equal(getMessage(mid)!.status, 'done');
    assert.equal(getMessage(mid)!.imagePending, true);
    assert.equal(getConversationRevision(cid), revision + 1);

    stmt("UPDATE messages SET status = 'streaming' WHERE id = ?").run(mid);
    const old = begin(mid, { content: 'First reply', reasoning: 'Think more' });
    append(old, ' continued');
    await settle();
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
    await settle();
    assert.equal(
      mergeLiveBuffers([getMessage(mid)!])[0]!.content,
      'First reply continued successor',
    );
    next.close();
    await settle();
    assert.equal(getMessage(mid)!.content, 'First reply continued successor');

    const failed = message();
    const failingStream = begin(failed);
    append(failingStream, 'Partial', 'Reason');
    await settle();
    failingStream.error(new Error('fatal test failure'));
    await settle();
    assert.equal(getMessage(failed)!.status, 'error');
    assert.equal(getMessage(failed)!.content, 'Partial');
    assert.equal(getMessage(failed)!.reasoning, 'Reason');
    assert.equal(getMessage(failed)!.imagePending, false);

    const deleted = message();
    const deletedStream = begin(deleted);
    append(deletedStream, 'Gone');
    await settle();
    stmt('DELETE FROM messages WHERE id = ?').run(deleted);
    const beforeDeleteFinal = getConversationRevision(cid);
    deletedStream.close();
    await settle();
    assert.equal(getMessage(deleted), undefined);
    assert.equal(getConversationRevision(cid), beforeDeleteFinal);

    const pending = ['assistant', 'tool'].map((role) => {
      const id = message(role);
      const controller = begin(id);
      append(controller, role);
      return { id, controller, role };
    });
    await settle();
    stopAllGenerations();
    for (const { id, controller, role } of pending) {
      assert.equal(getMessage(id)!.content, role);
      assert.equal(getMessage(id)!.status, 'stopped');
      controller.close();
    }
    await settle();
  } finally {
    stopAllGenerations();
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
  }
});

databaseCase('prompt reasoning', async () => {
  const { jest } = await import('bun:test');

  const { setImmediate: flush } = await import('node:timers/promises');

  type Endpoint = import('@tinytavern/shared').Endpoint;
  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const { streamEndpointCompletion } = await import('../../server/src/generation.ts');
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
    genParams: {},
  };
  const originalFetch = globalThis.fetch;
  function upstream(delta: object, finishReason?: string) {
    return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`;
  }
  try {
    for (const field of ['reasoning_content', 'reasoning']) {
      globalThis.fetch = (async () =>
        new Response(
          [
            upstream({ [field]: 'Check the lighting. ' }),
            upstream({ [field]: 'Choose the camera angle.' }),
            upstream({ content: 'A bright scene', [field]: 'Do not append this to the preview' }),
            upstream({ [field]: 'Late reasoning is not displayed' }),
            upstream({}, 'stop'),
            'data: [DONE]\n\n',
          ].join(''),
        )) as unknown as typeof fetch;
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
      globalThis.fetch = (async () =>
        new Response(
          [...events, { done: true }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        )) as unknown as typeof fetch;
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
    globalThis.fetch = (async () =>
      new Response(
        upstream({ reasoning_content: 'No final prompt' }) + 'data: [DONE]\n\n',
      )) as unknown as typeof fetch;
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
    globalThis.fetch = (async () =>
      new Response('data: {"r":"Still thinking"}\n\n')) as unknown as typeof fetch;
    await assert.rejects(
      streamTextCompletion('/prompt', {}, () => assert.fail('No content arrived'), 'test prompt'),
      /ended before completion/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
