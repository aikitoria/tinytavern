import { galleryFixture } from '../support/fixtures.ts';
import { testRequestKey } from '../support/requestKey.ts';
import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('media restart', async () => {
  const { fork, execFile } = await import('node:child_process');
  type ChildProcess = import('node:child_process').ChildProcess;
  const { once } = await import('node:events');

  const { readFileSync } = await import('node:fs');

  const { createServer } = await import('node:http');

  const { basename, join } = await import('node:path');

  const { setTimeout: sleep } = await import('node:timers/promises');

  const { promisify } = await import('node:util');

  type MediaWorkflow = import('@tinytavern/shared').MediaWorkflow;
  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const { stmt, IMAGES_DIR, DATA_DIR, mediaAssetForPath, toMediaAsset } = await import('../../server/src/db/db.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const { saveImage, deleteImageFiles } = await import('../../server/src/media/images.ts');
  const { getSettings, putSettings } = await import('../support/settings.ts');
  const { createMediaJob, startMediaJob } = await import('../../server/src/media/mediaJobs.ts');
  const { requireMediaJob, mediaJobRow } = await import('../../server/src/media/mediaJobStore.ts');

  const videoPath = join(DATA_DIR, 'restart-fixture.webm');
  await promisify(execFile)('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=64x48:r=5:d=0.6',
    '-c:v',
    'libaom-av1',
    '-cpu-used',
    '8',
    '-threads',
    '2',
    '-y',
    videoPath,
  ]);
  const video = readFileSync(videoPath);
  const png = makePlaceholderPng();
  let remoteState: 'queued' | 'running' | 'completed' = 'queued';
  let promptId = '';
  let submissions = 0;
  let uploads = 0;
  let holdSecondDownload = true;
  let allowCleanup = false;
  let deletionFailures = 0;
  const downloads = new Map<string, number>();
  const deleted = new Set<string>();
  let failure: unknown;
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, 'http://localhost');
      const respond = (value: unknown) =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (url.pathname === '/upload/image') {
        uploads++;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const form = await new Response(Buffer.concat(chunks), {
          headers: { 'content-type': req.headers['content-type']! },
        }).formData();
        const file = form.get('image') as File;
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
        respond({ name: file.name, subfolder: String(form.get('subfolder')), type: 'input' });
        return;
      }
      if (url.pathname === '/prompt') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        submissions++;
        promptId = body.prompt_id;
        assert.match(body.prompt.load.inputs.image, /^tinytavern-[a-f0-9-]+-asset-\d+\.png$/);
        // Accepted remotely, but deliberately never acknowledge before the first crash.
        return;
      }
      if (url.pathname === '/queue') {
        respond({
          queue_running: remoteState === 'running' ? [[1, promptId]] : [],
          queue_pending: remoteState === 'queued' ? [[1, promptId]] : [],
        });
        return;
      }
      if (url.pathname.startsWith('/history/')) {
        assert.equal(url.pathname, `/history/${promptId}`);
        const file = (filename: string, type: string) => ({ filename, subfolder: promptId, type });
        respond(
          remoteState === 'completed'
            ? {
                [promptId]: {
                  status: { completed: true, status_str: 'success' },
                  outputs: {
                    save: {
                      videos: [file('first.webm', 'output'), file('second.webm', 'output')],
                      images: [file('preview.png', 'temp')],
                    },
                    inputPreview: { images: [file('pre-existing-input.png', 'input')] },
                  },
                },
              }
            : {},
        );
        return;
      }
      if (url.pathname === '/view') {
        if (req.method === 'DELETE') {
          if (!allowCleanup) {
            deletionFailures++;
            res.writeHead(503).end('retry later');
          } else {
            deleted.add(url.searchParams.toString());
            res.writeHead(204).end();
          }
          return;
        }
        const name = url.searchParams.get('filename')!;
        downloads.set(name, (downloads.get(name) ?? 0) + 1);
        if (name === 'second.webm' && holdSecondDownload) {
          return;
        }
        res.writeHead(200, { 'content-type': 'video/webm' }).end(video);
        return;
      }
      res.writeHead(404).end();
    })().catch((error) => {
      failure = error;
      res.writeHead(500).end('mock failure');
    });
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const workflow: MediaWorkflow = {
    id: 'restart-video',
    name: 'Video from first frame',
    inputBindings: {},
    textOutputNodeId: null,
    standalonePromptPresetId: null,
    chatPromptPresetId: null,
    json: JSON.stringify({
      load: { class_type: 'LoadImage', inputs: { image: '{{input1}}' } },
      save: {
        class_type: 'SaveVideo',
        inputs: { text: '{{prompt}}', filename_prefix: '{{job_id}}' },
      },
    }),
  };
  putSettings({
    ...getSettings(),
    mediaRendering: {
      ...getSettings().mediaRendering,
      comfyUrl: `http://127.0.0.1:${port}`,
      workflows: [workflow],
      defaultWorkflowId: null,
      avatarWorkflowId: null,
      jobTimeoutSeconds: 60,
    },
  });
  const inputPath = saveImage('.png', png);
  galleryFixture(inputPath, { character_name: 'Test', prompt: '' });
  const draft = createMediaJob({
    requestKey: testRequestKey('restart-idempotency'),

    workflowId: workflow.id,
    prompt: 'Slow camera move',
    inputs: [{ slot: 'input1', assetId: mediaAssetForPath(inputPath)!.id }],
  });
  startMediaJob(requireMediaJob(draft.id), {}, false);
  const children = new Set<ChildProcess>();
  let childOutput = '';
  async function launch() {
    const child = fork(join(import.meta.dirname, '../support/media-restart-worker.ts'), {
      env: { ...process.env, COMFY_POLL_MS: '10' },
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.stdout!.on('data', (data) => {
      childOutput += String(data);
    });
    child.stderr!.on('data', (data) => {
      childOutput += String(data);
    });
    await once(child, 'message');
    return child;
  }
  async function crash(child: ChildProcess) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    children.delete(child);
  }
  async function until(check: () => boolean, label: string) {
    const deadline = Date.now() + 3000;
    while (!check()) {
      if (failure) {
        throw failure;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out: ${label}\n${childOutput}`);
      }
      await sleep(10);
    }
  }
  try {
    const first = await launch();
    await until(() => submissions === 1, 'remote acceptance');
    assert.equal(requireMediaJob(draft.id).state, 'reconciling');
    assert.equal(requireMediaJob(draft.id).submission_id, promptId);
    await crash(first);

    const second = await launch();
    await until(() => requireMediaJob(draft.id).state === 'queued', 'queued recovery');
    assert.equal(requireMediaJob(draft.id).comfy_prompt_id, promptId);
    remoteState = 'running';
    await until(() => requireMediaJob(draft.id).state === 'rendering', 'running recovery');
    remoteState = 'completed';
    await until(() => downloads.get('second.webm') === 1, 'partial multi-output download');
    assert.equal(JSON.parse(requireMediaJob(draft.id).outputs_json).length, 1);
    await crash(second);

    // Startup sweep must retain the partial output and a source whose gallery entry was deleted.
    stmt('DELETE FROM gallery_items').run();
    deleteImageFiles([inputPath]);
    holdSecondDownload = false;
    const third = await launch();
    await until(() => !mediaJobRow(draft.id), 'completion and job deletion recovery');
    await until(() => deletionFailures > 0, 'durable cleanup failure');
    await crash(third);
    assert.equal(submissions, 1, 'Lost acknowledgement and two crashes never resubmit Comfy');
    assert.equal(uploads, 1, 'Recorded input upload survives restart');
    assert.equal(downloads.get('first.webm'), 1, 'Already ingested video is not downloaded again');
    assert.equal(downloads.get('second.webm'), 2);
    const outputs = stmt(
      `SELECT a.* FROM media_assets a JOIN media_owners o ON o.asset_id = a.id WHERE o.owner_type = 'gallery'`,
    )
      .all()
      .map(toMediaAsset);
    assert.equal(outputs.length, 2);
    for (const asset of outputs) {
      assert.equal(asset.mime, 'video/webm');
      assert(asset.width === 64 && asset.height === 48);
      assert.deepEqual(readFileSync(join(IMAGES_DIR, basename(asset.url))), video);
    }
    assert.equal(stmt('SELECT count(*) AS n FROM gallery_items').get()!.n, 2);
    assert.equal(mediaJobRow(draft.id), undefined);
    assert.equal(
      stmt('SELECT id FROM media_jobs WHERE request_key = ?').get(testRequestKey('restart-idempotency')),
      null,
    );
    assert.equal(stmt("SELECT count(*) AS n FROM media_remote_files WHERE state != 'deleted'").get()!.n, 4);

    allowCleanup = true;
    const fourth = await launch();
    await until(
      () => stmt("SELECT count(*) AS n FROM media_remote_files WHERE state != 'deleted'").get()!.n === 0,
      'cleanup after history removal and restart',
    );
    await crash(fourth);
    assert.equal(
      stmt('SELECT count(*) AS n FROM media_remote_files').get()!.n,
      0,
      'Confirmed remote cleanup removes its ledger rows after the job is deleted',
    );
    assert.equal(deleted.size, 4, 'Both videos, temporary preview and uploaded input are deleted remotely');
    assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(failure, undefined);
  } finally {
    await Promise.all([...children].map(crash));
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});
