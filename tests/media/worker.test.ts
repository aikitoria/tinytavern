import { mockComfy } from '../support/comfy.ts';
import { insertFixture } from '../support/fixtures.ts';
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

  const { stmt, IMAGES_DIR, mediaAssetForPath } = await import('../../server/src/db/db.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const { saveImage, deleteImageFiles } = await import('../../server/src/media/images.ts');
  const { getSettings, putSettings } = await import('../../server/src/settings/settingsStore.ts');
  const { requireMediaJob, mediaJobRow, mediaJobDto, updateMediaJob, observeMediaJob } =
    await import('../../server/src/media/mediaJobStore.ts');
  const { createMediaJob, createMediaJobFromAsset, editMediaJob, startMediaJob, cancelMediaJob } =
    await import('../../server/src/media/mediaJobs.ts');
  const { initMediaWorker, tickMediaWorker, stopMediaWorker } =
    await import('../../server/src/media/mediaWorker.ts');
  const { cancelMediaVariation } = await import('../../server/src/media/mediaDrafts.ts');
  const { drainRemoteCleanup } = await import('../../server/src/media/mediaRemote.ts');
  const { startMessageImageRender } = await import('../../server/src/media/mediaImageAdapter.ts');
  const { appendMessage, getMessage } = await import('../../server/src/conversations/tree.ts');

  const raster = makePlaceholderPng();
  const base = 'http://127.0.0.1:1';
  const imageWorkflow: MediaWorkflow = {
    id: 'image',
    name: 'Image',
    inputBindings: {},
    textOutputNodeId: null,
    json: '{"1":{"class_type":"Text","inputs":{"text":"{{prompt}}","seed":0}},"9":{"class_type":"SaveImage","inputs":{"filename_prefix":"{{job_id}}"}}}',
    standalonePromptPresetId: null,
    chatPromptPresetId: null,
  };
  const editWorkflow: MediaWorkflow = {
    ...imageWorkflow,
    id: 'edit',
    name: 'Edit',
    inputBindings: {},
    textOutputNodeId: null,
    json: JSON.stringify({
      '1': { class_type: 'Text', inputs: { text: '{{prompt}}', seed: 123 } },
      reference3: {
        class_type: 'LoadImage',
        inputs: { image: 'reference3.png' },
        _meta: { title: 'Input 3 [image:input3]' },
      },
      reference1: {
        class_type: 'LoadImage',
        inputs: { image: 'samples/reference1.png' },
        _meta: { title: 'Input 1 [image:input1]' },
      },
      reference2: {
        class_type: 'LoadImage',
        inputs: { image: 'reference2.png [input]' },
        _meta: { title: 'Input 2 [image:input2]' },
      },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: '{{job_id}}' } },
    }),
  };
  putSettings({
    ...getSettings(),
    activeEndpointId: insertFixture('endpoints', {
      name: 'Preparation cancellation',
      base_url: 'http://endpoint.invalid/v1',
      created_at: 1,
    }),
    mediaRendering: {
      ...getSettings().mediaRendering,
      comfyUrl: base,
      workflows: [imageWorkflow, editWorkflow],
      defaultWorkflowId: imageWorkflow.id,
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
  let completeAfterHistory: string | null = null;
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
    const completionId = completeAfterHistory;
    const response = await comfy.fetch(request);
    if (completionId && new URL(request.url).pathname === `/history/${completionId}`) {
      submitted.get(completionId)!.state = 'done';
      completeAfterHistory = null;
    }
    return response;
  }) as typeof fetch;

  async function waitFor(id: number, state: MediaJob['state'], removed = false): Promise<MediaJob> {
    // Completion is transient: capture its notification before automatic deletion.
    let completed: MediaJob | undefined;
    const unsubscribe = observeMediaJob(id, (row) => {
      if (row.state === state) completed = mediaJobDto(row);
    });
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        tickMediaWorker();
        const row = mediaJobRow(id);
        const job = row ? mediaJobDto(row) : completed;
        if (job?.state === state && (!removed || !row)) return job;
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

      prompt: 'A landscape',
      ...extra,
    });
  }

  try {
    const cancelledInputPath = saveImage('.png', raster);
    const cancelledInputId = mediaAssetForPath(cancelledInputPath)!.id;
    const cancelledGalleryId = insertFixture('gallery_items', {
      character_name: 'Test',
      prompt: 'Reference deleted during preparation',
      image: cancelledInputPath,
      created_at: 1,
      updated_at: 1,
    });
    const preparation = draft('cancel-preparation-reference', {
      workflowId: editWorkflow.id,
      inputs: ['input1', 'input2', 'input3'].map((slot) => ({
        slot,
        assetId: cancelledInputId,
      })),
    });
    startMediaJob(requireMediaJob(preparation.id), { autoRender: true }, true);
    stmt('DELETE FROM gallery_items WHERE id = ?').run(cancelledGalleryId);
    deleteImageFiles([cancelledInputPath]);
    assert(existsSync(join(IMAGES_DIR, basename(cancelledInputPath))));
    cancelMediaJob(requireMediaJob(preparation.id));
    await Promise.resolve();
    assert.equal(requireMediaJob(preparation.id).auto_render, 0);
    assert.equal(
      existsSync(join(IMAGES_DIR, basename(cancelledInputPath))),
      false,
      'Cancelling preparation releases a reference deleted while the job was active',
    );
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

      workflowId: editWorkflow.id,
      inputs: [
        { slot: 'input2', assetId: sourceId },
        { slot: 'input3', assetId: sourceId },
        { slot: 'input1', assetId: sourceId },
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
    assert.throws(
      () =>
        createMediaJobFromAsset(edited.outputs[0]!.id, {
          requestKey: testRequestKey('deleted-workflow'),
        }),
      /workflow no longer exists/,
    );
    const enhancedGraph = JSON.parse(editWorkflow.json);
    enhancedGraph['1'].inputs.enhanced = true;
    putSettings({
      ...getSettings(),
      mediaRendering: {
        ...renderingSettings,
        workflows: [imageWorkflow, { ...editWorkflow, json: JSON.stringify(enhancedGraph) }],
      },
    });
    const replacement = getSettings().mediaRendering.workflows.find(
      (item) => item.name === editWorkflow.name,
    )!;
    assert.notEqual(
      replacement.id,
      editWorkflow.id,
      'Recreating a workflow cannot revive its deleted identity',
    );
    assert.throws(
      () =>
        createMediaJobFromAsset(edited.outputs[0]!.id, {
          requestKey: testRequestKey('still-deleted-workflow'),
        }),
      /workflow no longer exists/,
    );
    const restored = createMediaJobFromAsset(edited.outputs[0]!.id, {
      requestKey: testRequestKey('recipe-rerun'),
      workflowId: replacement.id,
    });
    assert.equal(restored.inputs.length, 3);
    assert.equal(
      restored.instruction,
      editInstruction,
      'Rerun restores the instruction after job deletion',
    );
    assert.equal(restored.workflowId, replacement.id);
    editMediaJob(requireMediaJob(restored.id), { prompt: 'A changed edit prompt' });
    startMediaJob(requireMediaJob(restored.id), {}, false);
    const restoredResult = await waitFor(restored.id, 'succeeded');
    assert.equal(submitted.get(restoredResult.comfyPromptId!)!.prompt['1']!.inputs.enhanced, true);
    assert(
      !(
        'workflow' in
        JSON.parse(
          String(
            stmt('SELECT configuration_json FROM media_recipes WHERE id = ?').get(
              restoredResult.outputs[0]!.recipeId!,
            )!.configuration_json,
          ),
        )
      ),
    );
    assert.equal(
      uploads[1]!.name,
      `tinytavern-${testRequestKey('recipe-rerun')}-asset-${sourceId}.png`,
    );
    assert.notEqual(
      uploads[1]!.name,
      uploadedPath,
      'Separate jobs never overwrite each other’s inputs',
    );
    assert.equal(
      restoredResult.outputs.length,
      2,
      'Recipes rerun after job history deletion using the current saved workflow',
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
      JSON.stringify([restoredResult.outputs[0]!.url]),
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
    const pending = draft('cancel', { reviewBeforeSave: true });
    startMediaJob(requireMediaJob(pending.id), {}, false);
    await waitFor(pending.id, 'queued');
    const pendingId = requireMediaJob(pending.id).comfy_prompt_id!;
    cancelMediaVariation(requireMediaJob(pending.id));
    await waitFor(pending.id, 'cancelled', true);
    assert.equal(mediaJobRow(pending.id), undefined);
    assert.equal(stmt('SELECT id FROM media_drafts WHERE id = ?').get(pending.draft!.id), null);
    assert.deepEqual(cancellations, [pendingId], 'Cancellation targets only the recorded job');

    const completing = draft('cancel-between-history-and-queue');
    startMediaJob(requireMediaJob(completing.id), {}, false);
    await waitFor(completing.id, 'queued');
    const completingId = requireMediaJob(completing.id).comfy_prompt_id!;
    completeAfterHistory = completingId;
    cancelMediaJob(requireMediaJob(completing.id));
    await waitFor(completing.id, 'cancelled');
    const completionFiles = stmt(
      'SELECT filename, state FROM media_remote_files WHERE job_id = ? ORDER BY filename',
    ).all(completing.id);
    assert.deepEqual(
      completionFiles.map((file) => file.filename),
      ['first.png', 'second.png', 'trace.json'],
      'Cancellation records outputs completed between its history and queue snapshots',
    );
    assert(completionFiles.every((file) => file.state !== 'owned'));
    assert(!cancellations.includes(completingId), 'Already completed work needs only file cleanup');

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

    const { renderMediaFixture } = await import('../support/media.ts');
    const sourceVideoFile = join(IMAGES_DIR, 'video-input-fixture.webm');
    await renderMediaFixture(sourceVideoFile, 64, 48, true);
    const originalVideo = readFileSync(sourceVideoFile);
    const videoPath = saveImage('.webm', originalVideo);
    const videoId = mediaAssetForPath(videoPath)!.id;
    const stillPath = saveImage('.png', raster);
    const stillId = mediaAssetForPath(stillPath)!.id;
    for (const path of [videoPath, stillPath]) {
      insertFixture('gallery_items', {
        character_name: 'Input',
        prompt: 'Captured input prompt',
        image: path,
        created_at: 1,
        updated_at: 1,
      });
    }
    const videoWorkflow: MediaWorkflow = {
      ...imageWorkflow,
      id: 'video-input',
      name: 'Video input',
      inputBindings: { standalone: { input1: 'selected:1', input2: 'selected:2' } },
      json: JSON.stringify({
        video: {
          class_type: 'LoadVideo',
          inputs: { file: 'sample.webm' },
          _meta: { title: 'Clip [video:input1]' },
        },
        repeated: { class_type: 'LoadVideo', inputs: { file: '{{input1}}' } },
        image: { class_type: 'LoadImage', inputs: { image: '{{input2}}' } },
        frames: { class_type: 'GetVideoComponents', inputs: { video: ['video', 0] } },
        '9': {
          class_type: 'SaveImage',
          inputs: { images: ['frames', 0], filename_prefix: '{{job_id}}' },
        },
      }),
    };
    putSettings({
      ...getSettings(),
      mediaRendering: {
        ...getSettings().mediaRendering,
        workflows: [...getSettings().mediaRendering.workflows, videoWorkflow],
      },
    });
    const invalidKind = draft('wrong-video-input-kind', {
      workflowId: videoWorkflow.id,
      inputs: [
        { slot: 'input1', assetId: stillId },
        { slot: 'input2', assetId: stillId },
      ],
    });
    assert.throws(
      () => startMediaJob(requireMediaJob(invalidKind.id), {}, false),
      /requires a video/,
    );
    const videoJob = draft('video-input-roundtrip', {
      workflowId: videoWorkflow.id,
      fillInputs: { selectedAssetIds: [videoId, stillId] },
    });
    assert.deepEqual(
      videoJob.inputs.map((input) => input.assetId),
      [videoId, stillId],
    );
    assert.equal(videoJob.inputs[0]!.prompt, 'Captured input prompt');
    const uploadCount = uploads.length;
    startMediaJob(requireMediaJob(videoJob.id), {}, false);
    const videoResult = await waitFor(videoJob.id, 'succeeded');
    const videoUploads = uploads.slice(uploadCount);
    assert.equal(videoUploads.length, 2, 'Repeated video bindings upload the original only once');
    const videoUpload = videoUploads.find((upload) => upload.name.endsWith('.webm'))!;
    assert.deepEqual(
      videoUpload.data,
      originalVideo,
      'Videos return to Comfy byte-for-byte without transcoding',
    );
    const videoGraph = submitted.get(videoResult.comfyPromptId!)!.prompt;
    assert.equal(videoGraph.video!.inputs.file, videoUpload.name);
    assert.equal(videoGraph.repeated!.inputs.file, videoUpload.name);
    assert.deepEqual(videoGraph.frames!.inputs.video, ['video', 0]);
    await drainRemoteCleanup();
    assert(
      [...deleted].some((query) => {
        const params = new URLSearchParams(query);
        return params.get('filename') === videoUpload.name && params.get('type') === 'input';
      }),
      'Cleanup deletes the original uploaded video from Comfy',
    );
    assert(
      existsSync(join(IMAGES_DIR, basename(videoPath))),
      'Remote cleanup preserves the locally owned video',
    );
    const { exportImageRecipes, parseImageRecipes } =
      await import('../../server/src/conversations/conversationImageRecipes.ts');
    const resultAsset = videoResult.outputs[0]!;
    const exported = exportImageRecipes(new Map([[resultAsset.url, 'result']]), (path) => path);
    assert.equal(
      exported.recipes[0]!.inputs.find((input) => input.slot === 'input1')!.assetId,
      null,
    );
    assert.equal(
      parseImageRecipes(exported.recipes).size,
      1,
      'Video-free conversation exports retain the recipe and input slot',
    );
    const videoRerun = createMediaJobFromAsset(resultAsset.id, {
      requestKey: testRequestKey('video-input-rerun'),
    });
    assert.equal(videoRerun.inputs.find((input) => input.slot === 'input1')!.assetId, videoId);
  } finally {
    stopMediaWorker();
    await sleep(30);
    globalThis.fetch = originalFetch;
  }
});
