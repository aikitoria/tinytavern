import { conversationFixture } from '../support/fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('media drafts', async () => {
  const { newRequestId } = await import('@tinytavern/shared');
  const { existsSync } = await import('node:fs');
  const { basename, join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { requireTestIsolation } = await import('../support/isolation.ts');
  const { imageConfig } = await import('../support/imageConfig.ts');

  requireTestIsolation();
  const { stmt, IMAGES_DIR, mediaAssetForPath } = await import('../../server/src/db/db.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const { getSettings, putSettings } = await import('../../server/src/settings/settingsStore.ts');
  const { createMediaJob, createMediaJobFromAsset, startMediaJob, deleteMediaJob } =
    await import('../../server/src/media/mediaJobs.ts');
  const { requireMediaJob, updateMediaJob, mediaJobDto, mediaDraft } =
    await import('../../server/src/media/mediaJobStore.ts');
  const { recordMediaResult, completeMediaJob, finishMediaJob } =
    await import('../../server/src/media/mediaJobResults.ts');
  const { getMediaAssetResultDetails, saveMediaRecipe, getMediaRecipe } =
    await import('../../server/src/media/mediaRecipes.ts');
  const {
    acceptMediaVariation,
    cancelMediaVariation,
    selectMediaVariation,
    discardMediaDraft,
    cleanupDiscardedMediaDraft,
  } = await import('../../server/src/media/mediaDrafts.ts');
  const { appendMessage } = await import('../../server/src/conversations/tree.ts');
  const { saveImage, deleteImageFiles, sweepOrphanedImages } =
    await import('../../server/src/media/images.ts');
  function job(body: Parameters<typeof createMediaJob>[0] = {}, source?: number) {
    return createMediaJob(
      { requestKey: newRequestId(), ...body },
      source === undefined ? undefined : requireMediaJob(source),
    );
  }
  const count = (table: string) => stmt(`SELECT count(*) AS n FROM ${table}`).get()!.n;
  const onDisk = (path: string) => existsSync(join(IMAGES_DIR, basename(path)));
  function discard(id: number, options: Parameters<typeof discardMediaDraft>[1] = {}) {
    const row = requireMediaJob(id);
    return discardMediaDraft(row, {
      expectedDraftRevision: mediaDraft(row.draft_id!).revision,
      ...options,
    });
  }
  function persistedDraft(id: number) {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const { mediaDraft } = await import('./server/src/media/mediaJobStore.ts');
      const { db } = await import('./server/src/db/db.ts');
      process.stdout.write(JSON.stringify(mediaDraft(${id})));
      db.close(true);
    `,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as ReturnType<typeof mediaDraft>;
  }
  const start = (id: number) => startMediaJob(requireMediaJob(id), {}, false);
  const workflow = imageConfig(
    '{"output":{"inputs":{"text":"{{prompt}}","seed":{{seed}}}}}',
    'http://unused.invalid',
  ).workflow;
  putSettings({
    ...getSettings(),
    mediaRendering: {
      ...getSettings().mediaRendering,
      workflows: [workflow],
      defaultWorkflowId: workflow.id,
    },
  });
  conversationFixture({ id: 1, title: 'Draft test' });
  const original = appendMessage(1, 'user', 'Conversation context', null);
  const chatBefore = stmt('SELECT * FROM conversations WHERE id = 1').get()!;
  const unused = job({
    prompt: 'Typed but never generated',
    reviewBeforeSave: true,
  });
  discard(unused.id, { onlyUnstarted: true });
  assert.equal(stmt('SELECT id FROM media_jobs WHERE id = ?').get(unused.id), null);
  assert.equal(stmt('SELECT id FROM media_drafts WHERE id = ?').get(unused.draft!.id), null);
  const cancelledKey = newRequestId();
  const promptCancelled = job({
    requestKey: cancelledKey,
    prompt: 'Keep this working prompt',
    reviewBeforeSave: true,
  });
  updateMediaJob(promptCancelled.id, { state: 'preparing' });
  assert.equal(cancelMediaVariation(requireMediaJob(promptCancelled.id)).state, 'cancelled');
  assert.throws(() => requireMediaJob(promptCancelled.id), { status: 404 });
  assert.equal(
    stmt('SELECT id FROM media_drafts WHERE id = ?').get(promptCancelled.draft!.id),
    null,
    'Cancelling the only prompt attempt removes its empty draft',
  );
  const restarted = job({
    requestKey: cancelledKey,
    prompt: 'Keep this working prompt',
    reviewBeforeSave: true,
  });
  assert.notEqual(restarted.id, promptCancelled.id, 'An empty editor can generate again');
  discard(restarted.id);

  const first = job({
    prompt: 'First prompt',
    instruction: 'First instruction',
    contextConversationId: 1,
    destination: 'chat',
    reviewBeforeSave: true,
  });
  // Job IDs and recipe IDs occupy independent rowid namespaces.
  const decoy = saveMediaRecipe(
    { comfyUrl: 'http://unused.invalid', workflow, timeoutSeconds: 0 },
    [],
    'Unrelated recipe',
    { id: first.id },
  );
  start(first.id);
  assert.throws(
    () => discard(first.id, { onlyUnstarted: true }),
    { status: 409 },
    'Leaving an unused draft cannot discard work started by another client',
  );
  assert.equal(requireMediaJob(first.id).state, 'submitting');
  assert.equal(count('messages'), 1, 'Rendering a draft never inserts a chat placeholder');
  assert.equal(
    stmt('SELECT active_leaf_id FROM conversations WHERE id = 1').get()!.active_leaf_id,
    original.id,
  );

  let remoteId = 0;
  function result(jobId: number, count = 1) {
    updateMediaJob(jobId, { state: 'downloading', submission_id: crypto.randomUUID() });
    const outputs: number[] = [];
    for (let i = 0; i < count; i++) {
      const bytes = makePlaceholderPng();
      const path = saveImage('.png', bytes);
      outputs.push(
        recordMediaResult(jobId, ++remoteId, {
          path,
          kind: 'image',
          mime: 'image/png',
          byteSize: bytes.length,
          width: 1,
          height: 1,
          duration: null,
        }),
      );
    }
    completeMediaJob(jobId);
    return outputs;
  }
  const firstAssets = result(first.id, 2);
  const storedRecipe = requireMediaJob(first.id).recipe_id!;
  assert.notEqual(storedRecipe, decoy);
  assert.equal(
    getMediaRecipe(decoy).prompt,
    'Unrelated recipe',
    'Saving output never overwrites an unrelated recipe',
  );
  for (const asset of firstAssets)
    assert.equal(
      stmt('SELECT recipe_id FROM media_assets WHERE id = ?').get(asset)!.recipe_id,
      storedRecipe,
    );
  const firstResultDetails = getMediaAssetResultDetails(firstAssets[0]!);
  assert.equal(firstResultDetails.seed, requireMediaJob(first.id).seed);
  assert.equal(firstResultDetails.instruction, 'First instruction');
  const second = job({ prompt: 'Second prompt', instruction: 'Second instruction' }, first.id);
  const accept = (assetId: number, options: Parameters<typeof acceptMediaVariation>[1] = {}) =>
    acceptMediaVariation(requireMediaJob(second.id), {
      assetId,
      expectedDraftRevision: mediaDraft(first.draft!.id).revision,
      ...options,
    });
  assert.equal(second.draft!.id, first.draft!.id, 'Variations belong to the same saved draft');
  assert.throws(
    () => discard(second.id, { onlyUnstarted: true }),
    { status: 409 },
    'An unused variation must not discard an earlier generated result',
  );
  assert.equal(requireMediaJob(first.id).state, 'succeeded');
  const currentDraft = mediaDraft(first.draft!.id);
  selectMediaVariation(requireMediaJob(second.id), {
    assetId: firstAssets[0],
    expectedDraftRevision: currentDraft.revision,
  });
  assert.throws(
    () =>
      selectMediaVariation(requireMediaJob(second.id), {
        assetId: firstAssets[1],
        expectedDraftRevision: currentDraft.revision,
      }),
    { status: 409 },
    'Stale selection cannot overwrite a newer choice',
  );
  const { initMediaWorker, stopMediaWorker } =
    await import('../../server/src/media/mediaWorker.ts');
  const oldSaved = job({
    prompt: 'Saved before upgrade',
  });
  updateMediaJob(oldSaved.id, { state: 'succeeded' });
  const oldAccepted = job({
    reviewBeforeSave: true,
  });
  updateMediaJob(oldAccepted.id, { state: 'succeeded' });
  stmt("UPDATE media_drafts SET state = 'accepted' WHERE id = ?").run(oldAccepted.draft!.id);
  const failed = job();
  finishMediaJob(failed.id, 'failed', 'A failed job stays available for retry');
  initMediaWorker();
  stopMediaWorker();
  assert.throws(() => requireMediaJob(oldSaved.id), { status: 404 });
  assert.throws(() => requireMediaJob(oldAccepted.id), { status: 404 });
  assert.equal(stmt('SELECT id FROM media_drafts WHERE id = ?').get(oldAccepted.draft!.id), null);
  assert.equal(requireMediaJob(failed.id).state, 'failed');
  deleteMediaJob(requireMediaJob(failed.id));
  assert.equal(
    mediaDraft(first.draft!.id).selectedAssetId,
    firstAssets[0],
    'Startup retains completed review drafts and their selection',
  );
  sweepOrphanedImages();
  const beforeAccept = mediaJobDto(requireMediaJob(first.id)).outputs;
  assert.equal(beforeAccept.length, 2, 'Drafts keep every output through orphan cleanup');
  assert.equal(count('gallery_items'), 0);
  assert.equal(
    persistedDraft(first.draft!.id).selectedAssetId,
    firstAssets[0],
    'A fresh process recovers the unsaved selection',
  );
  start(second.id);
  const runningSecond = requireMediaJob(second.id);
  const request = {
    assetId: firstAssets[0],
    expectedDraftRevision: mediaDraft(first.draft!.id).revision,
    expectedActiveLeafId: original.id,
    expectedMutationRevision: Number(chatBefore.mutation_revision),
  };
  assert.throws(() => accept(firstAssets[0]!, { ...request, expectedActiveLeafId: null }), {
    status: 409,
  });
  const accepted = accept(firstAssets[0]!, request);
  assert.deepEqual(
    requireMediaJob(second.id),
    runningSecond,
    'Saving a completed chat variation leaves the running variation unchanged',
  );
  assert.equal(accepted.id, first.id);
  assert.equal(accepted.draft!.state, 'open');
  assert.deepEqual(accepted.draft!.savedAssetIds, [firstAssets[0]]);
  assert.deepEqual(
    accepted.outputs.map((asset) => asset.id),
    firstAssets,
  );
  assert.equal(count('messages'), 2, 'Only acceptance inserts a message');
  assert.equal(
    stmt('SELECT content FROM messages WHERE id = ?').get(accepted.messageId!)!.content,
    'First prompt',
  );
  assert.equal(
    stmt('SELECT count(*) AS n FROM media_jobs WHERE draft_id = ?').get(first.draft!.id)!.n,
    2,
    'Saving keeps every variation open',
  );
  assert.ok(onDisk(beforeAccept[1]!.url));
  const repeated = accept(firstAssets[0]!, {
    ...request,
    expectedDraftRevision: accepted.draft!.revision,
  });
  assert.equal(repeated.draft!.revision, accepted.draft!.revision);
  assert.equal(count('messages'), 2, 'Saving an already-owned output is idempotent');
  const secondAssets = result(second.id);
  const completedDraftRevision = mediaDraft(first.draft!.id).revision;
  const afterFirst = stmt('SELECT * FROM conversations WHERE id = 1').get()!;
  assert.throws(
    () =>
      accept(secondAssets[0]!, {
        ...request,
        assetId: secondAssets[0],
        expectedDraftRevision: completedDraftRevision,
      }),
    { status: 409 },
    'A second save still checks the current chat branch',
  );
  const acceptedSecond = accept(secondAssets[0]!, {
    expectedDraftRevision: completedDraftRevision,
    expectedActiveLeafId: Number(afterFirst.active_leaf_id),
    expectedMutationRevision: Number(afterFirst.mutation_revision),
  });
  assert.equal(count('messages'), 3);
  assert.equal(
    stmt('SELECT content FROM messages WHERE id = ?').get(acceptedSecond.messageId!)!.content,
    'Second prompt',
  );
  assert.deepEqual(acceptedSecond.draft!.savedAssetIds, [firstAssets[0], secondAssets[0]]);
  assert.deepEqual(
    persistedDraft(first.draft!.id).savedAssetIds,
    acceptedSecond.draft!.savedAssetIds,
    'Saved selections survive restart through destination ownership',
  );
  discard(second.id, {
    expectedDraftRevision: acceptedSecond.draft!.revision,
  });
  assert.equal(stmt('SELECT id FROM media_drafts WHERE id = ?').get(first.draft!.id), null);
  assert.deepEqual(
    getMediaAssetResultDetails(firstAssets[0]!),
    firstResultDetails,
    'Original text, workflow and seed survive finishing and removing the job',
  );
  assert.equal(stmt("SELECT owner_id FROM media_owners WHERE owner_type = 'job'").get(), null);
  assert.ok(onDisk(beforeAccept[0]!.url), 'Finishing keeps saved chat output');
  assert.equal(onDisk(beforeAccept[1]!.url), false, 'Finishing deletes unsaved outputs');
  assert.ok(
    stmt('SELECT id FROM media_assets WHERE id = ?').get(secondAssets[0]!),
    'Finishing keeps other saved variations',
  );

  const acceptedRerun = createMediaJobFromAsset(firstAssets[0]!, { requestKey: newRequestId() });
  assert.equal(
    acceptedRerun.instruction,
    'First instruction',
    'Acceptance retains the selected variation instruction',
  );
  assert.equal(acceptedRerun.prompt, 'First prompt');
  deleteMediaJob(requireMediaJob(acceptedRerun.id));

  const galleryDraft = job({
    prompt: 'Gallery choice',
    reviewBeforeSave: true,
  });
  start(galleryDraft.id);
  const galleryAssets = result(galleryDraft.id, 2);
  const galleryPending = job({ prompt: 'Next gallery variation' }, galleryDraft.id);
  start(galleryPending.id);
  const runningGallery = requireMediaJob(galleryPending.id);
  let saved = mediaJobDto(requireMediaJob(galleryDraft.id));
  for (const [assetId, expectedCount, savedIds, reason] of [
    [galleryAssets[1], 1, [galleryAssets[1]], 'Gallery receives only the accepted result'],
    [galleryAssets[1], 1, [galleryAssets[1]], 'Repeated gallery save cannot create a duplicate'],
    [galleryAssets[0], 2, galleryAssets, 'Multiple outputs of one generation can be saved'],
  ] as const) {
    saved = acceptMediaVariation(requireMediaJob(galleryDraft.id), {
      assetId,
      expectedDraftRevision: saved.draft!.revision,
    });
    assert.equal(count('gallery_items'), expectedCount, reason);
    assert.deepEqual(saved.draft!.savedAssetIds, savedIds);
    assert.equal(requireMediaJob(saved.id).state, 'succeeded');
    assert.deepEqual(
      requireMediaJob(galleryPending.id),
      runningGallery,
      'Saving completed gallery variations leaves the running variation unchanged',
    );
    if (expectedCount === 1)
      assert.equal(
        stmt('SELECT image FROM gallery_items').get()!.image,
        saved.outputs.find((asset) => asset.id === galleryAssets[1])!.url,
      );
  }
  const resavedAsset = saved.outputs.find((asset) => asset.id === galleryAssets[1])!;
  stmt('DELETE FROM gallery_items WHERE image = ?').run(resavedAsset.url);
  deleteImageFiles([resavedAsset.url]);
  assert.ok(onDisk(resavedAsset.url), 'The open draft retains a deleted saved variation');
  saved = acceptMediaVariation(requireMediaJob(galleryDraft.id), {
    assetId: resavedAsset.id,
    expectedDraftRevision: mediaDraft(saved.draft!.id).revision,
  });
  const resavedInput = job({ inputs: [{ slot: 'source', assetId: resavedAsset.id }] });
  assert.equal(
    resavedInput.assets[0]!.id,
    resavedAsset.id,
    'A re-saved gallery variation is available as a new reference',
  );
  deleteMediaJob(requireMediaJob(resavedInput.id));
  const cancelling = cancelMediaVariation(requireMediaJob(galleryPending.id));
  assert.equal(cancelling.state, 'cancelling');
  cleanupDiscardedMediaDraft(requireMediaJob(galleryPending.id));
  assert.equal(requireMediaJob(galleryPending.id).state, 'cancelling');
  const queuedAfterCancel = job({ prompt: 'Generate again' }, galleryPending.id);
  assert.equal(
    JSON.parse(requireMediaJob(queuedAfterCancel.id).configuration_json!).discardOnCancel,
    undefined,
    'A new variation cannot inherit the previous cancellation request',
  );
  finishMediaJob(galleryPending.id, 'cancelled');
  initMediaWorker();
  stopMediaWorker();
  assert.throws(() => requireMediaJob(galleryPending.id), { status: 404 });
  assert.equal(requireMediaJob(queuedAfterCancel.id).state, 'draft');
  assert.deepEqual(mediaDraft(saved.draft!.id).savedAssetIds, galleryAssets);
  assert.throws(
    () =>
      selectMediaVariation(requireMediaJob(galleryDraft.id), {
        assetId: galleryAssets[0],
        expectedDraftRevision: queuedAfterCancel.draft!.revision,
      }),
    { status: 409 },
    'Removing a variation advances the shared draft revision',
  );
  discard(galleryDraft.id, {
    expectedDraftRevision: mediaDraft(saved.draft!.id).revision,
  });
  assert.throws(() => requireMediaJob(saved.id), { status: 404 });
  for (const asset of saved.outputs)
    assert.ok(onDisk(asset.url), 'Every saved gallery output survives finishing');

  const inputPath = saveImage('.png', makePlaceholderPng());
  const input = mediaAssetForPath(inputPath)!;
  stmt("INSERT INTO media_owners VALUES (?, 'gallery', 'test-input', '0')").run(input.id);
  const editWorkflow = {
    ...workflow,
    id: 'edit',
    inputBindings: {},
    textOutputNodeId: null,
    json: '{"output":{"inputs":{"text":"{{prompt}}","image":"{{reference1}}"}}}',
  };
  putSettings({
    ...getSettings(),
    mediaRendering: { ...getSettings().mediaRendering, workflows: [workflow, editWorkflow] },
  });
  const discarded = job({
    workflowId: editWorkflow.id,
    prompt: 'Discard this',
    reviewBeforeSave: true,
    inputs: [{ assetId: input.id, slot: 'reference1' }],
  });
  start(discarded.id);
  const queued = [discarded.id];
  const firstSnapshot = requireMediaJob(discarded.id);
  for (let index = 1; index < 10; index++) {
    const requestKey = newRequestId();
    const sourceId = queued.at(-1)!;
    const next = job({ requestKey }, sourceId);
    assert.equal(next.draft!.id, discarded.draft!.id);
    assert.equal(
      job({ requestKey }, sourceId).id,
      next.id,
      'A repeated queue request creates only one variation',
    );
    start(next.id);
    queued.push(next.id);
  }
  assert.equal(new Set(queued).size, 10, 'Ten attempts can queue before any render completes');
  assert.deepEqual(
    requireMediaJob(discarded.id),
    firstSnapshot,
    'Queueing more variations cannot alter the running job snapshot',
  );
  assert.equal(
    stmt('SELECT count(*) AS n FROM media_jobs WHERE draft_id = ? AND state = ?').get(
      discarded.draft!.id,
      'submitting',
    )!.n,
    10,
  );
  stmt("DELETE FROM media_owners WHERE owner_type = 'gallery' AND owner_id = 'test-input'").run();
  cancelMediaVariation(requireMediaJob(discarded.id));
  cleanupDiscardedMediaDraft(requireMediaJob(discarded.id));
  assert.equal(requireMediaJob(discarded.id).state, 'cancelling');
  deleteImageFiles([inputPath]);
  assert.ok(onDisk(inputPath), 'Individual cancellation retains inputs until execution stops');
  finishMediaJob(discarded.id, 'cancelled');
  cleanupDiscardedMediaDraft(requireMediaJob(discarded.id));
  assert.throws(() => requireMediaJob(discarded.id), { status: 404 });
  queued.shift();
  assert.ok(onDisk(inputPath), 'Removing one variation preserves inputs owned by other jobs');
  discard(queued[0]!, {
    expectedDraftRevision: mediaDraft(discarded.draft!.id).revision,
  });
  deleteImageFiles([inputPath]);
  assert.ok(
    existsSync(join(IMAGES_DIR, inputPath.slice(8))),
    'Running discard keeps inputs until cancellation completes',
  );
  for (const id of queued) {
    assert.ok(
      existsSync(join(IMAGES_DIR, inputPath.slice(8))),
      'Shared inputs remain pinned until the last queued cancellation completes',
    );
    finishMediaJob(id, 'cancelled');
    cleanupDiscardedMediaDraft(requireMediaJob(id));
  }
  assert.equal(existsSync(join(IMAGES_DIR, inputPath.slice(8))), false);
  assert.equal(stmt('SELECT id FROM media_drafts WHERE id = ?').get(discarded.draft!.id), null);
  assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
});
