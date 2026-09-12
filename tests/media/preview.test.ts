import { serveComfy, comfyEvent, type ComfyPrompt } from '../support/comfy.ts';
import { testRequestKey } from '../support/requestKey.ts';
import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('media latency', async () => {
  const { setTimeout: sleep } = await import('node:timers/promises');
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  type ChildProcess = import('node:child_process').ChildProcess;
  type MediaProgress = import('@tinytavern/shared').MediaProgress;

  const { requireTestIsolation } = await import('../support/isolation.ts');

  type MediaWorkflow = import('@tinytavern/shared').MediaWorkflow;
  const { videoPreviewFrame } = await import('../support/videoPreview.ts');

  requireTestIsolation();
  // No interval tick can rescue a stalled transition in this test.
  process.env.COMFY_POLL_MS = '60000';
  const { stmt } = await import('../../server/src/db/db.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const { getSettings, putSettings } = await import('../../server/src/settings/settingsStore.ts');
  const { createMediaJob, startMediaJob } = await import('../../server/src/media/mediaJobs.ts');
  const { requireMediaJob, mediaLive, observeMediaJob, mediaJobDto, activeMediaJobs } =
    await import('../../server/src/media/mediaJobStore.ts');
  const { initMediaWorker, tickMediaWorker, stopMediaWorker } =
    await import('../../server/src/media/mediaWorker.ts');

  const submissions = new Map<
    number,
    { accept: (response: Response) => void; promptId: string; connected: boolean }
  >();
  const videoJobs = new Set<number>();
  let submissionAttempts = 0;
  let recoveredWorker: ChildProcess | undefined;
  const previews = new Map<number, { time: number; state: string; value?: number }>();
  const frame = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 2]), makePlaceholderPng()]);
  const server = serveComfy(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/v1/chat/completions') {
      return new Response(
        'data: {"choices":[{"delta":{"content":"Prepared image prompt"}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }

    if (path === '/prompt') {
      submissionAttempts++;
      let accept!: (response: Response) => void;
      const result = new Promise<Response>((resolve) => {
        accept = resolve;
      });
      const body = (await request.json()) as ComfyPrompt;
      const socket = server.sockets.get(body.client_id);
      const extra = body.extra_data.extra_pnginfo.workflow.extra;
      assert.equal(body.extra_data.preview_method, 'taesd');
      assert.equal(extra.VHS_MetadataImage, false);
      assert.equal(extra.VHS_KeepIntermediate, false);
      assert.equal(extra.VHS_latentpreview, true);
      assert.equal(extra.VHS_latentpreviewrate, 0);
      submissions.set(body.extra_data.tinytavern_job_id, {
        accept,
        promptId: body.prompt_id,
        connected: Boolean(socket),
      });
      comfyEvent(socket, 'execution_start', body.prompt_id);
      comfyEvent(socket, 'execution_cached', body.prompt_id, { nodes: ['loader'] });
      comfyEvent(socket, 'executing', body.prompt_id, { node: 'sampler' });
      comfyEvent(socket, 'progress', body.prompt_id, { value: 1, max: 20 });
      if (videoJobs.has(body.extra_data.tinytavern_job_id)) {
        comfyEvent(socket, 'executing', body.prompt_id, {
          node: 'subgraph',
          display_node: 'sampler',
        });
        comfyEvent(socket, 'progress', body.prompt_id, { value: 1, max: 20 });
        // VHS broadcasts its metadata without a prompt ID to every connected Comfy client.
        for (const connection of server.sockets.values()) {
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
      comfyEvent(socket, 'progress', body.prompt_id, { value: 2, max: 20 });
      comfyEvent(socket, 'progress_state', body.prompt_id, {
        nodes: { sampler: { state: 'running', value: 2, max: 20, display_node_id: 'sampler' } },
      });
      // The test releases acceptance after checking the first preview and running state.
      return result;
    }
    if (path === '/queue') {
      return Response.json({
        queue_running: [],
        // Simulate a queue snapshot overtaken by the execution-start WebSocket frame.
        queue_pending: [...submissions.values()].map((item) => [0, item.promptId]),
      });
    }
    return Response.json({});
  }, 50);
  const base = server.url;
  const workflow: MediaWorkflow = {
    id: 'latency',
    name: 'Latency',
    inputBindings: {},
    textOutputNodeId: null,
    json: '{"loader":{"class_type":"Loader","inputs":{}},"sampler":{"class_type":"Test","_meta":{"title":"Motion sampler"},"inputs":{"model":["loader",0],"prompt":"{{prompt}}","seed":0}}}',
    standalonePromptPresetId: null,
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
      workflows: [workflow, { ...workflow, id: 'video', name: 'Video' }],
      defaultWorkflowId: workflow.id,
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
        requestKey: testRequestKey(mode),
        workflowId:
          mode === 'video'
            ? getSettings().mediaRendering.workflows.find((item) => item.name === 'Video')!.id
            : workflow.id,
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
      if (mode === 'video') {
        await waitFor(
          () =>
            Object.keys(mediaLive.get(job.id)?.progress?.videoPreview?.frames ?? {}).length === 3,
        );
        for (const otherId of submissions.keys()) {
          if (otherId !== job.id) assert(!mediaLive.get(otherId)?.progress?.videoPreview);
        }
        const clipId = mediaLive.get(job.id)!.progress!.videoPreview!.id;
        server.sockets.get(requireMediaJob(job.id).request_key!)!.send(
          JSON.stringify({
            type: 'VHS_latentpreview',
            data: { id: 'unrelated', length: 3, rate: 6 },
          }),
        );
        server.sockets
          .get(requireMediaJob(job.id).request_key!)!
          .send(videoPreviewFrame(0, 'unrelated'));
        await sleep(60);
        assert.equal(mediaLive.get(job.id)!.progress!.videoPreview!.id, clipId);
      }
      submission.accept(Response.json({ prompt_id: submission.promptId }));
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
    const videoJobId = [...videoJobs][0]!;
    const videoJob = requireMediaJob(videoJobId);
    const header = JSON.parse(videoJob.configuration_json!).videoPreview;
    assert.deepEqual(
      header,
      {
        id: mediaLive.get(videoJobId)!.progress!.videoPreview!.id,
        nodeId: 'sampler',
        frameCount: 3,
        frameRate: 6,
      },
      'Persist only the one-time VHS header, never frame bytes',
    );
    assert.equal(
      Object.keys(mediaJobDto(videoJob).progress!.videoPreview!.frames).length,
      3,
      'Refreshing a browser receives the complete in-memory frame cache',
    );
    assert.equal(
      Object.keys(
        activeMediaJobs().find((job) => job.id === videoJobId)!.progress!.videoPreview!.frames,
      ).length,
      3,
      'The initial WebSocket snapshot includes the cached video preview',
    );

    stopMediaWorker();
    await waitFor(() => server.sockets.size === 0);
    const updates: MediaProgress[] = [];
    recoveredWorker = fork('tests/support/media-restart-worker.ts', [], {
      env: { ...process.env, COMFY_POLL_MS: '50' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    recoveredWorker.on('message', (message) => {
      const update = message as { id?: number; progress?: MediaProgress };
      if (update?.id === videoJobId && update.progress) updates.push(update.progress);
    });
    await once(recoveredWorker, 'message');
    recoveredWorker.send(videoJobId);
    await waitFor(() => server.sockets.has(videoJob.request_key!));
    const resumedSocket = server.sockets.get(videoJob.request_key!)!;
    // Comfy replays only the executing node, without prompt_id or the VHS header.
    resumedSocket.send(JSON.stringify({ type: 'executing', data: { node: 'sampler' } }));
    resumedSocket.send(videoPreviewFrame(1));
    await waitFor(() => Boolean(updates.at(-1)?.videoPreview?.frames[1]));
    assert.equal(
      updates.at(-1)!.videoPreview!.id,
      header.id,
      'A fresh worker resumes the original preview without another metadata event',
    );

    resumedSocket.close();
    await waitFor(() => {
      const current = server.sockets.get(videoJob.request_key!);
      return Boolean(current && current !== resumedSocket);
    });
    const reconnectedSocket = server.sockets.get(videoJob.request_key!)!;
    reconnectedSocket.send(JSON.stringify({ type: 'executing', data: { node: 'sampler' } }));
    reconnectedSocket.send(videoPreviewFrame(0));
    await waitFor(() => Boolean(updates.at(-1)?.videoPreview?.frames[0]));
    assert.deepEqual(
      Object.keys(updates.at(-1)!.videoPreview!.frames),
      ['0'],
      'Frame zero starts a new denoise sequence after reconnect, without mixing old frames',
    );
    reconnectedSocket.send(JSON.stringify({ type: 'executing', data: { node: 'next-sampler' } }));
    reconnectedSocket.send(videoPreviewFrame(2, 'next-sampler'));
    await waitFor(() => Boolean(updates.at(-1)?.preview));
    assert.equal(
      updates.at(-1)!.videoPreview,
      null,
      'An already-running sampler with no recoverable header still shows its arriving JPEG',
    );
    assert.equal(
      JSON.parse(requireMediaJob(videoJobId).configuration_json!).videoPreview,
      undefined,
      'Changing samplers discards the previous persisted header',
    );
    reconnectedSocket.send(
      JSON.stringify({
        type: 'VHS_latentpreview',
        data: { id: 'next-sampler', length: 3, rate: 6 },
      }),
    );
    reconnectedSocket.send(videoPreviewFrame(1, 'next-sampler'));
    await waitFor(() => Boolean(updates.at(-1)?.videoPreview?.frames[1]));
    assert.notEqual(updates.at(-1)!.videoPreview!.id, header.id);
    assert.deepEqual(
      Object.keys(updates.at(-1)!.videoPreview!.frames),
      ['1'],
      'The next complete header restores animated playback without retaining old sampler frames',
    );
    assert.equal(submissionAttempts, 4, 'Preview recovery never resubmits the render');
    assert.deepEqual(server.errors, []);
  } finally {
    if (recoveredWorker && recoveredWorker.exitCode === null) {
      recoveredWorker.kill('SIGKILL');
      await once(recoveredWorker, 'exit');
    }
    for (const unsubscribe of subscriptions) unsubscribe();
    stopMediaWorker();
    for (const submission of submissions.values())
      submission.accept(new Response(null, { status: 503 }));
    await server.stop();
  }
});
