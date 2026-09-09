import assert from 'node:assert/strict';
import { test } from 'node:test';

test('media latency', async () => {
  const { createServer } = await import('node:http');
  type ServerResponse = import('node:http').ServerResponse;
  const { once } = await import('node:events');

  const { setTimeout: sleep } = await import('node:timers/promises');

  const { WebSocketServer } = await import('ws');
  type WebSocket = import('ws').WebSocket;
  const { requireTestIsolation } = await import('../support/isolation.ts');

  type MediaWorkflow = import('@tinytavern/shared').MediaWorkflow;
  const { videoPreviewFrame } = await import('../support/videoPreview.ts');

  requireTestIsolation();
  // No interval tick can rescue a stalled transition in this test.
  process.env.COMFY_POLL_MS = '60000';
  const { stmt } = await import('../../server/src/db.ts');
  const { makePlaceholderPng } = await import('../../server/src/pngCard.ts');
  const { getSettings, putSettings } = await import('../../server/src/settingsStore.ts');
  const { createMediaJob, startMediaJob } = await import('../../server/src/mediaJobs.ts');
  const { requireMediaJob, mediaLive, observeMediaJob } =
    await import('../../server/src/mediaJobStore.ts');
  const { initMediaWorker, tickMediaWorker, stopMediaWorker } =
    await import('../../server/src/mediaWorker.ts');

  const sockets = new Map<string, WebSocket>();
  const submissions = new Map<
    string,
    { response: ServerResponse; promptId: string; connected: boolean }
  >();
  const videoJobs = new Set<string>();
  const previews = new Map<string, { time: number; state: string; value?: number }>();
  const frame = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 2]), makePlaceholderPng()]);
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://test').pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (path === '/v1/chat/completions') {
      response.setHeader('content-type', 'text/event-stream');
      response.end(
        'data: {"choices":[{"delta":{"content":"Prepared image prompt"}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
      );
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (path === '/prompt') {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const socket = sockets.get(body.client_id);
      const extra = body.extra_data.extra_pnginfo.workflow.extra;
      assert.equal(body.extra_data.preview_method, 'taesd');
      assert.equal(extra.VHS_MetadataImage, false);
      assert.equal(extra.VHS_KeepIntermediate, false);
      assert.equal(extra.VHS_latentpreview, videoJobs.has(body.client_id));
      assert.equal(extra.VHS_latentpreviewrate, 0);
      submissions.set(body.client_id, {
        response,
        promptId: body.prompt_id,
        connected: Boolean(socket),
      });
      socket?.send(
        JSON.stringify({ type: 'execution_start', data: { prompt_id: body.prompt_id } }),
      );
      socket?.send(
        JSON.stringify({
          type: 'execution_cached',
          data: { prompt_id: body.prompt_id, nodes: ['loader'] },
        }),
      );
      socket?.send(
        JSON.stringify({ type: 'executing', data: { prompt_id: body.prompt_id, node: 'sampler' } }),
      );
      socket?.send(
        JSON.stringify({
          type: 'progress',
          data: { prompt_id: body.prompt_id, value: 1, max: 20 },
        }),
      );
      if (videoJobs.has(body.client_id)) {
        socket?.send(
          JSON.stringify({
            type: 'executing',
            data: { prompt_id: body.prompt_id, node: 'subgraph', display_node: 'sampler' },
          }),
        );
        socket?.send(
          JSON.stringify({
            type: 'progress',
            data: { prompt_id: body.prompt_id, value: 1, max: 20 },
          }),
        );
        // VHS broadcasts its metadata without a prompt ID to every connected Comfy client.
        for (const connection of sockets.values()) {
          connection.send(
            JSON.stringify({
              type: 'VHS_latentpreview',
              data: { id: 'sampler', length: 3, rate: 6 },
            }),
          );
        }
        socket?.send(videoPreviewFrame(0));
        socket?.send(videoPreviewFrame(1));
        socket?.send(videoPreviewFrame(2));
      } else {
        socket?.send(frame);
      }
      socket?.send(
        JSON.stringify({
          type: 'progress',
          data: { prompt_id: body.prompt_id, value: 2, max: 20 },
        }),
      );
      socket?.send(
        JSON.stringify({
          type: 'progress_state',
          data: {
            prompt_id: body.prompt_id,
            nodes: { sampler: { state: 'running', value: 2, max: 20, display_node_id: 'sampler' } },
          },
        }),
      );
      // The test releases acceptance after checking the first preview and running state.
      return;
    }
    if (path === '/queue') {
      response.end(
        JSON.stringify({
          queue_running: [],
          // Simulate a queue snapshot overtaken by the execution-start WebSocket frame.
          queue_pending: [...submissions.values()].map((item) => [0, item.promptId]),
        }),
      );
      return;
    }
    response.end('{}');
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    // A slower handshake makes submitting before socket readiness fail deterministically.
    setTimeout(() => {
      wss.handleUpgrade(request, socket, head, (connection) => {
        sockets.set(new URL(request.url!, 'http://test').searchParams.get('clientId')!, connection);
      });
    }, 50);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const workflow: MediaWorkflow = {
    id: 'latency',
    name: 'Latency',
    operation: 'image',
    referenceCount: 0,
    json: '{"loader":{"class_type":"Loader","inputs":{}},"sampler":{"class_type":"Test","_meta":{"title":"Motion sampler"},"inputs":{"model":["loader",0],"prompt":"{{prompt}}","seed":{{seed}}}}}',
    galleryPromptPresetId: null,
    chatPromptPresetId: null,
  };
  const endpointId = Number(
    stmt(`INSERT INTO endpoints(name, base_url, model, created_at)
  VALUES ('Latency', ?, 'test', 1)`).run(`${base}/v1`).lastInsertRowid,
  );
  putSettings({
    ...getSettings(),
    activeEndpointId: endpointId,
    mediaRendering: {
      ...getSettings().mediaRendering,
      comfyUrl: base,
      workflows: [workflow, { ...workflow, id: 'video', operation: 'video' }],
      defaults: { 'image:0': workflow.id, 'video:0': 'video' },
    },
  });
  const subscriptions: (() => void)[] = [];
  async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 1500;
    while (!condition()) {
      assert(Date.now() < deadline, 'Job waited for a polling interval');
      await sleep(5);
    }
  }

  try {
    initMediaWorker();
    for (const mode of ['render', 'prepare-and-render', 'prepare-then-render', 'video']) {
      const job = createMediaJob({
        requestKey: mode,
        operation: mode === 'video' ? 'video' : 'image',
        prompt: 'Image prompt',
        instruction: 'Create an image',
        destination: 'gallery',
      });
      if (mode === 'video') videoJobs.add(job.id);
      subscriptions.push(
        observeMediaJob(job.id, (row) => {
          const progress = mediaLive.get(job.id)?.progress;
          if ((progress?.preview || progress?.videoPreview?.frames[0]) && !previews.has(job.id)) {
            previews.set(job.id, {
              time: performance.now(),
              state: row.state,
              value: mediaLive.get(job.id)?.progress?.value,
            });
          }
        }),
      );
      const began = performance.now();
      startMediaJob(
        requireMediaJob(job.id),
        { autoRender: mode === 'prepare-and-render' },
        mode !== 'render' && mode !== 'video',
      );
      tickMediaWorker();
      if (mode === 'prepare-then-render') {
        await waitFor(() => requireMediaJob(job.id).state === 'ready');
        startMediaJob(requireMediaJob(job.id), {}, false);
        tickMediaWorker();
      }
      await waitFor(() => submissions.has(job.id));
      await waitFor(() => mediaLive.get(job.id)?.progress?.value === 2);
      assert.deepEqual(mediaLive.get(job.id)?.progress?.graph, { value: 1, max: 2 });
      assert.equal(mediaLive.get(job.id)?.progress?.node?.name, 'Motion sampler');
      const submission = submissions.get(job.id)!;
      assert(submission.connected, 'The first Comfy step must have a connected preview listener');
      await waitFor(() => previews.has(job.id));
      assert.equal(
        previews.get(job.id)!.value,
        1,
        'The first preview is forwarded before later sampler steps',
      );
      assert.equal(
        previews.get(job.id)!.state,
        'rendering',
        'Execution start is visible before submission responds',
      );
      assert(
        !submission.response.writableEnded,
        'First preview does not wait for the submission response',
      );
      if (mode === 'video') {
        await waitFor(
          () =>
            Object.keys(mediaLive.get(job.id)?.progress?.videoPreview?.frames ?? {}).length === 3,
        );
        for (const otherId of submissions.keys()) {
          if (otherId !== job.id) assert(!mediaLive.get(otherId)?.progress?.videoPreview);
        }
        const clipId = mediaLive.get(job.id)!.progress!.videoPreview!.id;
        sockets.get(job.id)!.send(
          JSON.stringify({
            type: 'VHS_latentpreview',
            data: { id: 'unrelated', length: 3, rate: 6 },
          }),
        );
        sockets.get(job.id)!.send(videoPreviewFrame(0, 'unrelated'));
        await sleep(60);
        assert.equal(mediaLive.get(job.id)!.progress!.videoPreview!.id, clipId);
      }
      submission.response.end(JSON.stringify({ prompt_id: submission.promptId }));
      await waitFor(
        () =>
          requireMediaJob(job.id).state === 'rendering' &&
          requireMediaJob(job.id).comfy_prompt_id === submission.promptId,
      );
      await sleep(20);
      assert.equal(
        requireMediaJob(job.id).state,
        'rendering',
        'Acceptance must not move an executing job back to queued',
      );
    }
  } finally {
    for (const unsubscribe of subscriptions) unsubscribe();
    stopMediaWorker();
    for (const socket of sockets.values()) socket.terminate();
    for (const submission of submissions.values()) submission.response.destroy();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
