import assert from 'node:assert/strict';
import { test } from 'node:test';

test('media drafts', async () => {
  const { randomUUID } = await import('node:crypto');

  const { existsSync, writeFileSync } = await import('node:fs');

  const { basename, join } = await import('node:path');

  const { spawnSync } = await import('node:child_process');

  const { requireTestIsolation } = await import('../support/isolation.ts');

  const { imageConfig } = await import('../support/imageConfig.ts');

  requireTestIsolation();
  const { stmt, IMAGES_DIR, mediaAssetForPath } = await import('../../server/src/db.ts');
  const { makePlaceholderPng } = await import('../../server/src/pngCard.ts');
  const { getSettings, putSettings } = await import('../../server/src/settingsStore.ts');
  const { createMediaJob, createMediaJobFromAsset, startMediaJob, deleteMediaJob } =
    await import('../../server/src/mediaJobs.ts');
  const { requireMediaJob, updateMediaJob, mediaJobDto, mediaDraft } =
    await import('../../server/src/mediaJobStore.ts');
  const { recordMediaResult, completeMediaJob, finishMediaJob } =
    await import('../../server/src/mediaJobResults.ts');
  const { getMediaAssetResultDetails } = await import('../../server/src/mediaRecipes.ts');
  const {
    acceptMediaVariation,
    selectMediaVariation,
    discardMediaDraft,
    cleanupDiscardedMediaDraft,
  } = await import('../../server/src/mediaDrafts.ts');
  const { appendMessage } = await import('../../server/src/tree.ts');
  const { saveImage, deleteImageFiles, sweepOrphanedImages } =
    await import('../../server/src/images.ts');

  const workflow = imageConfig(
    '{"output":{"inputs":{"text":"{{prompt}}","seed":{{seed}}}}}',
    'http://unused.invalid',
  ).workflow;
  putSettings({
    ...getSettings(),
    mediaRendering: {
      ...getSettings().mediaRendering,
      workflows: [workflow],
      defaults: { 'image:0': workflow.id },
    },
  });
  stmt(
    "INSERT INTO conversations(id, title, created_at, updated_at) VALUES (1, 'Draft test', 1, 1)",
  ).run();
  const original = appendMessage(1, 'user', 'Conversation context', null);
  const chatBefore = stmt('SELECT * FROM conversations WHERE id = 1').get()!;
  const unused = createMediaJob({
    requestKey: randomUUID(),
    operation: 'image',
    prompt: 'Typed but never generated',
    reviewBeforeSave: true,
  });
  discardMediaDraft(requireMediaJob(unused.id), {
    expectedDraftRevision: unused.draft!.revision,
    onlyUnstarted: true,
  });
  assert.equal(stmt('SELECT id FROM media_jobs WHERE id = ?').get(unused.id), undefined);
  assert.equal(stmt('SELECT id FROM media_drafts WHERE id = ?').get(unused.draft!.id), undefined);

  const first = createMediaJob({
    requestKey: randomUUID(),
    operation: 'image',
    prompt: 'First prompt',
    instruction: 'First instruction',
    contextConversationId: 1,
    destination: 'chat',
    reviewBeforeSave: true,
  });
  startMediaJob(requireMediaJob(first.id), {}, false);
  assert.throws(
    () =>
      discardMediaDraft(requireMediaJob(first.id), {
        expectedDraftRevision: mediaDraft(first.draft!.id).revision,
        onlyUnstarted: true,
      }),
    { status: 409 },
    'Leaving an unused draft cannot discard work started by another client',
  );
  assert.equal(requireMediaJob(first.id).state, 'submitting');
  assert.equal(
    stmt('SELECT count(*) AS n FROM messages').get()!.n,
    1,
    'Rendering a draft never inserts a chat placeholder',
  );
  assert.equal(
    stmt('SELECT active_leaf_id FROM conversations WHERE id = 1').get()!.active_leaf_id,
    original.id,
  );

  let remoteId = 0;
  function result(jobId: string, count = 1) {
    updateMediaJob(jobId, { state: 'downloading', submission_id: randomUUID() });
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
  const firstResultDetails = getMediaAssetResultDetails(firstAssets[0]!);
  assert.equal(firstResultDetails.seed, requireMediaJob(first.id).seed);
  assert.equal(firstResultDetails.instruction, 'First instruction');
  const second = createMediaJob(
    { requestKey: randomUUID(), prompt: 'Second prompt', instruction: 'Second instruction' },
    requireMediaJob(first.id),
  );
  assert.equal(second.draft!.id, first.draft!.id, 'Variations belong to the same saved draft');
  assert.throws(
    () =>
      discardMediaDraft(requireMediaJob(second.id), {
        expectedDraftRevision: mediaDraft(first.draft!.id).revision,
        onlyUnstarted: true,
      }),
    { status: 409 },
    'An unused variation must not discard an earlier generated result',
  );
  assert.equal(requireMediaJob(first.id).state, 'succeeded');
  startMediaJob(requireMediaJob(second.id), {}, false);
  assert.throws(
    () =>
      acceptMediaVariation(requireMediaJob(second.id), {
        assetId: firstAssets[0],
        expectedDraftRevision: mediaDraft(first.draft!.id).revision,
      }),
    { status: 409 },
    'Acceptance waits for running work to finish or be cancelled',
  );
  const secondAssets = result(second.id);
  const currentDraft = mediaDraft(first.draft!.id);
  selectMediaVariation(requireMediaJob(second.id), {
    assetId: firstAssets[0],
    expectedDraftRevision: currentDraft.revision,
  });
  assert.throws(
    () =>
      selectMediaVariation(requireMediaJob(second.id), {
        assetId: secondAssets[0],
        expectedDraftRevision: currentDraft.revision,
      }),
    { status: 409 },
    'Stale selection cannot overwrite a newer choice',
  );
  const { initMediaWorker, stopMediaWorker } = await import('../../server/src/mediaWorker.ts');
  const oldSaved = createMediaJob({
    requestKey: randomUUID(),
    operation: 'image',
    prompt: 'Saved before upgrade',
  });
  updateMediaJob(oldSaved.id, { state: 'succeeded' });
  const oldAccepted = createMediaJob({
    requestKey: randomUUID(),
    operation: 'image',
    reviewBeforeSave: true,
  });
  updateMediaJob(oldAccepted.id, { state: 'succeeded' });
  stmt("UPDATE media_drafts SET state = 'accepted' WHERE id = ?").run(oldAccepted.draft!.id);
  const failed = createMediaJob({ requestKey: randomUUID(), operation: 'image' });
  finishMediaJob(failed.id, 'failed', 'A failed job stays available for retry');
  initMediaWorker();
  stopMediaWorker();
  assert.throws(() => requireMediaJob(oldSaved.id), { status: 404 });
  assert.throws(() => requireMediaJob(oldAccepted.id), { status: 404 });
  assert.equal(
    stmt('SELECT id FROM media_drafts WHERE id = ?').get(oldAccepted.draft!.id),
    undefined,
  );
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
  assert.equal(stmt('SELECT count(*) AS n FROM gallery_items').get()!.n, 0);
  const persisted = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(process.env.DB_PATH, { readOnly: true });
  const row = db.prepare('SELECT selected_asset_id FROM media_drafts WHERE id = ?').get(${JSON.stringify(first.draft!.id)});
  process.stdout.write(String(row.selected_asset_id));
  db.close();
`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(persisted.status, 0, persisted.stderr);
  assert.equal(
    persisted.stdout,
    String(firstAssets[0]),
    'A separate connection recovers the saved selection',
  );
  const request = {
    assetId: firstAssets[0],
    expectedDraftRevision: mediaDraft(first.draft!.id).revision,
    expectedActiveLeafId: original.id,
    expectedMutationRevision: Number(chatBefore.mutation_revision),
  };
  assert.throws(
    () =>
      acceptMediaVariation(requireMediaJob(second.id), { ...request, expectedActiveLeafId: null }),
    { status: 409 },
  );
  const accepted = acceptMediaVariation(requireMediaJob(second.id), request);
  assert.equal(accepted.id, first.id);
  assert.equal(accepted.draft!.state, 'open');
  assert.deepEqual(accepted.draft!.savedAssetIds, [firstAssets[0]]);
  assert.deepEqual(
    accepted.outputs.map((asset) => asset.id),
    firstAssets,
  );
  assert.equal(
    stmt('SELECT count(*) AS n FROM messages').get()!.n,
    2,
    'Only acceptance inserts a message',
  );
  assert.equal(
    stmt('SELECT content FROM messages WHERE id = ?').get(accepted.messageId!)!.content,
    'First prompt',
  );
  assert.equal(
    stmt('SELECT count(*) AS n FROM media_jobs WHERE draft_id = ?').get(first.draft!.id)!.n,
    2,
    'Saving keeps every variation open',
  );
  assert.ok(existsSync(join(IMAGES_DIR, basename(beforeAccept[1]!.url))));
  const repeated = acceptMediaVariation(requireMediaJob(second.id), {
    ...request,
    expectedDraftRevision: accepted.draft!.revision,
  });
  assert.equal(repeated.draft!.revision, accepted.draft!.revision);
  assert.equal(
    stmt('SELECT count(*) AS n FROM messages').get()!.n,
    2,
    'Saving an already-owned output is idempotent',
  );
  const afterFirst = stmt('SELECT * FROM conversations WHERE id = 1').get()!;
  assert.throws(
    () =>
      acceptMediaVariation(requireMediaJob(second.id), {
        ...request,
        assetId: secondAssets[0],
        expectedDraftRevision: accepted.draft!.revision,
      }),
    { status: 409 },
    'A second save still checks the current chat branch',
  );
  const acceptedSecond = acceptMediaVariation(requireMediaJob(second.id), {
    assetId: secondAssets[0],
    expectedDraftRevision: accepted.draft!.revision,
    expectedActiveLeafId: Number(afterFirst.active_leaf_id),
    expectedMutationRevision: Number(afterFirst.mutation_revision),
  });
  assert.equal(stmt('SELECT count(*) AS n FROM messages').get()!.n, 3);
  assert.equal(
    stmt('SELECT content FROM messages WHERE id = ?').get(acceptedSecond.messageId!)!.content,
    'Second prompt',
  );
  assert.deepEqual(acceptedSecond.draft!.savedAssetIds, [firstAssets[0], secondAssets[0]]);
  const recovered = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
  const { mediaDraft } = await import('./server/src/mediaJobStore.ts');
  const { db } = await import('./server/src/db.ts');
  process.stdout.write(JSON.stringify(mediaDraft(${JSON.stringify(first.draft!.id)}).savedAssetIds));
  db.close();
`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.deepEqual(
    JSON.parse(recovered.stdout),
    acceptedSecond.draft!.savedAssetIds,
    'Saved selections survive restart through destination ownership',
  );
  discardMediaDraft(requireMediaJob(second.id), {
    expectedDraftRevision: acceptedSecond.draft!.revision,
  });
  assert.equal(stmt('SELECT id FROM media_drafts WHERE id = ?').get(first.draft!.id), undefined);
  assert.deepEqual(
    getMediaAssetResultDetails(firstAssets[0]!),
    firstResultDetails,
    'Original text, workflow and seed survive finishing and removing the job',
  );
  assert.equal(stmt("SELECT owner_id FROM media_owners WHERE owner_type = 'job'").get(), undefined);
  assert.ok(
    existsSync(join(IMAGES_DIR, basename(beforeAccept[0]!.url))),
    'Finishing keeps saved chat output',
  );
  assert.equal(
    existsSync(join(IMAGES_DIR, basename(beforeAccept[1]!.url))),
    false,
    'Finishing deletes unsaved outputs',
  );
  assert.ok(
    stmt('SELECT id FROM media_assets WHERE id = ?').get(secondAssets[0]!),
    'Finishing keeps other saved variations',
  );

  const acceptedRerun = createMediaJobFromAsset(firstAssets[0]!, { requestKey: randomUUID() });
  assert.equal(
    acceptedRerun.instruction,
    'First instruction',
    'Acceptance retains the selected variation instruction',
  );
  assert.equal(acceptedRerun.prompt, 'First prompt');
  deleteMediaJob(requireMediaJob(acceptedRerun.id));

  const galleryDraft = createMediaJob({
    requestKey: randomUUID(),
    operation: 'image',
    prompt: 'Gallery choice',
    reviewBeforeSave: true,
  });
  startMediaJob(requireMediaJob(galleryDraft.id), {}, false);
  const galleryAssets = result(galleryDraft.id, 2);
  const saved = acceptMediaVariation(requireMediaJob(galleryDraft.id), {
    assetId: galleryAssets[1],
    expectedDraftRevision: mediaDraft(galleryDraft.draft!.id).revision,
  });
  assert.equal(
    stmt('SELECT count(*) AS n FROM gallery_items').get()!.n,
    1,
    'Gallery receives only the accepted result',
  );
  assert.equal(
    stmt('SELECT image FROM gallery_items').get()!.image,
    saved.outputs.find((asset) => asset.id === galleryAssets[1])!.url,
  );
  assert.equal(requireMediaJob(saved.id).state, 'succeeded');
  assert.deepEqual(saved.draft!.savedAssetIds, [galleryAssets[1]]);
  const gallerySavedAgain = acceptMediaVariation(requireMediaJob(galleryDraft.id), {
    assetId: galleryAssets[1],
    expectedDraftRevision: saved.draft!.revision,
  });
  assert.equal(
    stmt('SELECT count(*) AS n FROM gallery_items').get()!.n,
    1,
    'Repeated gallery save cannot create a duplicate',
  );
  const gallerySavedBoth = acceptMediaVariation(requireMediaJob(galleryDraft.id), {
    assetId: galleryAssets[0],
    expectedDraftRevision: gallerySavedAgain.draft!.revision,
  });
  assert.equal(
    stmt('SELECT count(*) AS n FROM gallery_items').get()!.n,
    2,
    'Multiple outputs of one generation can be saved',
  );
  assert.deepEqual(gallerySavedBoth.draft!.savedAssetIds, galleryAssets);
  discardMediaDraft(requireMediaJob(galleryDraft.id), {
    expectedDraftRevision: gallerySavedBoth.draft!.revision,
  });
  assert.throws(() => requireMediaJob(saved.id), { status: 404 });
  for (const asset of saved.outputs)
    assert.ok(
      existsSync(join(IMAGES_DIR, basename(asset.url))),
      'Every saved gallery output survives finishing',
    );

  const inputPath = saveImage('.png', makePlaceholderPng());
  const input = mediaAssetForPath(inputPath)!;
  stmt("INSERT INTO media_owners VALUES (?, 'gallery', 'test-input', '0')").run(input.id);
  const editWorkflow = {
    ...workflow,
    id: 'edit',
    operation: 'image-edit' as const,
    referenceCount: 1 as const,
    json: '{"output":{"inputs":{"text":"{{prompt}}","image":"{{reference1}}"}}}',
  };
  putSettings({
    ...getSettings(),
    mediaRendering: { ...getSettings().mediaRendering, workflows: [workflow, editWorkflow] },
  });
  const discarded = createMediaJob({
    requestKey: randomUUID(),
    operation: 'image-edit',
    workflowId: editWorkflow.id,
    prompt: 'Discard this',
    reviewBeforeSave: true,
    inputs: [{ assetId: input.id, slot: 'reference1' }],
  });
  startMediaJob(requireMediaJob(discarded.id), {}, false);
  stmt("DELETE FROM media_owners WHERE owner_type = 'gallery' AND owner_id = 'test-input'").run();
  discardMediaDraft(requireMediaJob(discarded.id), {
    expectedDraftRevision: mediaDraft(discarded.draft!.id).revision,
  });
  deleteImageFiles([inputPath]);
  assert.ok(
    existsSync(join(IMAGES_DIR, inputPath.slice(8))),
    'Running discard keeps inputs until cancellation completes',
  );
  finishMediaJob(discarded.id, 'cancelled');
  cleanupDiscardedMediaDraft(requireMediaJob(discarded.id));
  assert.equal(existsSync(join(IMAGES_DIR, inputPath.slice(8))), false);
  assert.equal(
    stmt('SELECT id FROM media_drafts WHERE id = ?').get(discarded.draft!.id),
    undefined,
  );
  assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
});
