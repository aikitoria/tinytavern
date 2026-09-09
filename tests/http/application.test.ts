import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { test, onTestFinished } from 'bun:test';
import { preparePromptTrace, type PromptTrace, type PromptMessage } from '@tinytavern/shared';
import type { Endpoint, ServerEvent, Settings, TreeSnapshot } from '@tinytavern/shared';
import { requireTestIsolation } from '../support/isolation.ts';

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
  const completionRequests: { messages: PromptMessage[]; stream: boolean }[] = [];
  const delta = (res: ServerResponse, content: string) =>
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  const finish = (res: ServerResponse) => {
    delta(res, 'world');
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
      for (const mode of ['deepseek', 'disabled'] as const) {
        await request('PATCH', `/api/endpoints/${endpoint.id}`, { prefillMode: mode });
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
          mode === 'disabled' ? null : 'Endpoint reasoning\nTemplate reasoning',
        );
        const pendingMessage = `  Pending ${mode} {{char}} $&\nSecond line  `;
        const preview = preparePromptTrace(trace, pendingMessage);
        const pending = preview.messages[preview.pendingMessageIndex!]!;
        assert(pending.content.includes(`Trace user: ${pendingMessage.trim()}`));
        if (mode === 'deepseek') {
          assert.equal(pending.content, `Prologue\n\nTrace user: ${pendingMessage.trim()}`);
          assert.deepEqual(preview.messages.at(-1), {
            role: 'assistant',
            content: 'Guest: Template reply',
            reasoning_content: 'Endpoint reasoning\nTemplate reasoning',
            prefix: true,
          });
        } else {
          assert.equal(preview.prefillMessageIndex, null);
          assert.equal(
            pending.content,
            `Trace user: ${pendingMessage.trim()}\n[System Note]\nReply as Guest.`,
          );
          assert(
            trace.messages.some(
              (message) => message.reasoning_content === 'Endpoint reasoning\nTemplate reasoning',
            ),
            'Historical reasoning remains visible when new prefills are disabled',
          );
        }
        const start = completionRequests.length;
        const sent = await request<{ assistantMessageId: number }>(
          'POST',
          `/api/conversations/${chat.id}/messages`,
          {
            ...guard(before),
            content: pendingMessage,
          },
        );
        await viewer.wait(
          (event) => event.t === 'final' && event.message.id === sent.assistantMessageId,
        );
        const actual = completionRequests.slice(start).find((entry) => entry.stream)!;
        assert.deepEqual(
          preview.messages,
          actual.messages,
          `${mode}: trace must match the actual upstream messages`,
        );
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
