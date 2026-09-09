import assert from 'node:assert/strict';
import { test } from 'node:test';

test('media description', async () => {
  const { createServer } = await import('node:http');

  const { once } = await import('node:events');

  const { setTimeout: sleep } = await import('node:timers/promises');

  const { WebSocketServer } = await import('ws');
  type WebSocket = import('ws').WebSocket;
  const { compileMediaWorkflow, expandMediaWorkflow, mediaWorkflowError } =
    await import('@tinytavern/shared');
  type ImageDescriptionProgress = import('@tinytavern/shared').ImageDescriptionProgress;
  const { requireTestIsolation } = await import('../support/isolation.ts');

  const { IMAGE_DESCRIPTION_WORKFLOW } = await import('../support/imageDescriptionWorkflow.ts');

  requireTestIsolation();
  process.env.COMFY_POLL_MS = '30';
  const { stmt, mediaAssetForPath } = await import('../../server/src/db.ts');
  const { makePlaceholderPng } = await import('../../server/src/pngCard.ts');
  const { saveImage } = await import('../../server/src/images.ts');
  const { getSettings, putSettings } = await import('../../server/src/settingsStore.ts');
  const { describeImage, descriptionWorkflow } =
    await import('../../server/src/mediaDescription.ts');
  const { initMediaWorker, stopMediaWorker, tickMediaWorker } =
    await import('../../server/src/mediaWorker.ts');
  const { comfyTextOutput } = await import('../../server/src/comfyTextOutput.ts');
  const { dispatch } = await import('../../server/src/router.ts');
  await import('../../server/src/routes/gallery.ts');

  assert.deepEqual(getSettings().mediaRendering.workflows, []);
  assert.deepEqual(getSettings().mediaRendering.defaults, {});
  assert.throws(() => descriptionWorkflow(), /Add a Describe image workflow/);

  assert.equal(mediaWorkflowError(IMAGE_DESCRIPTION_WORKFLOW), null);
  const compiled = compileMediaWorkflow(IMAGE_DESCRIPTION_WORKFLOW.json);
  const expanded = expandMediaWorkflow(compiled, {
    source: 'uploaded.png',
    seed: 12345,
    prompt: '',
    job_id: 'test',
  }) as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(expanded['2']!.inputs.image, 'uploaded.png');
  assert.equal(expanded['3']!.inputs['sampling_mode.seed'], 12345);
  assert.equal(
    expanded['3']!.inputs.prompt,
    JSON.parse(IMAGE_DESCRIPTION_WORKFLOW.json)['3'].inputs.prompt,
  );
  assert.equal(comfyTextOutput({ '4': { text: ['  Exact\ntext  '] } }), '  Exact\ntext  ');
  for (const output of [
    {},
    { '4': { text: [''] } },
    { '4': { text: [3] } },
    { '4': { text: ['a', 'b'] } },
    { '4': { text: ['a'] }, '5': { text: ['b'] } },
  ]) {
    assert.throws(() => comfyTextOutput(output));
  }

  const uploads = new Map<string, Buffer>();
  const removed: string[] = [];
  const sockets = new Map<string, WebSocket>();
  const executions = new Map<
    string,
    { client: string; done: boolean; cancelled: boolean; output: unknown }
  >();
  let mode: 'success' | 'empty' | 'running' = 'success';
  let posted = 0;
  let cancelled = 0;
  let failDelete = false;
  const errors: unknown[] = [];
  const comfy = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, 'http://test');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks);
      response.setHeader('content-type', 'application/json');
      if (url.pathname === '/upload/image') {
        const form = await new Response(data, {
          headers: { 'content-type': request.headers['content-type']! },
        }).formData();
        const file = form.get('image') as File;
        assert.equal(form.get('subfolder'), '');
        uploads.set(file.name, Buffer.from(await file.arrayBuffer()));
        response.end(JSON.stringify({ name: file.name, subfolder: '', type: 'input' }));
      } else if (url.pathname === '/prompt') {
        const body = JSON.parse(data.toString());
        posted++;
        assert(
          uploads.has(body.prompt['2'].inputs.image),
          'The image reaches Comfy before submission',
        );
        assert(sockets.has(body.client_id), 'Progress is connected before submission');
        const execution = {
          client: body.client_id,
          done: false,
          cancelled: false,
          output: {
            '4': {
              text: [
                mode === 'empty' ? '' : '  A detailed uploaded image description.\nSecond line.  ',
              ],
            },
          },
        };
        executions.set(body.prompt_id, execution);
        response.end(JSON.stringify({ prompt_id: body.prompt_id }));
        const socket = sockets.get(body.client_id)!;
        socket.send(
          JSON.stringify({ type: 'execution_start', data: { prompt_id: body.prompt_id } }),
        );
        socket.send(
          JSON.stringify({
            type: 'executing',
            data: { prompt_id: body.prompt_id, node: '3', display_node: '3' },
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'progress',
            data: { prompt_id: body.prompt_id, value: 16, max: 512 },
          }),
        );
        if (mode !== 'running') {
          setTimeout(() => {
            execution.done = true;
            socket.send(
              JSON.stringify({ type: 'execution_success', data: { prompt_id: body.prompt_id } }),
            );
          }, 60);
        }
      } else if (url.pathname.startsWith('/history/')) {
        const id = url.pathname.slice('/history/'.length);
        const execution = executions.get(id);
        response.end(
          JSON.stringify(
            execution?.done
              ? {
                  [id]: {
                    status: {
                      completed: true,
                      status_str: execution.cancelled ? 'error' : 'success',
                    },
                    outputs: execution.cancelled ? {} : execution.output,
                  },
                }
              : {},
          ),
        );
      } else if (url.pathname === '/queue') {
        response.end(
          JSON.stringify({
            queue_running: [...executions].filter(([, item]) => !item.done).map(([id]) => [0, id]),
            queue_pending: [],
          }),
        );
      } else if (url.pathname.endsWith('/cancel')) {
        const execution = executions.get(url.pathname.split('/')[3]!)!;
        execution.cancelled = true;
        execution.done = true;
        cancelled++;
        response.end('{}');
      } else if (url.pathname === '/view' && request.method === 'DELETE') {
        if (failDelete) {
          failDelete = false;
          response.writeHead(503).end('{}');
          return;
        }
        const name = url.searchParams.get('filename')!;
        assert.equal(url.searchParams.get('type'), 'input');
        removed.push(name);
        uploads.delete(name);
        response.end('{}');
      } else response.writeHead(404).end('{}');
    } catch (err) {
      errors.push(err);
      response.writeHead(500).end('{}');
    }
  });
  const websocket = new WebSocketServer({ server: comfy });
  websocket.on('connection', (socket, request) => {
    sockets.set(new URL(request.url!, 'http://test').searchParams.get('clientId')!, socket);
  });
  comfy.listen(0, '127.0.0.1');
  await once(comfy, 'listening');
  const address = comfy.address();
  assert(address && typeof address !== 'string');
  putSettings({
    ...getSettings(),
    mediaRendering: {
      ...getSettings().mediaRendering,
      comfyUrl: `http://127.0.0.1:${address.port}`,
      workflows: [IMAGE_DESCRIPTION_WORKFLOW],
      defaults: { 'image-describe:0': IMAGE_DESCRIPTION_WORKFLOW.id },
    },
  });
  const path = saveImage('.png', makePlaceholderPng());
  const id = Number(
    stmt(
      "INSERT INTO gallery_items(character_name, prompt, image, created_at, updated_at) VALUES ('Uploads', 'Saved before generation', ?, 1, 1)",
    ).run(path).lastInsertRowid,
  );
  const assetId = mediaAssetForPath(path)!.id;
  async function until(condition: () => boolean) {
    const end = Date.now() + 6000;
    while (!condition() && Date.now() < end) {
      tickMediaWorker();
      await sleep(20);
    }
    assert(condition(), 'Condition completed before timeout');
  }
  const http = createServer((request, response) => {
    void dispatch(request, response, new URL(request.url!, 'http://test').pathname);
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const apiAddress = http.address();
  assert(apiAddress && typeof apiAddress !== 'string');
  try {
    initMediaWorker();
    const response = await fetch(`http://127.0.0.1:${apiAddress.port}/api/gallery/${id}/describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const events = await response.text();
    assert.equal(response.status, 200);
    assert(
      events.includes('"progress"') &&
        events.includes('"d":"  A detailed') &&
        events.includes('"done":true'),
    );
    assert.equal(
      stmt('SELECT prompt FROM gallery_items WHERE id = ?').get(id)!.prompt,
      'Saved before generation',
    );
    await until(() => uploads.size === 0);

    mode = 'empty';
    await assert.rejects(
      describeImage(assetId, descriptionWorkflow(), new AbortController().signal, () => {}),
      /empty/,
    );
    await until(() => uploads.size === 0);
    mode = 'running';
    const abort = new AbortController();
    const before = posted;
    const pending = describeImage(assetId, descriptionWorkflow(), abort.signal, () => {});
    const rejection = assert.rejects(pending);
    await until(() => posted > before);
    abort.abort();
    await rejection;
    await until(() => cancelled === 1 && uploads.size === 0);
    assert.equal(stmt('SELECT count(*) AS count FROM media_jobs').get()!.count, 0);
    assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
    assert.deepEqual(errors, []);
  } finally {
    await stopMediaWorker();
    for (const socket of sockets.values()) socket.terminate();
    websocket.close();
    comfy.closeAllConnections();
    http.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => comfy.close(resolve)),
      new Promise((resolve) => http.close(resolve)),
    ]);
  }
});
