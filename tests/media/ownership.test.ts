import { attachImages, galleryFixture } from '../support/fixtures.ts';
import { conversationFixture, messageFixture, insertFixture } from '../support/fixtures.ts';
import assert from 'node:assert/strict';
import { databaseCase } from '../support/database.ts';

databaseCase('media ownership', async () => {
  const { existsSync, readdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { stmt, IMAGES_DIR, mediaAssetForPath, transaction } = await import('../../server/src/db/db.ts');
  const { saveImage, copyImage, deleteImageFiles, sweepOrphanedImages, reserveMediaFile } =
    await import('../../server/src/media/images.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const path = saveImage('.png', makePlaceholderPng());
  const asset = mediaAssetForPath(path)!;
  assert.equal(path, `/images/media-${asset.id}.png`);
  assert.equal(asset.mime, 'image/png');
  assert.ok(asset.byteSize! > 0);
  conversationFixture({ id: 1 });
  messageFixture(1, { id: 1, role: 'tool', content: 'image', images: [path] });
  stmt("INSERT INTO media_owners VALUES (?, 'job', 'active', 'source')").run(asset.id);
  const assetCount = stmt('SELECT count(*) AS count FROM media_assets').get()!.count;
  const beforeFailedSave = readdirSync(IMAGES_DIR).sort();
  stmt(`CREATE TRIGGER reject_saved_media BEFORE UPDATE OF byte_size ON media_assets
  BEGIN SELECT RAISE(ABORT, 'Injected metadata error'); END`).run();
  transaction(() => {
    assert.throws(() => saveImage('.png', makePlaceholderPng()), /Injected metadata error/);
  });
  stmt('DROP TRIGGER reject_saved_media').run();
  assert.equal(stmt('SELECT count(*) AS count FROM media_assets').get()!.count, assetCount);
  assert.deepEqual(
    readdirSync(IMAGES_DIR).sort(),
    beforeFailedSave,
    'A failed save caught inside an outer transaction releases both its file and reservation',
  );
  transaction(() => {
    assert.equal(copyImage('/images/missing.png'), null);
  });
  assert.equal(
    stmt('SELECT count(*) AS count FROM media_assets').get()!.count,
    assetCount,
    'A skipped missing copy inside an outer transaction leaves no asset reservation',
  );
  const reservedBeforeCrash = reserveMediaFile('.part');
  stmt('DELETE FROM messages WHERE id = 1').run();
  deleteImageFiles([path]);
  assert.ok(existsSync(join(IMAGES_DIR, path.slice(8))), 'A job retains a deleted message input');
  sweepOrphanedImages();
  assert.equal(
    stmt('SELECT id FROM media_assets WHERE id = ?').get(reservedBeforeCrash.id),
    null,
    'Startup releases a reservation whose process died before creating the file',
  );
  assert.ok(existsSync(join(IMAGES_DIR, path.slice(8))), 'Startup sweep retains input pins');
  stmt("DELETE FROM media_owners WHERE owner_type = 'job'").run();
  deleteImageFiles([path]);
  assert.equal(existsSync(join(IMAGES_DIR, path.slice(8))), false);

  const galleryPath = saveImage('.png', makePlaceholderPng());
  galleryFixture(galleryPath, { id: 1, prompt: 'prompt' });
  const duplicate = copyImage(galleryPath)!;
  assert.notEqual(mediaAssetForPath(galleryPath)!.id, mediaAssetForPath(duplicate)!.id);
  stmt('DELETE FROM gallery_items WHERE id = 1').run();
  deleteImageFiles([galleryPath]);
  assert.ok(existsSync(join(IMAGES_DIR, duplicate.slice(8))), 'Copies retain independent file ownership');
  const input = saveImage('.png', makePlaceholderPng());
  stmt(
    "INSERT INTO media_recipes(id, prompt, configuration_json, inputs_json, created_at) VALUES (901, 'prompt', '{}', '[]', 1)",
  ).run();
  stmt("INSERT INTO media_owners VALUES (?, 'recipe', 901, 'source')").run(mediaAssetForPath(input)!.id);
  stmt('UPDATE media_assets SET recipe_id = 901 WHERE path = ?').run(duplicate);
  const { invalidateMediaAsset } = await import('../../server/src/db/db.ts');
  invalidateMediaAsset(duplicate);
  deleteImageFiles([input, duplicate]);
  assert.equal(
    existsSync(join(IMAGES_DIR, input.slice(8))),
    false,
    'Deleting the last result releases its recipe inputs',
  );
  assert.equal(stmt('SELECT count(*) AS n FROM media_owners').get()!.n, 0);
  writeFileSync(join(IMAGES_DIR, 'untracked.tmp'), 'partial');
  sweepOrphanedImages();
  assert.equal(existsSync(join(IMAGES_DIR, 'untracked.tmp')), false);
  assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
});

databaseCase('media attachment ownership', async () => {
  const { stmt } = await import('../../server/src/db/db.ts');
  const { mediaCharacterIds, setMediaCharacters } = await import('../../server/src/media/mediaCharacters.ts');
  const cid = conversationFixture({ character_id: 1, title: 'Attachments' });
  const paths = ['/images/101.png', '/images/102.png', '/images/103.png'] as const;
  const mid = messageFixture(cid, {
    content: 'originalsearchword',
    images: paths.slice(0, 2),
  });
  const asset = (path: string) => Number(stmt('SELECT id FROM media_assets WHERE path=?').get(path)!.id);
  const associations = (path: string) => mediaCharacterIds(asset(path));
  const owners = () =>
    stmt(`SELECT o.rowid, o.slot, a.path FROM media_owners o
  JOIN media_assets a ON a.id=o.asset_id WHERE owner_type='message' AND owner_id=? ORDER BY slot`).all(String(mid));
  const update = (images: readonly string[]) => attachImages(mid, images);
  const changes = () => Number(stmt('SELECT total_changes() AS n').get()!.n);
  assert.deepEqual(paths.slice(0, 2).map(associations), [[1], [1]]);
  const initialOwner = owners()[0];
  for (const [name, images, clear, expected] of [
    ['remove alternative', [paths[0]], paths[0], [[]]],
    ['append completed render', [paths[0], paths[2]], paths[0], [[], [1]]],
    ['reorder and repeat', [paths[2], paths[0], paths[0]], paths[2], [[], [], []]],
  ] as const) {
    setMediaCharacters(asset(clear), []);
    update(images);
    assert.deepEqual(images.map(associations), expected, `${name}: preserve edited associations`);
    assert.deepEqual(
      owners().map(({ slot, path }) => [slot, path]),
      images.map((path, index) => [String(index), path]),
      `${name}: maintain ordered attachment owners`,
    );
    if (name === 'remove alternative') assert.deepEqual(owners(), [initialOwner], 'An unchanged owner keeps its row');
  }
  const stableOwners = owners();
  let before = changes();
  update([paths[2]!, paths[0]!, paths[0]!]);
  assert.equal(changes() - before, 1, 'Identical attachments perform only the selection write');
  attachImages(mid, [paths[2], paths[0], paths[0]]);
  assert.deepEqual(owners(), stableOwners, 'Repeated attachment updates do not rebuild owners');
  assert.deepEqual(associations(paths[0]!), []);

  // Another message introduces a new association; subsequent edits to either owner preserve removals.
  const other = messageFixture(cid, { images: [paths[0]] });
  assert.deepEqual(associations(paths[0]!), [1]);
  setMediaCharacters(asset(paths[0]!), []);
  update([paths[0]!]);
  attachImages(other, [paths[0], paths[1]]);
  assert.deepEqual(associations(paths[0]!), [], 'Shared assets retain explicit organization');
  assert.deepEqual(associations(paths[1]!), [1]);

  before = changes();
  stmt('UPDATE messages SET content=content WHERE id=?').run(mid);
  assert.equal(changes() - before, 1, 'Identical content does not rewrite FTS');
  stmt('UPDATE messages SET content=? WHERE id=?').run('replacementsearchword', mid);
  assert.equal(
    stmt("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'originalsearchword'").get()!.n,
    0,
  );
  assert.equal(
    stmt("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'replacementsearchword'").get()!.rowid,
    mid,
  );
  stmt("INSERT INTO messages_fts(messages_fts,rank) VALUES ('integrity-check',1)").run();
  assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
});

databaseCase('last visible source deletion releases inactive pins and preserves active reads', async () => {
  const { newRequestId } = await import('@tinytavern/shared');
  const { existsSync } = await import('node:fs');
  const { basename, join } = await import('node:path');
  const { stmt, mediaAssetForPath, IMAGES_DIR } = await import('../../server/src/db/db.ts');
  const { saveImage, deleteImageFiles } = await import('../../server/src/media/images.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const { saveMediaRecipe, getMediaRecipe, getMediaAssetInputs } =
    await import('../../server/src/media/mediaRecipes.ts');
  const { createMediaJob, createMediaJobFromAsset } = await import('../../server/src/media/mediaJobs.ts');
  const { updateMediaJob } = await import('../../server/src/media/mediaJobStore.ts');
  const { finishMediaJob } = await import('../../server/src/media/mediaJobResults.ts');
  const { imageConfig } = await import('../support/imageConfig.ts');
  const configuration = {
    ...imageConfig(
      '{"load":{"class_type":"LoadImage","inputs":{"a":"{{input1}}","b":"{{input2}}"}},"save":{"class_type":"SaveImage","inputs":{"images":["load",0]}}}',
      'http://unused.invalid',
    ),
    timeoutSeconds: 60,
  };
  const sources = [0, 1].map(() => mediaAssetForPath(saveImage('.png', makePlaceholderPng()))!);
  const inputs = sources.map((asset, index) => ({
    slot: index ? 'input2' : 'input1',
    assetId: asset.id,
    prompt: `Source ${index}`,
  }));
  const conversation = conversationFixture();
  const message = messageFixture(conversation, {
    images: sources.map((asset) => asset.url),
  });
  const shared = messageFixture(conversation, { images: [sources[0]!.url] });
  const gallery = insertFixture('gallery_items', {
    character_name: 'Test',
    prompt: '',
    image: sources[0]!.url,
    created_at: 1,
    updated_at: 1,
  });
  const recipe = saveMediaRecipe(
    {
      comfyUrl: configuration.comfyUrl,
      workflowId: configuration.workflow.id,
      timeoutSeconds: configuration.timeoutSeconds,
    },
    inputs,
    'Result',
  );
  const output = mediaAssetForPath(saveImage('.png', makePlaceholderPng()))!;
  stmt('UPDATE media_assets SET recipe_id = ? WHERE id = ?').run(recipe, output.id);
  insertFixture('gallery_items', {
    character_name: 'Test',
    prompt: 'Result',
    image: output.url,
    created_at: 1,
    updated_at: 1,
  });
  const idle = createMediaJob({ requestKey: newRequestId(), inputs });
  const active = createMediaJob({ requestKey: newRequestId(), inputs });
  updateMediaJob(active.id, { state: 'rendering' });
  const pins = (id: number) =>
    stmt(`SELECT asset_id FROM media_owners
    WHERE owner_type = 'job' AND owner_id = ? AND slot LIKE 'input:%' ORDER BY asset_id`).all(id);

  attachImages(message, [sources[1]!.url, sources[0]!.url, sources[0]!.url]);
  assert.deepEqual(getMediaRecipe(recipe).inputs, inputs, 'Reordered and repeated attachments retain their references');
  stmt('DELETE FROM messages WHERE id = ?').run(message);
  assert.deepEqual(getMediaRecipe(recipe).inputs, [inputs[0], { ...inputs[1], assetId: null }]);
  assert.deepEqual(pins(idle.id), [{ asset_id: sources[0]!.id }], 'Another message/gallery keeps its input available');
  stmt('DELETE FROM gallery_items WHERE id = ?').run(gallery);
  assert.deepEqual(
    getMediaRecipe(recipe).inputs[0],
    inputs[0],
    'Deleting the gallery owner preserves the remaining chat source',
  );
  attachImages(shared, []);
  assert.deepEqual(
    getMediaRecipe(recipe).inputs,
    inputs.map((input) => ({ ...input, assetId: null })),
  );
  assert.deepEqual(pins(idle.id), [], 'Removing the final alternative releases idle job input pins');
  assert.equal(pins(active.id).length, 2, 'Running work keeps both input files pinned');
  assert.deepEqual(
    getMediaAssetInputs(output.id),
    inputs.map(({ slot }) => ({ slot, asset: null })),
  );
  assert.deepEqual(createMediaJobFromAsset(output.id, { requestKey: newRequestId() }).inputs, []);
  deleteImageFiles(sources.map((asset) => asset.url));
  assert(sources.every((asset) => existsSync(join(IMAGES_DIR, basename(asset.url)))));
  finishMediaJob(active.id, 'failed', 'Test finished');
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert(
    sources.every((asset) => !existsSync(join(IMAGES_DIR, basename(asset.url)))),
    'Finishing active work releases deleted chat inputs',
  );
  assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
});

databaseCase('media characters', async () => {
  const { newRequestId } = await import('@tinytavern/shared');
  type MediaWorkflow = import('@tinytavern/shared').MediaWorkflow;

  const { stmt, mediaAssetForPath } = await import('../../server/src/db/db.ts');
  const { saveImage, copyImage, reserveMediaFile } = await import('../../server/src/media/images.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const { mediaCharacterIds, setMediaCharacters, captureMediaCharacters } =
    await import('../../server/src/media/mediaCharacters.ts');
  const { getSettings, putSettings } = await import('../support/settings.ts');
  const { createMediaJob, startMediaJob, createMediaJobFromAsset } =
    await import('../../server/src/media/mediaJobs.ts');
  const { requireMediaJob, mediaJobDto } = await import('../../server/src/media/mediaJobStore.ts');
  const { recordMediaResult } = await import('../../server/src/media/mediaJobResults.ts');
  const { getMediaRecipe } = await import('../../server/src/media/mediaRecipes.ts');
  const characters = ['Ashina', 'Haeun'].map((name) => insertFixture('characters', { name, created_at: 1 }));
  const inputs = characters.map((characterId) => {
    const path = saveImage('.png', makePlaceholderPng());
    const asset = mediaAssetForPath(path)!;
    galleryFixture(path, { character_name: 'Uploads', prompt: '' });
    setMediaCharacters(asset.id, [characterId]);
    return asset;
  });
  setMediaCharacters(inputs[1]!.id, characters);
  const workflows: MediaWorkflow[] = ['image-edit', 'video-references'].map((operation) => ({
    id: operation,
    name: operation,
    inputBindings: {},
    textOutputNodeId: null,
    standalonePromptPresetId: null,
    chatPromptPresetId: null,
    json: '{"text":{"inputs":{"prompt":"{{prompt}}"}},"a":{"class_type":"LoadImage","inputs":{"image":"reference1.png"},"_meta":{"title":"Input 1 [image:input1]"}},"b":{"class_type":"LoadImage","inputs":{"image":"reference2.png"},"_meta":{"title":"Input 2 [image:input2]"}}}',
  }));
  putSettings({ ...getSettings(), mediaRendering: { ...getSettings().mediaRendering, workflows } });
  const jobs = workflows.map((workflow) => {
    const job = createMediaJob({
      requestKey: newRequestId(),
      workflowId: workflow.id,
      prompt: 'Both characters',
      reviewBeforeSave: true,
      inputs: inputs.map((asset, index) => ({ slot: `input${index + 1}`, assetId: asset.id })),
    });
    assert.deepEqual(job.characterIds, characters, 'Draft cards expose input character associations');
    startMediaJob(requireMediaJob(job.id), {}, false);
    assert.deepEqual(JSON.parse(requireMediaJob(job.id).configuration_json!).characterIds, characters);
    return job;
  });
  setMediaCharacters(inputs[0]!.id, [characters[1]!]);
  setMediaCharacters(inputs[1]!.id, [characters[1]!]);
  assert.deepEqual(
    mediaJobDto(requireMediaJob(jobs[0]!.id)).characterIds,
    characters,
    'Running cards retain the character associations captured by the job',
  );
  assert.deepEqual(
    captureMediaCharacters(requireMediaJob(jobs[0]!.id), JSON.parse(requireMediaJob(jobs[0]!.id).configuration_json!)),
    [characters[1]!],
    'New variations recompute reference associations instead of accumulating old tags',
  );
  stmt('DELETE FROM gallery_items').run();
  setMediaCharacters(inputs[0]!.id, []);
  setMediaCharacters(inputs[1]!.id, []);
  for (const [index, job] of jobs.entries()) {
    const { path } = reserveMediaFile(index ? '.webm' : '.png');
    const assetId = recordMediaResult(job.id, index + 1, {
      path,
      kind: index ? 'video' : 'image',
      mime: index ? 'video/webm' : 'image/png',
      byteSize: 100,
      width: 512,
      height: 512,
      duration: index ? 5 : null,
    });
    assert.deepEqual(
      mediaCharacterIds(assetId),
      characters,
      'Results retain captured associations after reference deletion',
    );
    assert.deepEqual(getMediaRecipe(job.id).configuration.characterIds, characters);
    const rerun = createMediaJobFromAsset(assetId, { requestKey: newRequestId() });
    assert.deepEqual(JSON.parse(requireMediaJob(rerun.id).configuration_json!).characterIds, characters);
  }
  const original = saveImage('.png', makePlaceholderPng());
  const originalAsset = mediaAssetForPath(original)!;
  setMediaCharacters(originalAsset.id, characters);
  const copy = copyImage(original)!;
  const copiedAsset = mediaAssetForPath(copy)!;
  assert.deepEqual(mediaCharacterIds(copiedAsset.id), characters);
  setMediaCharacters(copiedAsset.id, [characters[1]!]);
  assert.deepEqual(mediaCharacterIds(originalAsset.id), characters, 'Copies can be organized independently');
  stmt('DELETE FROM characters WHERE id = ?').run(characters[0]!);
  assert.deepEqual(mediaCharacterIds(originalAsset.id), [characters[1]!]);
  assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
});

databaseCase('temporary media job', async () => {
  const { existsSync } = await import('node:fs');
  const { basename, join } = await import('node:path');
  type MediaJobState = import('@tinytavern/shared').MediaJobState;
  const { stmt, IMAGES_DIR, mediaAssetForPath } = await import('../../server/src/db/db.ts');
  const { saveImage } = await import('../../server/src/media/images.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const { consumeTemporaryMediaJob } = await import('../../server/src/media/temporaryMediaJob.ts');
  const { requireMediaJob, mediaJobRow, hasMediaJobObservers } =
    await import('../../server/src/media/mediaJobStore.ts');
  const { stopMediaWorker } = await import('../../server/src/media/mediaWorker.ts');
  const { deleteMediaJob } = await import('../../server/src/media/mediaJobs.ts');
  stopMediaWorker(); // Exercise consumption and cancellation without starting remote work.

  const files = new Map<number, string>();
  function job(id: number, state: MediaJobState = 'succeeded') {
    const path = saveImage('.png', makePlaceholderPng());
    files.set(id, join(IMAGES_DIR, basename(path)));
    const asset = mediaAssetForPath(path)!;
    stmt(`INSERT INTO media_jobs (id, state, configuration_json, outputs_json,
    created_at, updated_at) VALUES (?, ?, '{"temporary":true}', ?, 1, 1)`).run(id, state, JSON.stringify([asset.id]));
    stmt("INSERT INTO media_owners VALUES (?, 'job', ?, 'output:1')").run(asset.id, id);
    return requireMediaJob(id);
  }

  const completed = job(1);
  let finishRead!: () => void;
  const read = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  const result = consumeTemporaryMediaJob(completed, {}, async () => {
    await read;
    assert(existsSync(files.get(1)!), 'Ownership lasts through the read');
    return 'bytes';
  });
  await Promise.resolve();
  assert(hasMediaJobObservers(completed.id), 'Worker cleanup must wait for asynchronous consumption');
  finishRead();
  assert.equal(await result, 'bytes');
  assert(!mediaJobRow(completed.id));
  assert(!existsSync(files.get(1)!));
  assert(!hasMediaJobObservers(completed.id));

  for (const [id, state, error] of [
    [2, 'succeeded', /Read failed/],
    [5, 'failed', /cancelled/],
  ] as const) {
    await assert.rejects(
      consumeTemporaryMediaJob(job(id, state), {}, () => {
        assert.equal(state, 'succeeded', 'Failed jobs are never consumed');
        throw new Error('Read failed');
      }),
      error,
    );
    assert(!mediaJobRow(id));
    assert(!existsSync(files.get(id)!));
  }

  const abort = new AbortController();
  abort.abort(new Error('Already cancelled'));
  await assert.rejects(
    consumeTemporaryMediaJob(
      job(3, 'preparing'),
      {
        signal: abort.signal,
      },
      () => assert.fail('An aborted job must not be consumed'),
    ),
    /Already cancelled/,
  );
  assert(!mediaJobRow(3), 'Prompt cancellation releases its result immediately');

  const runningAbort = new AbortController();
  await assert.rejects(
    consumeTemporaryMediaJob(
      job(4, 'rendering'),
      {
        signal: runningAbort.signal,
        onProgress: () => runningAbort.abort(new Error('Disconnected')),
      },
      () => assert.fail('An aborted job must not be consumed'),
    ),
    /Disconnected/,
  );
  assert.equal(requireMediaJob(4).state, 'cancelling');
  assert(existsSync(files.get(4)!), 'Remote execution retains ownership until stopped');
  assert(!hasMediaJobObservers(4), 'The worker can reclaim the cancelled job after stopping it');
  stmt("UPDATE media_jobs SET state = 'cancelled' WHERE id = 4").run();
  deleteMediaJob(requireMediaJob(4));
  assert(!existsSync(files.get(4)!));

  assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
});

databaseCase('attachment snapshots share invalidated metadata without caching ownership', async () => {
  const { stmt, mediaAssetForPath, invalidateMediaAsset } = await import('../../server/src/db/db.ts');
  const { getTreeMessages, getMessage } = await import('../../server/src/conversations/tree.ts');
  const { saveImage } = await import('../../server/src/media/images.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const path = saveImage('.png', makePlaceholderPng());
  const original = mediaAssetForPath(path)!;
  const conversation = conversationFixture();
  const first = messageFixture(conversation, { images: [path, path] });
  const second = messageFixture(conversation, { images: [path] });
  const before = getTreeMessages(conversation);
  assert.equal(before[0]!.media[0], before[1]!.media[0], 'Repeated references reuse the same cached metadata');
  stmt('UPDATE media_assets SET width = 42, thumbnail_revision = 3 WHERE id = ?').run(original.id);
  invalidateMediaAsset(path);
  const after = getTreeMessages(conversation);
  assert.equal(after[0]!.media[0]!.width, 42);
  assert.equal(after[0]!.media[1]!.thumbnailRevision, 3);
  assert.equal(mediaAssetForPath(path), after[0]!.media[0]);
  attachImages(first, []);
  assert.deepEqual(getMessage(first)!.media, []);
  assert.equal(getMessage(second)!.media[0]!.width, 42);
});
