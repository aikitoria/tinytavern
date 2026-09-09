import { mockComfy } from '../support/comfy.ts';
import { testRequestKey } from '../support/requestKey.ts';
import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('media jobs', async () => {
  const { existsSync, readFileSync } = await import('node:fs');

  const { basename, join } = await import('node:path');

  const { setTimeout: sleep } = await import('node:timers/promises');

  const { requireTestIsolation } = await import('../support/isolation.ts');

  type MediaJob = import('@tinytavern/shared').MediaJob;
  type MediaWorkflow = import('@tinytavern/shared').MediaWorkflow;

  requireTestIsolation();
  process.env.COMFY_POLL_MS = '5';

  const { stmt, IMAGES_DIR, mediaAssetForPath } = await import('../../server/src/db.ts');
  const { makePlaceholderPng } = await import('../../server/src/pngCard.ts');
  const { saveImage, deleteImageFiles } = await import('../../server/src/images.ts');
  const { getSettings, putSettings } = await import('../../server/src/settingsStore.ts');
  const { requireMediaJob, mediaJobRow, mediaJobDto, updateMediaJob, observeMediaJob } =
    await import('../../server/src/mediaJobStore.ts');
  const { createMediaJob, createMediaJobFromAsset, editMediaJob, startMediaJob, cancelMediaJob } =
    await import('../../server/src/mediaJobs.ts');
  const { initMediaWorker, tickMediaWorker, stopMediaWorker } =
    await import('../../server/src/mediaWorker.ts');
  const { drainRemoteCleanup } = await import('../../server/src/mediaRemote.ts');
  const { startMessageImageRender } = await import('../../server/src/mediaImageAdapter.ts');
  const { appendMessage, getMessage } = await import('../../server/src/tree.ts');

  const raster = makePlaceholderPng();
  const base = 'http://127.0.0.1:1';
  const imageWorkflow: MediaWorkflow = {
    id: 'image',
    name: 'Image',
    operation: 'image',
    referenceCount: 0,
    json: '{"1":{"class_type":"Text","inputs":{"text":"{{prompt}}","seed":{{seed}}}},"9":{"class_type":"SaveImage","inputs":{"filename_prefix":"{{job_id}}"}}}',
    galleryPromptPresetId: null,
    chatPromptPresetId: null,
  };
  const editWorkflow: MediaWorkflow = {
    ...imageWorkflow,
    id: 'edit',
    name: 'Edit',
    operation: 'image-edit',
    referenceCount: 3,
    json: JSON.stringify({
      '1': { class_type: 'Text', inputs: { text: '{{prompt}}', seed: 123 } },
      reference3: { class_type: 'LoadImage', inputs: { image: 'reference3.png' } },
      reference1: { class_type: 'LoadImage', inputs: { image: 'samples/reference1.png' } },
      reference2: { class_type: 'LoadImage', inputs: { image: 'reference2.png [input]' } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: '{{job_id}}' } },
    }),
  };
  putSettings({
    ...getSettings(),
    mediaRendering: {
      comfyUrl: base,
      workflows: [imageWorkflow, editWorkflow],
      defaults: { 'image:0': imageWorkflow.id },
      avatarWorkflowId: null,
      jobTimeoutSeconds: 60,
    },
  });

  const deleted = new Set<string>();
  let holdQueue = false;
  let holdDownloads = false;
  let downloadAborted = false;
  let extraOutput: 'image' | 'video' | null = null;
  let downloadCount = 0;
  const comfy = mockComfy({
    submit(_body, job) {
      job.state = holdQueue ? 'queued' : 'done';
      const output = (filename: string, type = 'output') => ({ filename, subfolder: job.id, type });
      job.outputs = {
        '9': { images: [output('first.png'), output('second.png')] },
        metadata: { files: [output('trace.json', 'temp')] },
        ...(extraOutput === 'image'
          ? { '10': { images: [output('preview.png', 'temp')] } }
          : extraOutput === 'video'
            ? { '10': { videos: [output('extra.webm')] } }
            : {}),
      };
    },
    view(url, request) {
      if (request.method === 'DELETE') {
        deleted.add(url.searchParams.toString());
        return new Response(null, { status: 204 });
      }
      downloadCount++;
      if (holdDownloads) {
        return new Response(
          new ReadableStream({
            cancel() {
              downloadAborted = true;
            },
          }),
        );
      }
      return new Response(raster, { headers: { 'content-type': 'image/png' } });
    },
  });
  const { jobs: submitted, uploads, cancellations } = comfy;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(String(input), init);
    assert.equal(new URL(request.url).origin, base, 'Tests never contact a live Comfy endpoint');
    return comfy.fetch(request);
  }) as typeof fetch;

  async function waitFor(id: number, state: MediaJob['state']): Promise<MediaJob> {
    // Completion is transient: capture its notification before automatic deletion.
    let completed: MediaJob | undefined;
    const unsubscribe = observeMediaJob(id, (row) => {
      if (row.state === 'succeeded') completed = mediaJobDto(row);
    });
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        tickMediaWorker();
        const row = mediaJobRow(id);
        const job = row ? mediaJobDto(row) : completed;
        if (job?.state === state) return job;
        await sleep(10);
      }
      assert.fail(`Job did not reach ${state}: ${JSON.stringify(mediaJobRow(id))}`);
    } finally {
      unsubscribe();
    }
  }

  function draft(requestKey: string, extra: Record<string, unknown> = {}) {
    return createMediaJob({
      requestKey: testRequestKey(requestKey),
      operation: 'image',
      prompt: 'A landscape',
      ...extra,
    });
  }

  try {
    initMediaWorker();
    const first = draft('idempotent');
    assert.equal(draft('idempotent').id, first.id);
    assert.throws(() => requireMediaJob(first.id, first.revision - 1), /changed/);
    startMediaJob(requireMediaJob(first.id), {}, false);
    const finished = await waitFor(first.id, 'succeeded');
    assert.equal(submitted.size, 1, 'Lost acceptance is reconciled without another submission');
    assert.equal(finished.outputs.length, 2);
    for (const asset of finished.outputs) {
      assert.match(
        asset.url,
        new RegExp(`^/images/media-${asset.id}\\.(png|jpe?g|webp|webm)$`),
        'Worker outputs use ownership-neutral original names',
      );
    }
    assert.equal(stmt('SELECT count(*) AS n FROM gallery_items').get()!.n, 2);
    assert.deepEqual(readFileSync(join(IMAGES_DIR, basename(finished.outputs[0]!.url))), raster);
    assert.throws(() => requireMediaJob(first.id), { status: 404 });
    assert.equal(
      stmt('SELECT id FROM media_jobs WHERE request_key = ?').get(testRequestKey('idempotent')),
      null,
      'Success deletes the full job, including its request key, even when remote cleanup fails',
    );
    assert.equal(
      stmt("SELECT owner_id FROM media_owners WHERE owner_type = 'job' AND owner_id = ?").get(
        first.id,
      ),
      null,
    );

    stmt("UPDATE media_remote_files SET retry_at = 0 WHERE state = 'pending'").run();
    await drainRemoteCleanup();
    assert(
      [...deleted].some(
        (identity) => identity.includes('trace.json') && identity.includes('type=temp'),
      ),
    );

    for (const kind of ['image', 'video'] as const) {
      extraOutput = kind;
      const invalid = draft(`multiple-${kind}-outputs`);
      const downloadsBefore = downloadCount;
      startMediaJob(requireMediaJob(invalid.id), {}, false);
      const failed = await waitFor(invalid.id, 'failed');
      assert.match(failed.error!, /multiple output nodes \(9, 10\)/);
      assert.equal(downloadCount, downloadsBefore, 'Multiple output nodes fail before downloading');
      assert.equal(failed.outputs.length, 0);
      assert.equal(requireMediaJob(invalid.id).retention_deadline, null);
      await drainRemoteCleanup();
      assert.equal(
        stmt(
          "SELECT count(*) AS n FROM media_remote_files WHERE job_id = ? AND state != 'deleted'",
        ).get(invalid.id)!.n,
        0,
        'Invalid workflows still clean every remote output, including temporary files',
      );
    }
    extraOutput = null;

    const sourcePath = saveImage('.png', raster);
    stmt(`
    INSERT INTO gallery_items(character_name, prompt, image, created_at, updated_at)
    VALUES ('Input', 'Saved source description', ?, 1, 1)
  `).run(sourcePath);
    const sourceId = mediaAssetForPath(sourcePath)!.id;
    const editInstruction = '  Preserve the face.\nChange the lighting to sunset.  ';
    const edit = draft('references', {
      instruction: editInstruction,
      operation: 'image-edit',
      workflowId: editWorkflow.id,
      inputs: [
        { slot: 'reference2', assetId: sourceId },
        { slot: 'reference3', assetId: sourceId },
        { slot: 'reference1', assetId: sourceId },
      ],
    });
    startMediaJob(requireMediaJob(edit.id), {}, false);
    const edited = await waitFor(edit.id, 'succeeded');
    assert.equal(uploads.length, 1, 'Repeated references upload only once per job');
    assert.deepEqual(uploads[0]!.data, raster);
    const graph = submitted.get(edited.comfyPromptId!)!.prompt;
    assert.equal(uploads[0]!.subfolder, '', 'Uploads do not leave per-job directories behind');
    const uploadedPath = `tinytavern-${edit.id}-asset-${sourceId}.png`;
    assert.equal(uploads[0]!.name, uploadedPath);
    assert.equal(graph.reference3!.inputs.image, uploadedPath);
    assert.equal(graph.reference1!.inputs.image, uploadedPath);
    assert.equal(graph.reference2!.inputs.image, uploadedPath);
    await drainRemoteCleanup();
    assert(
      deleted.has(
        new URLSearchParams({
          filename: uploadedPath,
          subfolder: '',
          type: 'input',
        }).toString(),
      ),
      'Cleanup deletes the exact uploaded file from the input root',
    );
    assert.throws(() => requireMediaJob(edit.id), { status: 404 });
    assert(
      existsSync(join(IMAGES_DIR, sourcePath.slice(8))),
      'Saved result recipes retain rerun inputs',
    );

    const renderingSettings = getSettings().mediaRendering;
    putSettings({
      ...getSettings(),
      mediaRendering: { ...renderingSettings, workflows: [imageWorkflow] },
    });
    const restored = createMediaJobFromAsset(edited.outputs[0]!.id, {
      requestKey: testRequestKey('recipe-rerun'),
    });
    assert.equal(restored.inputs.length, 3);
    assert.equal(
      restored.instruction,
      editInstruction,
      'Rerun restores the instruction after job deletion',
    );
    assert.equal(restored.workflowSnapshot?.json, editWorkflow.json);
    editMediaJob(requireMediaJob(restored.id), { prompt: 'A changed edit prompt' });
    startMediaJob(requireMediaJob(restored.id), {}, false);
    const restoredResult = await waitFor(restored.id, 'succeeded');
    assert.equal(uploads[1]!.name, `tinytavern-${restored.id}-asset-${sourceId}.png`);
    assert.notEqual(
      uploads[1]!.name,
      uploadedPath,
      'Separate jobs never overwrite each other’s inputs',
    );
    assert.equal(
      restoredResult.outputs.length,
      2,
      'Recipes rerun after job history and saved workflow deletion',
    );
    assert.equal(
      submitted.get(restoredResult.comfyPromptId!)!.prompt['1']!.inputs.text,
      'A changed edit prompt',
    );
    const conversationId = Number(
      stmt(`
    INSERT INTO conversations(title, created_at, updated_at) VALUES ('Image alternatives', 1, 1)
  `).run().lastInsertRowid,
    );
    const message = appendMessage(
      conversationId,
      'tool',
      'A new edit with literal {{seed}}',
      null,
      'done',
    );
    stmt('UPDATE messages SET images_json = ? WHERE id = ?').run(
      JSON.stringify([edited.outputs[0]!.url]),
      message.id,
    );
    const uploadsBeforeSwipe = uploads.length;
    const swipe = startMessageImageRender(getMessage(message.id)!);
    assert(
      getMessage(message.id)!.imagePending,
      'Starting a recipe swipe synchronously marks its message pending',
    );
    const swiped = await waitFor(swipe.id, 'succeeded');
    const updatedMessage = getMessage(message.id)!;
    assert.equal(swiped.messageId, message.id);
    assert.equal(updatedMessage.content, message.content);
    assert.equal(updatedMessage.status, 'done');
    assert.equal(
      updatedMessage.media.length,
      3,
      'All new recipe outputs append to the original image alternatives',
    );
    assert.equal(updatedMessage.activeImage, 2);
    assert.deepEqual(
      swiped.inputs,
      edited.inputs,
      'Image-edit swipes retain the source and ordered reference slots',
    );
    assert.equal(
      uploads.length,
      uploadsBeforeSwipe + 1,
      'Repeated recipe inputs still upload only once per swipe',
    );
    assert.equal(submitted.get(swiped.comfyPromptId!)!.prompt['1']!.inputs.text, message.content);
    assert.throws(() => requireMediaJob(swiped.id), { status: 404 });
    stmt("UPDATE messages SET images_json = '[]', active_image = 0 WHERE id = ?").run(message.id);
    deleteImageFiles(updatedMessage.media.map((asset) => asset.url));
    const emptyMessage = getMessage(message.id)!;
    assert(
      emptyMessage.hasImageRender,
      'Deleting the last image retains the message rendering recipe',
    );
    const emptySwipe = startMessageImageRender(emptyMessage);
    const recreated = await waitFor(emptySwipe.id, 'succeeded');
    assert.deepEqual(
      recreated.inputs,
      edited.inputs,
      'A recipe with no remaining outputs still retains its reference inputs',
    );
    assert.equal(getMessage(message.id)!.media.length, 2);
    putSettings({ ...getSettings(), mediaRendering: renderingSettings });

    const removedResult = restoredResult.outputs[0]!;
    stmt('DELETE FROM gallery_items WHERE image = ?').run(removedResult.url);
    deleteImageFiles([removedResult.url]);
    assert(
      !existsSync(join(IMAGES_DIR, basename(removedResult.url))),
      'Completed history does not keep a deleted result file alive',
    );
    assert.equal(
      stmt('SELECT id FROM media_assets WHERE id = ?').get(restoredResult.outputs[1]!.id)?.id,
      restoredResult.outputs[1]!.id,
      'Deleting one result retains the other destination-owned result',
    );

    holdQueue = true;
    const pending = draft('cancel');
    startMediaJob(requireMediaJob(pending.id), {}, false);
    await waitFor(pending.id, 'queued');
    const pendingId = requireMediaJob(pending.id).comfy_prompt_id!;
    cancelMediaJob(requireMediaJob(pending.id));
    await waitFor(pending.id, 'cancelled');
    assert.deepEqual(cancellations, [pendingId], 'Cancellation targets only the recorded job');

    putSettings({
      ...getSettings(),
      mediaRendering: { ...renderingSettings, jobTimeoutSeconds: 0 },
    });
    const unlimited = draft('unlimited');
    startMediaJob(requireMediaJob(unlimited.id), {}, false);
    await waitFor(unlimited.id, 'queued');
    assert.equal(
      requireMediaJob(unlimited.id).deadline,
      null,
      'Unlimited Comfy jobs have no wall-clock deadline',
    );
    cancelMediaJob(requireMediaJob(unlimited.id));
    await waitFor(unlimited.id, 'cancelled');
    putSettings({ ...getSettings(), mediaRendering: renderingSettings });

    const expired = draft('expired');
    startMediaJob(requireMediaJob(expired.id), {}, false);
    await waitFor(expired.id, 'queued');
    updateMediaJob(expired.id, { deadline: Date.now() - 1 });
    const expiredResult = await waitFor(expired.id, 'cancelled');
    assert(expiredResult.error?.includes('time limit'), 'The overall deadline cancels queued work');

    holdQueue = false;
    holdDownloads = true;
    const interruptedDownload = draft('cancel-download');
    startMediaJob(requireMediaJob(interruptedDownload.id), {}, false);
    await waitFor(interruptedDownload.id, 'downloading');
    cancelMediaJob(requireMediaJob(interruptedDownload.id));
    await waitFor(interruptedDownload.id, 'cancelled');
    assert(
      downloadAborted,
      'Cancel interrupts an in-flight download rather than waiting for its request timeout',
    );
    holdDownloads = false;
  } finally {
    stopMediaWorker();
    await sleep(30);
    globalThis.fetch = originalFetch;
  }
});
