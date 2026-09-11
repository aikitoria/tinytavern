import { mockComfy, serveComfy, comfyEvent } from '../support/comfy.ts';
import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('media description', async () => {
  const { setTimeout: sleep } = await import('node:timers/promises');

  const { compileMediaWorkflow, expandMediaWorkflow, mediaWorkflowError } =
    await import('@tinytavern/shared');
  const { requireTestIsolation } = await import('../support/isolation.ts');

  const { IMAGE_DESCRIPTION_WORKFLOW } = await import('../support/imageDescriptionWorkflow.ts');

  requireTestIsolation();
  process.env.COMFY_POLL_MS = '30';
  const { stmt, mediaAssetForPath } = await import('../../server/src/db/db.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const { saveImage } = await import('../../server/src/media/images.ts');
  const { getSettings, putSettings } = await import('../../server/src/settings/settingsStore.ts');
  const { describeImage, descriptionWorkflow } =
    await import('../../server/src/media/mediaDescription.ts');
  const { initMediaWorker, stopMediaWorker, tickMediaWorker } =
    await import('../../server/src/media/mediaWorker.ts');
  const { comfyTextOutput } = await import('../../server/src/media/comfy/comfyTextOutput.ts');
  const { apiRoutes } = await import('../../server/src/http/router.ts');
  await import('../../server/src/routes/gallery.ts');

  assert.deepEqual(getSettings().mediaRendering.workflows, []);
  assert.equal(getSettings().mediaRendering.descriptionWorkflowId, null);
  assert.throws(() => descriptionWorkflow(), /Add a Describe image workflow/);

  assert.equal(mediaWorkflowError(IMAGE_DESCRIPTION_WORKFLOW), null);
  const compiled = compileMediaWorkflow(IMAGE_DESCRIPTION_WORKFLOW.json);
  const expanded = expandMediaWorkflow(compiled, {
    input1: 'uploaded.png',
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
  let mode: 'success' | 'empty' | 'running' = 'success';
  let posted = 0;
  const protocol = mockComfy({
    upload(file) {
      assert.equal(file.subfolder, '');
      uploads.set(file.name, file.data);
    },
    submit(body, execution) {
      posted++;
      assert(
        uploads.has(String(body.prompt['2']!.inputs.image)),
        'The image reaches Comfy before submission',
      );
      assert(comfy.sockets.has(body.client_id), 'Progress is connected before submission');
      execution.state = 'running';
      execution.outputs = {
        '4': {
          text: [
            mode === 'empty' ? '' : '  A detailed uploaded image description.\nSecond line.  ',
          ],
        },
      };
      const socket = comfy.sockets.get(body.client_id)!;
      comfyEvent(socket, 'execution_start', body.prompt_id);
      comfyEvent(socket, 'executing', body.prompt_id, { node: '3', display_node: '3' });
      comfyEvent(socket, 'progress', body.prompt_id, { value: 16, max: 512 });
      if (mode !== 'running') {
        setTimeout(() => {
          execution.state = 'done';
          comfyEvent(socket, 'execution_success', body.prompt_id);
        }, 60);
      }
    },
    view(url, request) {
      assert.equal(request.method, 'DELETE');
      assert.equal(url.searchParams.get('type'), 'input');
      uploads.delete(url.searchParams.get('filename')!);
      return Response.json({});
    },
  });
  const comfy = serveComfy(protocol.fetch);
  putSettings({
    ...getSettings(),
    mediaRendering: {
      ...getSettings().mediaRendering,
      comfyUrl: comfy.url,
      workflows: [IMAGE_DESCRIPTION_WORKFLOW],
      descriptionWorkflowId: IMAGE_DESCRIPTION_WORKFLOW.id,
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
  const http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    routes: apiRoutes(),
    fetch: () => new Response(null, { status: 404 }),
    idleTimeout: 0,
  });
  const apiAddress = { port: http.port };
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
    await until(() => protocol.cancellations.length === 1 && uploads.size === 0);
    assert.equal(stmt('SELECT count(*) AS count FROM media_jobs').get()!.count, 0);
    assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
    assert.deepEqual(comfy.errors, []);
  } finally {
    await stopMediaWorker();
    await Promise.all([comfy.stop(), http.stop(true)]);
  }
});
