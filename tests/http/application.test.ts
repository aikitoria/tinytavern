import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { test, onTestFinished } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  newRequestId,
  preparePromptTrace,
  type MediaJob,
  type PromptTrace,
  type PromptMessage,
} from '@tinytavern/shared';
import type { Endpoint, ServerEvent, Settings, TreeSnapshot } from '@tinytavern/shared';
import { requireTestIsolation } from '../support/isolation.ts';
import { mockComfy, serveComfy } from '../support/comfy.ts';

// Exercise the public boundary once; feature suites cover combinations directly.
test('application HTTP and WebSocket contracts', async () => {
  async function step(name: string, run: () => Promise<void>) {
    try {
      await run();
    } catch (cause) {
      throw new Error(name, { cause });
    }
  }
  requireTestIsolation();
  const base = 'http://127.0.0.1:15487';
  const sockets: WebSocket[] = [];
  const arrivals = new EventEmitter();
  let held: ServerResponse | undefined;
  let hold = true;
  let upstreamStatus = 200;
  const completionRequests: {
    messages: PromptMessage[];
    stream: boolean;
    stream_options?: { include_usage: boolean };
  }[] = [];
  const delta = (res: ServerResponse, content: string) =>
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  const finish = (res: ServerResponse) => {
    delta(res, 'world');
    res.write(
      'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":10},"completion_tokens_details":{"reasoning_tokens":0,"text_tokens":4}}}\n\n',
    );
    res.end('data: [DONE]\n\n');
  };
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url?.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return;
    }
    completionRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (upstreamStatus !== 200) {
      res.writeHead(upstreamStatus).end('Invalid request');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    delta(res, 'Hello ');
    if (hold) {
      held = res;
      arrivals.emit('held');
    } else finish(res);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert(address && typeof address !== 'string');
  const child = spawn(process.execPath, ['server/src/index.ts'], {
    env: { ...process.env, PORT: '15487', COMFY_POLL_MS: '10' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    logs += String(chunk);
  });
  onTestFinished(async () => {
    for (const socket of sockets) socket.terminate();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const [code] = await exited;
      assert.equal(code, 0, logs);
    }
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error(logs)));
    child.stdout.on('data', () => {
      if (logs.includes('server listening')) resolve();
    });
  });

  let cookie = '';
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    status = 200,
  ): Promise<T> {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
  const tree = (id: number) => request<TreeSnapshot>('GET', `/api/conversations/${id}/tree`);
  const guard = (snap: TreeSnapshot) => ({
    expectedActiveLeafId: snap.activeLeafId,
    expectedMutationRevision: snap.mutationRevision,
  });
  async function connect(origin = base, expected = 101) {
    const socket = new WebSocket(base.replace('http', 'ws') + '/ws', {
      headers: { cookie, origin },
    });
    sockets.push(socket);
    socket.addEventListener('error', () => {});
    const events: ServerEvent[] = [];
    const notifications = new EventEmitter();
    socket.addEventListener('message', ({ data }) => {
      events.push(JSON.parse(String(data)) as ServerEvent);
      notifications.emit('event');
    });
    const status = await new Promise<number>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(101), { once: true });
      socket.addEventListener(
        'error',
        () =>
          expected === 101 ? reject(new Error('WebSocket upgrade failed')) : resolve(expected),
        { once: true },
      );
    });
    if (expected !== 101) {
      const rejected = await fetch(base + '/ws', {
        headers: {
          cookie,
          origin,
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      });
      assert.equal(rejected.status, expected);
      await rejected.arrayBuffer();
    }
    assert.equal(status, expected);
    if (expected === 101) {
      while (!events.some((event) => event.t === 'mediaJobs')) {
        await once(notifications, 'event', { signal: AbortSignal.timeout(2_000) });
      }
      assert.deepEqual(
        events.slice(0, 2).map((event) => event.t),
        ['hello', 'mediaJobs'],
      );
    }
    return {
      socket,
      events,
      async wait(predicate: (event: ServerEvent) => boolean): Promise<ServerEvent> {
        for (;;) {
          const match = events.find(predicate);
          if (match) return match;
          await once(notifications, 'event', { signal: AbortSignal.timeout(2_000) });
        }
      },
    };
  }

  await step('native routing and request body boundaries', async () => {
    for (const [method, path, body, status] of [
      ['GET', '/api/conversations/%E0%A4%A/tree', undefined, 400],
      ['PUT', '/api/conversations', '{}', 404],
      ['POST', '/api/conversations', '{broken', 400],
      ['POST', '/api/auth/login', 'x'.repeat(4097), 413],
    ] as const) {
      const response = await fetch(base + path, { method, body });
      assert.equal(response.status, status, `${method} ${path}: ${await response.text()}`);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
  });

  await step('origin checks, endpoint secrets and optimistic settings writes', async () => {
    const hostile = await fetch(base + '/api/settings', {
      headers: { origin: 'http://attacker.invalid' },
    });
    assert.equal(hostile.status, 403);
    await hostile.arrayBuffer();
    await connect('http://attacker.invalid', 403);
    const endpoint = await request<Endpoint>('POST', '/api/endpoints', {
      name: 'Test',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'private-key',
      model: 'test-model',
    });
    assert.equal(endpoint.systemPromptPrefix, '');
    assert.equal(endpoint.systemPromptSuffix, '');
    assert.equal(endpoint.reasoningPrefillPrefix, '');
    const additions = {
      systemPromptPrefix: 'Prefix\n',
      systemPromptSuffix: '\nSuffix',
      reasoningPrefillPrefix: 'Think\n',
    };
    const updated = await request<Endpoint>('PATCH', `/api/endpoints/${endpoint.id}`, additions);
    for (const [field, value] of Object.entries(additions)) {
      assert.equal(updated[field as keyof Endpoint], value);
      await request('PATCH', `/api/endpoints/${endpoint.id}`, { [field]: 123 }, 400);
    }
    await request('PATCH', `/api/endpoints/${endpoint.id}`, {
      systemPromptPrefix: '',
      systemPromptSuffix: '',
      reasoningPrefillPrefix: '',
    });
    const listed = await request<{ id: number; apiKey: string; hasApiKey: boolean }[]>(
      'GET',
      '/api/endpoints',
    );
    assert.equal(listed[0]!.apiKey, '');
    assert.equal(listed[0]!.hasApiKey, true);
    assert.deepEqual(await request('GET', `/api/endpoints/${endpoint.id}/models`), ['test-model']);
    const settings = await request<Settings>('GET', '/api/settings');
    await request('PUT', '/api/settings', {
      expectedRevision: settings.revision,
      activeEndpointId: endpoint.id,
    });
    await request(
      'PUT',
      '/api/settings',
      { expectedRevision: settings.revision, activeEndpointId: null },
      409,
    );
  });

  const conv = await request<{ id: number }>('POST', '/api/conversations', {});
  await step('avatar adoption keeps an independent PNG after its source is deleted', async () => {
    const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
    const png = makePlaceholderPng();
    const response = await fetch(base + '/api/gallery/upload', { method: 'POST', body: png });
    assert.equal(response.status, 200);
    const item = (await response.json()) as { id: number; media: { id: number } };
    const persona = await request<{ id: number }>('POST', '/api/personas', { name: 'Portrait' });
    const path = `/api/personas/${persona.id}`;
    await request('POST', `${path}/avatar`, { assetId: item.media.id });
    await request('DELETE', `/api/gallery/${item.id}`, undefined, 204);
    await request('POST', `${path}/avatar`, { assetId: item.media.id }, 409);
    const saved = await request<{ avatarData: string }>('GET', `${path}/settings-export`);
    assert.equal(saved.avatarData, `data:image/png;base64,${png.toString('base64')}`);
    const jpeg = await fetch(base + '/api/gallery/upload', {
      method: 'POST',
      body: Bun.file('tests/fixtures/image.jpg'),
    });
    assert.equal(jpeg.status, 200);
    const other = (await jpeg.json()) as typeof item;
    await request('POST', `${path}/avatar`, { assetId: other.media.id }, 415);
    assert.deepEqual(await request('GET', `${path}/settings-export`), saved);
  });
  await request('PATCH', `/api/conversations/${conv.id}`, {
    ...guard(await tree(conv.id)),
    title: 'Test',
  });
  const first = await connect();
  const peer = await connect();
  first.socket.send('null');
  for (const viewer of [first, peer]) {
    viewer.socket.send(JSON.stringify({ sub: conv.id }));
    await viewer.wait((event) => event.t === 'tree');
  }
  let mid = 0;
  await step('streaming, reconnect snapshots, live export and peer consistency', async () => {
    const initial = await tree(conv.id);
    const sent = await request<{ assistantMessageId: number }>(
      'POST',
      `/api/conversations/${conv.id}/messages`,
      {
        ...guard(initial),
        content: '  Hello  ',
      },
    );
    mid = sent.assistantMessageId;
    await first.wait((event) => event.t === 'delta' && event.mid === mid);
    assert(held, 'The response stays in flight until the test releases it');
    const late = await connect();
    late.socket.send(JSON.stringify({ sub: conv.id }));
    const snapshot = await late.wait((event) => event.t === 'tree');
    assert(snapshot.t === 'tree');
    assert.equal(snapshot.messages.find((message) => message.id === mid)!.content, 'Hello ');
    const exported = await request<{ messages: { id: number; content: string }[] }>(
      'GET',
      `/api/conversations/${conv.id}/export`,
    );
    assert.equal(exported.messages.find((message) => message.id === mid)!.content, 'Hello ');
    await request(
      'POST',
      `/api/conversations/${conv.id}/messages`,
      { ...guard(initial), content: 'stale' },
      409,
    );
    finish(held);
    held = undefined;
    hold = false;
    for (const viewer of [first, peer]) {
      const event = await viewer.wait((event) => event.t === 'final' && event.message.id === mid);
      assert(event.t === 'final');
      assert.equal(event.message.content, 'Hello world');
      assert.equal(
        viewer.events
          .filter((event) => event.t === 'delta' && event.mid === mid)
          .map((event) => (event.t === 'delta' ? (event.d ?? '') : ''))
          .join(''),
        event.message.content,
      );
    }
    const persisted = await tree(conv.id);
    assert.equal(persisted.messages[0]!.content, 'Hello');
    assert.equal(persisted.messages.find((message) => message.id === mid)!.status, 'done');
  });

  await step(
    'prompt trace matches the sent request including pending text and endpoint prefills',
    async () => {
      const endpoint = await request<Endpoint>('POST', '/api/endpoints', {
        name: 'Trace endpoint',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        systemPromptPrefix: 'Endpoint prefix\n',
        systemPromptSuffix: '\nEndpoint suffix',
        reasoningPrefillPrefix: 'Endpoint reasoning\n',
      });
      const template = await request<{ id: number }>('POST', '/api/templates', {
        name: 'Trace template',
        content: 'Template system',
        userPrologue: 'Prologue',
        reasoningPrefill: 'Template reasoning',
        messagePrefill: 'Template reply',
        prefixNames: true,
        speakerHandoffTemplate: 'Reply as {{speaker}}.',
      });
      const character = await request<{ id: number }>('POST', '/api/characters', {
        name: 'Trace assistant',
        templateId: template.id,
      });
      const persona = await request<{ id: number }>('POST', '/api/personas', {
        name: 'Trace user',
      });
      const chat = await request<{ id: number }>('POST', '/api/conversations', {
        characterId: character.id,
      });
      await request('PATCH', `/api/conversations/${chat.id}`, {
        ...guard(await tree(chat.id)),
        endpointId: endpoint.id,
        personaId: persona.id,
        speakerName: 'Guest',
      });
      const viewer = await connect();
      viewer.socket.send(JSON.stringify({ sub: chat.id }));
      for (const [mode, allowReasoningPrefill, allowMessagePrefill, prefixNames] of [
        ['deepseek', true, true, true],
        ['vllm', true, false, false],
        ['none', false, true, false],
        ['disabled', true, true, true],
      ] as const) {
        await request('PATCH', `/api/endpoints/${endpoint.id}`, {
          prefillMode: mode,
          allowReasoningPrefill,
          allowMessagePrefill,
        });
        await request('PATCH', `/api/templates/${template.id}`, { prefixNames });
        const reasoningEnabled = mode !== 'disabled' && allowReasoningPrefill;
        const messageEnabled = mode !== 'disabled' && allowMessagePrefill;
        const namePrefix = prefixNames && messageEnabled ? 'Guest:' : '';
        const before = await tree(chat.id);
        const trace = await request<PromptTrace>('GET', `/api/conversations/${chat.id}/trace`);
        assert.deepEqual(
          await tree(chat.id),
          before,
          'Reading trace does not persist drafts or mutate the branch',
        );
        assert.equal(
          trace.messages[0]!.content,
          'Endpoint prefix\nTemplate system\nEndpoint suffix',
        );
        assert.equal(
          trace.reasoningPrefill,
          reasoningEnabled ? 'Endpoint reasoning\nTemplate reasoning' : null,
        );
        const pendingMessage = `  Pending ${mode} {{char}} $&\nSecond line  `;
        const preview = preparePromptTrace(trace, pendingMessage);
        const pending = preview.messages[preview.pendingMessageIndex!]!;
        const userContent = `${prefixNames ? 'Trace user: ' : ''}${pendingMessage.trim()}`;
        assert.equal(
          pending.content,
          mode === 'deepseek' ? `Prologue\n\n${userContent}` : userContent,
        );
        if (mode !== 'disabled') {
          assert.deepEqual(preview.messages.at(-1), {
            role: 'assistant',
            content: messageEnabled ? `${namePrefix ? namePrefix + ' ' : ''}Template reply` : '',
            ...(reasoningEnabled
              ? { reasoning_content: 'Endpoint reasoning\nTemplate reasoning' }
              : {}),
            ...(mode === 'deepseek' ? { prefix: true } : {}),
          });
        } else {
          assert.equal(preview.prefillMessageIndex, null);
          assert(
            trace.messages.some(
              (message) => message.reasoning_content === 'Endpoint reasoning\nTemplate reasoning',
            ),
            'Historical reasoning remains visible when new prefills are disabled',
          );
        }
        const start = completionRequests.length;
        hold = true;
        const sent = await request<{ assistantMessageId: number }>(
          'POST',
          `/api/conversations/${chat.id}/messages`,
          {
            ...guard(before),
            content: pendingMessage,
          },
        );
        await viewer.wait((event) => event.t === 'delta' && event.mid === sent.assistantMessageId);
        const liveTrace = await request<PromptTrace>('GET', `/api/conversations/${chat.id}/trace`);
        const liveTree = await tree(chat.id);
        const liveMessage = liveTree.messages.find(
          (message) => message.id === sent.assistantMessageId,
        )!;
        assert.deepEqual(liveTrace.stream, {
          messageId: sent.assistantMessageId,
          generationToken: liveMessage.generationToken,
          namePrefix,
        });
        assert.deepEqual(
          liveTrace.messages,
          preview.messages.slice(0, preview.prefillMessageIndex ?? undefined),
        );
        assert(liveMessage.content.includes('Hello'), 'Reply text is supplied by the tree stream');
        assert.equal(liveTrace.reasoningPrefill, null, 'Live buffers already include the seed');
        await request('PATCH', `/api/endpoints/${endpoint.id}`, {
          systemPromptPrefix: 'Edited while streaming\n',
        });
        assert.deepEqual(
          await request<PromptTrace>('GET', `/api/conversations/${chat.id}/trace`),
          liveTrace,
          'Active trace retains the captured request after settings edits',
        );
        await request('PATCH', `/api/endpoints/${endpoint.id}`, {
          systemPromptPrefix: 'Endpoint prefix\n',
        });
        assert(held);
        finish(held);
        held = undefined;
        hold = false;
        const final = await viewer.wait(
          (event) => event.t === 'final' && event.message.id === sent.assistantMessageId,
        );
        assert(final.t === 'final');
        const metrics = final.message.genMeta!.generations![0]!;
        assert.equal(metrics.attempts[0]!.completionTokens, 4);
        assert.equal(metrics.attempts[0]!.textTokens, 4);
        assert.equal(metrics.attempts[0]!.cachedTokens, 10);
        assert(metrics.attempts[0]!.lastTokenMs! >= metrics.attempts[0]!.firstTokenMs!);
        const savedMessage = (await tree(chat.id)).messages.find(
          (message) => message.id === sent.assistantMessageId,
        )!;
        assert.deepEqual(savedMessage.genMeta!.generations![0], metrics);
        const completedTrace = await request<PromptTrace>(
          'GET',
          `/api/conversations/${chat.id}/trace`,
        );
        assert.equal(completedTrace.stream, undefined);
        const replyIndex = completedTrace.messageIds!.findIndex((ids) =>
          ids.includes(sent.assistantMessageId),
        );
        assert(replyIndex >= 0, 'Completed replies retain their metric attribution in the trace');
        assert.equal(completedTrace.messages[replyIndex]!.role, 'assistant');
        assert(completedTrace.messages[replyIndex]!.content.includes('world'));
        assert.equal(completedTrace.messageIds!.length, completedTrace.messages.length);
        assert.equal(completedTrace.speakerHandoff, null, 'The same speaker needs no new handoff');
        assert.equal(
          completedTrace.messages
            .map((message) => message.content)
            .join('\n')
            .split('Reply as Guest.').length - 1,
          1,
          'The historical speaker change remains after completion without accumulating copies',
        );
        const actual = completionRequests.slice(start).find((entry) => entry.stream)!;
        assert.deepEqual(actual.stream_options, { include_usage: true });
        assert.deepEqual(
          preview.messages,
          actual.messages,
          `${mode}: trace must match the actual upstream messages`,
        );
        if (!messageEnabled) {
          await request(
            'POST',
            `/api/messages/${sent.assistantMessageId}/continue`,
            guard(await tree(chat.id)),
            400,
          );
        }
      }
      const closed = once(viewer.socket, 'close');
      viewer.socket.close();
      await closed;
    },
  );

  await step('image commands and revisions work without a rendering workflow', async () => {
    const chat = await request<{ id: number }>('POST', '/api/conversations', {});
    const viewer = await connect();
    viewer.socket.send(JSON.stringify({ sub: chat.id }));
    const generated = await request<{ toolMessageId: number }>(
      'POST',
      `/api/conversations/${chat.id}/tool`,
      {
        ...guard(await tree(chat.id)),
        prompt: 'Describe a portrait',
        label: 'Image prompt',
      },
    );
    await viewer.wait(
      (event) => event.t === 'final' && event.message.id === generated.toolMessageId,
    );
    const revised = await request<{ assistantMessageId: number }>(
      'POST',
      `/api/messages/${generated.toolMessageId}/regenerate`,
      {
        ...guard(await tree(chat.id)),
        instruction: 'Add moonlight',
      },
    );
    await viewer.wait(
      (event) => event.t === 'final' && event.message.id === revised.assistantMessageId,
    );
    const snapshot = await tree(chat.id);
    assert.equal(snapshot.activeLeafId, revised.assistantMessageId);
    assert.equal(snapshot.messages[1]!.parentId, generated.toolMessageId);
    for (const message of snapshot.messages) {
      assert.equal(message.role, 'tool');
      assert.equal(message.name, 'Image prompt');
      assert.equal(message.content, 'Hello world');
      assert.equal(message.imagePending, false);
    }
  });

  await step(
    'avatar preparation and text acceptance use the shared media HTTP and socket contracts',
    async () => {
      const protocol = mockComfy({
        submit(_body, execution) {
          execution.state = 'done';
          execution.outputs = { output: { text: ['Description from Comfy'] } };
        },
      });
      const comfy = serveComfy(protocol.fetch);
      const previous = await request<Settings>('GET', '/api/settings');
      try {
        const avatarWorkflow = {
          id: 'avatar-http',
          name: 'Avatar HTTP',
          inputBindings: {},
          textOutputNodeId: null,
          chatPromptPresetId: null,
          standalonePromptPresetId: null,
          json: '{"output":{"inputs":{"text":"{{prompt}}"}}}',
        };
        const textWorkflow = {
          ...avatarWorkflow,
          id: 'text-http',
          name: 'Text HTTP',
          textOutputNodeId: 'output',
          json: '{"output":{"inputs":{}}}',
        };
        await request('PUT', '/api/settings', {
          expectedRevision: previous.revision,
          mediaRendering: {
            ...previous.mediaRendering,
            comfyUrl: comfy.url,
            workflows: [...previous.mediaRendering.workflows, avatarWorkflow, textWorkflow],
          },
        });
        const character = await request<{ id: number }>('POST', '/api/characters', {
          name: 'Avatar HTTP subject',
          personality: 'Authoritative avatar description',
        });
        const avatar = await request<MediaJob>('POST', '/api/media/jobs', {
          requestKey: newRequestId(),
          workflowId: avatarWorkflow.id,
          avatarContext: { kind: 'character', id: character.id },
          reviewBeforeSave: true,
        });
        await request('POST', `/api/media/jobs/${avatar.id}/prepare`, {
          expectedRevision: avatar.revision,
        });
        const ready = await first.wait(
          (event) =>
            event.t === 'mediaJob' && event.job.id === avatar.id && event.job.state === 'ready',
        );
        assert(ready.t === 'mediaJob');
        assert.deepEqual(ready.job.avatarContext, { kind: 'character', id: character.id });
        assert(ready.job.prompt.includes('Hello world'));
        assert(
          completionRequests
            .at(-1)!
            .messages.some((message) =>
              message.content.includes('Authoritative avatar description'),
            ),
        );
        await request('POST', `/api/media/jobs/${avatar.id}/discard`, {
          expectedRevision: ready.job.revision,
          expectedDraftRevision: ready.job.draft!.revision,
        });

        const chat = await request<{ id: number }>('POST', '/api/conversations', {});
        const draft = await request<MediaJob>('POST', '/api/media/jobs', {
          requestKey: newRequestId(),
          workflowId: textWorkflow.id,
          contextConversationId: chat.id,
          destination: 'chat',
          reviewBeforeSave: true,
        });
        await request('POST', `/api/media/jobs/${draft.id}/render`, {
          expectedRevision: draft.revision,
        });
        const done = await first.wait(
          (event) =>
            event.t === 'mediaJob' && event.job.id === draft.id && event.job.state === 'succeeded',
        );
        assert(done.t === 'mediaJob');
        const acceptance = {
          assetId: null,
          expectedRevision: done.job.revision,
          expectedDraftRevision: done.job.draft!.revision,
          ...guard(await tree(chat.id)),
        };
        await request(
          'POST',
          `/api/media/jobs/${draft.id}/accept`,
          { ...acceptance, expectedRevision: -1 },
          409,
        );
        const saved = await request<MediaJob>(
          'POST',
          `/api/media/jobs/${draft.id}/accept`,
          acceptance,
        );
        const message = (await tree(chat.id)).messages.find((item) => item.id === saved.messageId)!;
        assert.equal(message.content, 'Description from Comfy');
        assert.deepEqual(message.media, []);
        await request('POST', `/api/media/jobs/${draft.id}/discard`, {
          expectedRevision: saved.revision,
          expectedDraftRevision: saved.draft!.revision,
        });
        assert((await tree(chat.id)).messages.some((item) => item.id === saved.messageId));
        assert.deepEqual(comfy.errors, []);
      } finally {
        const current = await request<Settings>('GET', '/api/settings');
        await request('PUT', '/api/settings', {
          expectedRevision: current.revision,
          mediaRendering: previous.mediaRendering,
        });
        await comfy.stop();
      }
    },
  );

  await step(
    'embedded media conversations share socket transport and use their own prompt template',
    async () => {
      const previous = await request<Settings>('GET', '/api/settings');
      const previousHold = hold;
      hold = false;
      const workflow = {
        id: 'prompt-discussion',
        name: 'Prompt discussion',
        inputBindings: {},
        textOutputNodeId: null,
        json: '{"input":{"class_type":"LoadImage","inputs":{"image":"fixture.png"},"_meta":{"title":"Reference [image:input1]"}},"1":{"inputs":{"prompt":"{{prompt}}","seed":0,"image":["input",0]}}}',
        standalonePromptPresetId: 'discussion',
      };
      try {
        await request('PUT', '/api/settings', {
          expectedRevision: previous.revision,
          mediaRendering: {
            ...previous.mediaRendering,
            workflows: [...previous.mediaRendering.workflows, workflow],
          },
          mediaStandalonePrompts: {
            folders: [],
            defaultPresetId: null,
            presets: [
              {
                id: 'discussion',
                name: 'Discussion',
                systemPrompt: 'MEDIA SYSTEM ONLY',
                userMessage: 'Media task: {{instruction}}\nReference: {{input1_prompt}}',
                reasoningPrefill: '',
                messagePrefill: '',
              },
              {
                id: 'restart-discussion',
                name: 'Restart discussion',
                systemPrompt: 'RESTART SYSTEM',
                userMessage: 'Fresh task: {{instruction}}\nReference: {{input1_prompt}}',
                reasoningPrefill: '',
                messagePrefill: '',
              },
            ],
          },
        });
        const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
        const uploadReference = async (prompt: string) => {
          const response = await fetch(base + '/api/gallery/upload', {
            method: 'POST',
            body: makePlaceholderPng(),
          });
          assert.equal(response.status, 200);
          const item = (await response.json()) as { id: number; media: { id: number } };
          await request('PATCH', `/api/gallery/${item.id}`, { prompt, expectedPrompt: '' });
          return item;
        };
        const firstReference = await uploadReference('Original reference');
        const nextReference = await uploadReference('Changed reference');
        let job = await request<MediaJob>('POST', '/api/media/jobs', {
          requestKey: newRequestId(),
          workflowId: workflow.id,
          instruction: 'Move the camera',
          inputs: [{ slot: 'input1', assetId: firstReference.media.id }],
          prompt: 'Original media prompt',
          reviewBeforeSave: true,
        });
        await request(
          'POST',
          `/api/media/jobs/${job.id}/conversation`,
          { expectedRevision: job.revision, expectedDraftRevision: -1 },
          409,
        );
        const beforeMigration = completionRequests.length;
        job = await request<MediaJob>('POST', `/api/media/jobs/${job.id}/conversation/migrate`, {
          expectedRevision: job.revision,
          expectedDraftRevision: job.draft!.revision,
        });
        const media = await request<import('@tinytavern/shared').Conversation>(
          'GET',
          `/api/conversations/${job.draft!.conversationId}`,
        );
        assert.equal(
          completionRequests.length,
          beforeMigration,
          'Importing the saved reply makes no model request',
        );
        assert.equal(media.promptMode, 'media');
        for (const query of [media.title, 'Original media prompt']) {
          const results = await request<{ conversation: { id: number } }[]>(
            'GET',
            `/api/search?q=${encodeURIComponent(query)}`,
          );
          assert(
            !results.some((result) => result.conversation.id === media.id),
            'Global search excludes media titles and message bodies',
          );
        }
        await request('POST', `/api/conversations/${media.id}/duplicate`, undefined, 409);
        await request(
          'POST',
          `/api/messages/${media.activeLeafId}/branch-conversation`,
          undefined,
          409,
        );
        await request('GET', `/api/conversations/${media.id}/export`, undefined, 409);
        const portable = await request<{ conversation: object }>(
          'GET',
          `/api/conversations/${conv.id}/export`,
        );
        await request(
          'POST',
          '/api/conversations/import',
          {
            ...portable,
            conversation: {
              ...portable.conversation,
              promptContext: { messages: [], reasoningPrefill: '', messagePrefill: '' },
            },
          },
          400,
        );
        job = await request<MediaJob>('GET', `/api/media/jobs/${job.id}`);
        assert.equal(job.draft!.conversationId, media.id);
        assert.equal(
          (
            await request<import('@tinytavern/shared').Conversation>(
              'GET',
              `/api/conversations/${media.id}`,
            )
          ).id,
          media.id,
        );
        const viewer = await connect();
        viewer.socket.send(JSON.stringify({ subs: [conv.id, media.id] }));
        await viewer.wait((event) => event.t === 'tree' && event.conversationId === conv.id);
        await viewer.wait((event) => event.t === 'tree' && event.conversationId === media.id);
        const before = completionRequests.length;
        const sent = await request<{ assistantMessageId: number }>(
          'POST',
          `/api/conversations/${media.id}/messages`,
          { ...guard(await tree(media.id)), content: 'Keep the head still' },
        );
        await viewer.wait(
          (event) => event.t === 'final' && event.message.id === sent.assistantMessageId,
        );
        const contents = completionRequests[before]!.messages.map((message) => message.content);
        assert.deepEqual(contents, [
          'MEDIA SYSTEM ONLY',
          'Media task: Move the camera\nReference: Original reference',
          'Original media prompt',
          'Keep the head still',
        ]);
        const snapshot = await tree(media.id);
        const reply = snapshot.messages.find((message) => message.id === sent.assistantMessageId)!;
        await request('POST', `/api/messages/${reply.id}/advance`, guard(snapshot));
        const switched = await viewer.wait(
          (event) =>
            event.t === 'treePatch' &&
            event.conversationId === media.id &&
            event.activeLeafId !== reply.id &&
            event.mutationRevision > snapshot.mutationRevision,
        );
        assert.equal(switched.t, 'treePatch');
        const current = await tree(media.id);
        await viewer.wait(
          (event) => event.t === 'final' && event.message.id === current.activeLeafId,
        );
        assert.equal(
          current.messages.filter((message) => message.parentId === reply.parentId).length,
          2,
        );
        job = await request<MediaJob>('GET', `/api/media/jobs/${job.id}`);
        job = await request<MediaJob>('PATCH', `/api/media/jobs/${job.id}`, {
          expectedRevision: job.revision,
          instruction: 'Use the new image',
          presetId: 'restart-discussion',
          inputs: [{ slot: 'input1', assetId: nextReference.media.id }],
        });
        const beforeRestart = await tree(media.id);
        const restartGuard = {
          expectedRevision: job.revision,
          expectedDraftRevision: job.draft!.revision,
          expectedPromptLeafId: beforeRestart.activeLeafId,
          expectedPromptRevision: beforeRestart.mutationRevision,
        };
        await request(
          'POST',
          `/api/media/jobs/${job.id}/conversation/restart`,
          {
            ...restartGuard,
            expectedPromptRevision: 0,
          },
          409,
        );
        assert.deepEqual((await tree(media.id)).messages, beforeRestart.messages);
        const restartedRequest = completionRequests.length;
        const restarted = await request<import('@tinytavern/shared').Conversation>(
          'POST',
          `/api/media/jobs/${job.id}/conversation/restart`,
          restartGuard,
        );
        assert.equal(
          restarted.id,
          media.id,
          'Restart retains the draft’s durable conversation identity',
        );
        await viewer.wait(
          (event) => event.t === 'final' && event.message.id === restarted.activeLeafId,
        );
        const restartedTree = await tree(media.id);
        assert.equal(
          restartedTree.messages.length,
          2,
          'Restart replaces every old swipe and followup',
        );
        assert(
          restartedTree.messages.every(
            (message) => !beforeRestart.messages.some((old) => old.id === message.id),
          ),
        );
        assert.deepEqual(
          completionRequests[restartedRequest]!.messages.map((message) => message.content),
          ['RESTART SYSTEM', 'Fresh task: Use the new image\nReference: Changed reference'],
        );
        assert.equal((await request<MediaJob>('GET', `/api/media/jobs/${job.id}`)).prompt, '');
        const eventStart = viewer.events.length;
        viewer.socket.send(JSON.stringify({ subs: [conv.id], resync: conv.id }));
        await viewer.wait(
          (event) =>
            viewer.events.indexOf(event) >= eventStart &&
            event.t === 'tree' &&
            event.conversationId === conv.id,
        );
        job = await request<MediaJob>('GET', `/api/media/jobs/${job.id}`);
        await request('DELETE', `/api/media/jobs/${job.id}?expectedRevision=${job.revision}`);
        await request('GET', `/api/conversations/${media.id}`, undefined, 404);
        await request('DELETE', `/api/gallery/${firstReference.id}`, undefined, 204);
        await request('DELETE', `/api/gallery/${nextReference.id}`, undefined, 204);
      } finally {
        hold = previousHold;
        const current = await request<Settings>('GET', '/api/settings');
        await request('PUT', '/api/settings', {
          expectedRevision: current.revision,
          mediaRendering: previous.mediaRendering,
          mediaStandalonePrompts: previous.mediaStandalonePrompts,
        });
      }
    },
  );

  await step('media draft lookup survives deletion of its original job', async () => {
    const first = await request<MediaJob>('POST', '/api/media/jobs', {
      requestKey: newRequestId(),

      prompt: 'First variation',
      reviewBeforeSave: true,
    });
    const second = await request<MediaJob>('POST', `/api/media/jobs/${first.id}/rerun`, {
      requestKey: newRequestId(),
      expectedRevision: first.revision,
      prompt: 'Second variation',
    });
    await request('DELETE', `/api/media/jobs/${first.id}?expectedRevision=${first.revision}`);
    await request('GET', `/api/media/jobs/${first.id}/variations`, undefined, 404);
    const remaining = await request<MediaJob[]>(
      'GET',
      `/api/media/drafts/${first.draft!.id}/variations`,
    );
    assert.deepEqual(
      remaining.map((job) => job.id),
      [second.id],
    );
    await request('DELETE', `/api/media/jobs/${second.id}?expectedRevision=${second.revision}`);
    assert.deepEqual(await request('GET', `/api/media/drafts/${first.draft!.id}/variations`), []);
  });

  await step('incremental edits, stale same-leaf writes and branch restoration', async () => {
    const before = await tree(conv.id);
    await request('PATCH', `/api/messages/${mid}`, { ...guard(before), content: 'Edited' });
    await request(
      'PATCH',
      `/api/messages/${mid}`,
      { ...guard(before), content: 'Lost update' },
      409,
    );
    const patch = await peer.wait(
      (event) =>
        event.t === 'treePatch' && event.messages.some((message) => message.content === 'Edited'),
    );
    assert(patch.t === 'treePatch');
    assert.equal(patch.messages.length, 1);
    assert.equal(patch.nodes.length, 2);
    const advanced = await request<{ assistantMessageId: number }>(
      'POST',
      `/api/messages/${mid}/advance`,
      guard(await tree(conv.id)),
    );
    await first.wait(
      (event) => event.t === 'final' && event.message.id === advanced.assistantMessageId,
    );
    const sent = await request<{ assistantMessageId: number }>(
      'POST',
      `/api/conversations/${conv.id}/messages`,
      {
        ...guard(await tree(conv.id)),
        content: 'Continuation',
      },
    );
    await first.wait(
      (event) => event.t === 'final' && event.message.id === sent.assistantMessageId,
    );
    await request('POST', `/api/messages/${mid}/activate`, guard(await tree(conv.id)));
    assert.equal((await tree(conv.id)).activeLeafId, mid);
    await request(
      'POST',
      `/api/messages/${advanced.assistantMessageId}/activate`,
      guard(await tree(conv.id)),
    );
    assert.equal((await tree(conv.id)).activeLeafId, sent.assistantMessageId);
  });

  await step(
    'background swipes promote the prepared stream without another submission',
    async () => {
      const before = await tree(conv.id);
      hold = true;
      const settings = await request<Settings>('GET', '/api/settings');
      await request('PUT', '/api/settings', {
        expectedRevision: settings.revision,
        backgroundSwipeGeneration: true,
      });
      const prepared = await first.wait(
        (event) =>
          event.t === 'treePatch' &&
          event.nodes.some(
            (node) => node.generationKind === 'speculative' && node.status === 'streaming',
          ),
      );
      assert(prepared.t === 'treePatch');
      const sibling = prepared.nodes.find((node) => node.generationKind === 'speculative')!;
      assert.equal(prepared.activeLeafId, before.activeLeafId);
      if (!held) await once(arrivals, 'held', { signal: AbortSignal.timeout(2_000) });
      const response = held!;
      await request(
        'POST',
        `/api/generations/${sibling.id}/stop`,
        { expectedGenerationToken: sibling.generationToken },
        409,
      );
      const advanced = await request<{ assistantMessageId: number | null }>(
        'POST',
        `/api/messages/${before.activeLeafId}/advance`,
        guard(await tree(conv.id)),
      );
      assert.equal(advanced.assistantMessageId, null);
      assert.equal((await tree(conv.id)).activeLeafId, sibling.id);
      const current = await request<Settings>('GET', '/api/settings');
      await request('PUT', '/api/settings', {
        expectedRevision: current.revision,
        backgroundSwipeGeneration: false,
      });
      finish(response);
      held = undefined;
      hold = false;
      await first.wait((event) => event.t === 'final' && event.message.id === sibling.id);
      assert.equal((await tree(conv.id)).messages.length, before.messages.length + 1);
    },
  );

  await step('cancellation persists partial content and upstream failures terminate', async () => {
    hold = true;
    const sent = await request<{ assistantMessageId: number }>(
      'POST',
      `/api/conversations/${conv.id}/messages`,
      {
        ...guard(await tree(conv.id)),
        content: 'Stop this',
      },
    );
    await first.wait((event) => event.t === 'delta' && event.mid === sent.assistantMessageId);
    const message = (await tree(conv.id)).messages.find(
      (message) => message.id === sent.assistantMessageId,
    )!;
    await request('POST', `/api/generations/${message.id}/stop`, {
      expectedGenerationToken: message.generationToken,
    });
    assert.equal(
      (await tree(conv.id)).messages.find((item) => item.id === message.id)!.content,
      'Hello',
    );
    held = undefined;
    hold = false;
    upstreamStatus = 400;
    const failed = await request<{ assistantMessageId: number }>(
      'POST',
      `/api/messages/${message.id}/advance`,
      guard(await tree(conv.id)),
    );
    const final = await first.wait(
      (event) => event.t === 'final' && event.message.id === failed.assistantMessageId,
    );
    assert(final.t === 'final');
    assert(final.message.genMeta?.error?.includes('400'));
    upstreamStatus = 200;
  });

  await step('bulk character deletion preserves chats and releases avatars', async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
    const character = await request<{ id: number }>('POST', '/api/characters', {
      name: 'Delete me',
    });
    await request('POST', '/api/characters', { name: 'Delete me too' });
    const chat = await request<{ id: number }>('POST', '/api/conversations', {
      characterId: character.id,
    });
    const before = await tree(chat.id);
    const avatar = await fetch(`${base}/api/characters/${character.id}/avatar`, {
      method: 'PUT',
      body: makePlaceholderPng(),
    });
    assert.equal(avatar.status, 200);
    await avatar.arrayBuffer();
    const avatarPath = join(process.env.DATA_DIR!, 'avatars', `character-${character.id}.png`);
    assert(existsSync(avatarPath));
    const count = (await request<unknown[]>('GET', '/api/characters')).length;
    assert.deepEqual(await request('DELETE', '/api/characters'), { deleted: count });
    assert.deepEqual(await request('GET', '/api/characters'), []);
    const remaining = await request<{ id: number; characterId: number | null }[]>(
      'GET',
      '/api/conversations',
    );
    assert.equal(remaining.find((item) => item.id === chat.id)!.characterId, null);
    const after = await tree(chat.id);
    assert.deepEqual(after.messages, before.messages);
    assert(after.mutationRevision > before.mutationRevision);
    assert.equal(existsSync(avatarPath), false);
    assert.deepEqual(await request('DELETE', '/api/characters'), { deleted: 0 });
  });

  await step('password sessions, protected media, logout and socket revocation', async () => {
    const settings = await request<Settings>('GET', '/api/settings');
    const response = await fetch(base + '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: settings.revision,
        accessPassword: 'test-password',
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie')!, /HttpOnly/i);
    assert.equal(((await response.json()) as Settings).hasPassword, true);
    await request('GET', '/api/conversations', undefined, 401);
    const media = await fetch(base + '/images/123.png');
    assert.equal(media.status, 401);
    await media.arrayBuffer();
    await connect(base, 401);
    await request('POST', '/api/auth/login', { password: 'wrong' }, 401);
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    assert.equal(login.status, 200);
    await login.arrayBuffer();
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    await request('GET', '/api/conversations');
    const authenticated = await connect();
    const closed = once(authenticated.socket, 'close');
    const previous = await request<Settings>('GET', '/api/settings');
    const resetBody = {
      ...DEFAULT_SETTINGS,
      imageGeneration: { ...DEFAULT_SETTINGS.imageGeneration, promptPresets: {} },
      expectedRevision: previous.revision,
    };
    await request('PUT', '/api/settings', { ...resetBody, expectedRevision: -1 }, 409);
    const reset = await request<Settings>('PUT', '/api/settings', resetBody);
    assert.deepEqual(reset, {
      ...DEFAULT_SETTINGS,
      imageGeneration: resetBody.imageGeneration,
      revision: previous.revision + 1,
      hasPassword: true,
    });
    assert.equal((await request<Endpoint[]>('GET', '/api/endpoints'))[0]!.hasApiKey, true);
    assert((await request<unknown[]>('GET', '/api/conversations')).length > 0);
    await request('PUT', '/api/settings', { ...previous, expectedRevision: reset.revision });
    const current = await request<Settings>('GET', '/api/settings');
    const changed = await fetch(base + '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ expectedRevision: current.revision, accessPassword: 'new-password' }),
    });
    assert.equal(changed.status, 200);
    await changed.arrayBuffer();
    await closed;
    await request('GET', '/api/conversations', undefined, 401);
    cookie = changed.headers.get('set-cookie')!.split(';')[0]!;
    await request('POST', '/api/auth/logout');
    await request('GET', '/api/conversations', undefined, 401);
  });
  await step('SIGTERM saves an unfinished generation before SQLite closes', async () => {
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'new-password' }),
    });
    assert.equal(login.status, 200);
    await login.arrayBuffer();
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const viewer = await connect();
    const shutdown = await request<{ id: number }>('POST', '/api/conversations', {});
    viewer.socket.send(JSON.stringify({ sub: shutdown.id }));
    await viewer.wait((event) => event.t === 'tree');
    hold = true;
    const active = await request<{ assistantMessageId: number }>(
      'POST',
      `/api/conversations/${shutdown.id}/messages`,
      { ...guard(await tree(shutdown.id)), content: 'Save this unfinished reply' },
    );
    await viewer.wait((event) => event.t === 'delta' && event.mid === active.assistantMessageId);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, logs);
    const { Database } = await import('bun:sqlite');
    using saved = new Database(process.env.DB_PATH!, { readonly: true });
    assert.deepEqual(
      saved.query('SELECT content,status FROM messages WHERE id=?').get(active.assistantMessageId),
      { content: 'Hello', status: 'stopped' },
    );
  });
}, 8_000);
