import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import type { ServerEvent, Settings, TreeSnapshot } from '@tinytavern/shared';
import { requireTestIsolation } from '../support/isolation.ts';

// Exercise the public boundary once; feature suites cover combinations directly.
test('application HTTP and WebSocket contracts', { timeout: 8_000 }, async (t) => {
  requireTestIsolation();
  const base = 'http://127.0.0.1:15487';
  const sockets: WebSocket[] = [];
  const arrivals = new EventEmitter();
  let held: ServerResponse | undefined;
  let hold = true;
  let upstreamStatus = 200;
  const delta = (res: ServerResponse, content: string) =>
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  const finish = (res: ServerResponse) => {
    delta(res, 'world');
    res.end('data: [DONE]\n\n');
  };
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume the real request body */
    }
    if (req.url?.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return;
    }
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
  t.after(async () => {
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
      origin,
      headers: { cookie },
    });
    sockets.push(socket);
    socket.on('error', () => {});
    const events: ServerEvent[] = [];
    const notifications = new EventEmitter();
    socket.on('message', (data) => {
      events.push(JSON.parse(data.toString()) as ServerEvent);
      notifications.emit('event');
    });
    const status = await new Promise<number>((resolve) => {
      socket.once('open', () => resolve(101));
      socket.once('unexpected-response', (_req, response) => {
        response.resume();
        socket.terminate();
        resolve(response.statusCode!);
      });
    });
    assert.equal(status, expected);
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

  await t.test('origin checks, endpoint secrets and optimistic settings writes', async () => {
    const hostile = await fetch(base + '/api/settings', {
      headers: { origin: 'http://attacker.invalid' },
    });
    assert.equal(hostile.status, 403);
    await hostile.arrayBuffer();
    await connect('http://attacker.invalid', 403);
    const endpoint = await request<{ id: number }>('POST', '/api/endpoints', {
      name: 'Test',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'private-key',
      model: 'test-model',
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
  await t.test('streaming, reconnect snapshots, live export and peer consistency', async () => {
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

  await t.test('incremental edits, stale same-leaf writes and branch restoration', async () => {
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

  await t.test(
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

  await t.test(
    'cancellation persists partial content and upstream failures terminate',
    async () => {
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
    },
  );

  await t.test('password sessions, protected media, logout and socket revocation', async () => {
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
});
