import assert from 'node:assert/strict';
import { databaseCase } from '../support/database.ts';

databaseCase('conversation transfer', async () => {
  const { imageConfig } = await import('../support/imageConfig.ts');

  // Run through npm test for isolated data; this script is destructive.
  const { existsSync, readFileSync } = await import('node:fs');

  const { join } = await import('node:path');

  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const { IMAGES_DIR, stmt } = await import('../../server/src/db.ts');
  const { deleteImageFiles, saveImage } = await import('../../server/src/images.ts');
  const { exportPortableConversation, importPortableConversation } =
    await import('../../server/src/routes/conversationTransfer.ts');
  const { getPathToMessage } = await import('../../server/src/tree.ts');

  let passed = 0;
  function assert(value: unknown, label: string): asserts value {
    if (!value) throw new Error(`ASSERT FAILED: ${label}`);
    passed++;
  }

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const sourceImages = [saveImage('.png', png), saveImage('.png', png)];
  const { createImageRecipe, getMediaRecipe } = await import('../../server/src/mediaRecipes.ts');
  const now = Date.now();
  const convResult = stmt(
    `INSERT INTO conversations (title, speaker_name, scenario_override, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?)`,
  ).run('Portable tree', 'Narrator', 'A portable scenario', now - 1000, now);
  const sourceConversationId = Number(convResult.lastInsertRowid);
  const insert = stmt(
    `INSERT INTO messages
     (conversation_id, parent_id, role, content, reasoning, status, active_child_id,
      model, gen_meta_json, created_at, name, generation_kind, images_json,
      active_image, image_pending, render_recipe_id)
   VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  );
  const root = Number(
    insert.run(
      sourceConversationId,
      null,
      'user',
      'Root prompt',
      null,
      'done',
      null,
      null,
      now - 900,
      null,
      'normal',
      '[]',
      0,
      null,
    ).lastInsertRowid,
  );
  // Middle splices can give parents greater IDs than their children.
  const continuation = Number(
    insert.run(
      sourceConversationId,
      null,
      'assistant',
      'Older continuation',
      'reasoning',
      'done',
      'model-a',
      JSON.stringify({ note: 'kept' }),
      now - 800,
      'Narrator',
      'normal',
      '[]',
      0,
      null,
    ).lastInsertRowid,
  );
  const imagePrompt = Number(
    insert.run(
      sourceConversationId,
      root,
      'tool',
      'Long silver hair like the previous portrait',
      null,
      'done',
      null,
      null,
      now - 700,
      'Image',
      'normal',
      JSON.stringify(sourceImages),
      1,
      createImageRecipe(
        imageConfig(
          '{"node":{"inputs":{"text":"{{prompt}}","seed":{{seed}}}}}',
          'http://comfy:8588',
        ),
        'image prompt',
      ),
    ).lastInsertRowid,
  );
  const alternate = Number(
    insert.run(
      sourceConversationId,
      root,
      'tool',
      'Short red hair',
      null,
      'done',
      null,
      null,
      now - 600,
      'Image',
      'normal',
      JSON.stringify([sourceImages[0]]),
      0,
      null,
    ).lastInsertRowid,
  );
  stmt('UPDATE messages SET parent_id = ? WHERE id = ?').run(imagePrompt, continuation);
  stmt('UPDATE messages SET active_child_id = ? WHERE id = ?').run(imagePrompt, root);
  stmt('UPDATE messages SET active_child_id = ? WHERE id = ?').run(continuation, imagePrompt);
  stmt('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run(
    continuation,
    sourceConversationId,
  );

  const portable = exportPortableConversation(sourceConversationId);
  assert(
    portable.format === 'tinytavern-conversation' && portable.version === 1,
    'schema is versioned',
  );
  assert(
    portable.conversation.scenarioOverride === 'A portable scenario',
    'conversation scenario override is exported',
  );
  assert(portable.assets.length === 2, 'all image alternatives are embedded');
  assert(
    portable.recipes
      ?.find(
        (recipe) =>
          recipe.id ===
          portable.messages.find((message) => message.id === imagePrompt)?.renderRecipeId,
      )
      ?.workflow.json.includes('{{prompt}}'),
    'image prompt and render configuration are exported',
  );

  const countBeforeInvalid = (
    stmt('SELECT count(*) AS n FROM conversations').get() as { n: number }
  ).n;
  const invalid = structuredClone(portable);
  invalid.messages.find((message) => message.id === root)!.parentId = continuation;
  let rejected = false;
  try {
    importPortableConversation(invalid);
  } catch {
    rejected = true;
  }
  assert(rejected, 'cyclic trees are rejected');
  assert(
    (stmt('SELECT count(*) AS n FROM conversations').get() as { n: number }).n ===
      countBeforeInvalid,
    'invalid imports leave no conversation behind',
  );

  stmt('DELETE FROM conversations WHERE id = ?').run(sourceConversationId);
  deleteImageFiles(sourceImages);
  assert(
    sourceImages.every((path) => !existsSync(join(IMAGES_DIR, path.slice('/images/'.length)))),
    'source-server image files are absent before import',
  );

  const imported = importPortableConversation(portable);
  for (const row of stmt('SELECT id, path FROM media_assets').all()) {
    assert(
      new RegExp(`^/images/media-${row.id}\\.(png|jpe?g|webp|webm)$`).test(String(row.path)),
      'imported originals use ownership-neutral names',
    );
  }
  assert(
    imported.scenarioOverride === 'A portable scenario',
    'conversation scenario override is imported',
  );
  const importedRows = stmt('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(
    imported.id,
  ) as Record<string, unknown>[];
  assert(importedRows.length === 4, 'all branches import');
  const importedLeaf = imported.activeLeafId!;
  const path = getPathToMessage(importedLeaf);
  assert(
    path.map((message) => message.content).join('|') ===
      'Root prompt|Long silver hair like the previous portrait|Older continuation',
    'parent links and selected deep branch round-trip',
  );
  const importedRoot = path[0]!;
  const importedPrompt = path[1]!;
  assert(importedRoot.activeChildId === importedPrompt.id, 'selected alternative is preserved');
  assert(importedPrompt.activeChildId === importedLeaf, 'deep active-child link is preserved');
  assert(
    importedPrompt.media.length === 2 && importedPrompt.activeImage === 1,
    'selected image alternative round-trips',
  );
  assert(
    importedPrompt.media.every(
      ({ url: path }) =>
        !sourceImages.includes(path) &&
        existsSync(join(IMAGES_DIR, path.slice('/images/'.length))) &&
        readFileSync(join(IMAGES_DIR, path.slice('/images/'.length))).equals(png),
    ),
    'import writes independent, byte-identical image files',
  );
  const importedPromptRow = stmt('SELECT render_recipe_id FROM messages WHERE id = ?').get(
    importedPrompt.id,
  ) as { render_recipe_id: string };
  assert(
    getMediaRecipe(importedPromptRow.render_recipe_id).configuration.workflow.json.includes(
      '{{seed}}',
    ),
    'stored render configuration still supports rerendering',
  );
  const sibling = importedRows.find((row) => row.content === 'Short red hair');
  assert(sibling?.parent_id === importedRoot.id, 'inactive sibling branch round-trips');
  const siblingImages = JSON.parse(sibling!.images_json as string) as string[];
  assert(
    siblingImages.length === 1 &&
      siblingImages[0] !== importedPrompt.media[0]!.url &&
      existsSync(join(IMAGES_DIR, siblingImages[0]!.slice('/images/'.length))),
    'a reused embedded asset gets per-message files with independent deletion ownership',
  );

  // Videos are deliberately absent on disk: exporting them must not read their bytes.
  const mixedPaths = [
    '/images/omitted-first.webm',
    ...importedPrompt.media.map((asset) => asset.url),
    '/images/omitted-last.webm',
  ];
  stmt('UPDATE messages SET images_json = ?, active_image = ? WHERE id = ?').run(
    JSON.stringify(mixedPaths),
    2,
    importedPrompt.id,
  );
  const mixed = exportPortableConversation(imported.id);
  const mixedPrompt = mixed.messages.find((message) => message.id === importedPrompt.id)!;
  assert(
    mixedPrompt.imageAssetIds.length === 2,
    'video attachments are omitted from mixed messages',
  );
  assert(mixedPrompt.activeImage === 1, 'selected raster index accounts for omitted videos');
  assert(
    importPortableConversation(mixed).activeLeafId !== null,
    'mixed-media export remains importable',
  );

  stmt('UPDATE messages SET active_image = ? WHERE id = ?').run(3, importedPrompt.id);
  const selectedVideo = exportPortableConversation(imported.id);
  assert(
    selectedVideo.messages.find((message) => message.id === importedPrompt.id)!.activeImage === 1,
    'an omitted selected video falls back to the nearest preceding image',
  );
  stmt('UPDATE messages SET images_json = ?, active_image = 0 WHERE id = ?').run(
    JSON.stringify(['/images/omitted-only.webm']),
    importedPrompt.id,
  );
  const { mediaPromptBuffers } = await import('../../server/src/mediaJobStore.ts');
  mediaPromptBuffers.set(importedPrompt.id, {
    prompt: 'Video prompt currently streaming',
    reasoning: '',
  });
  const onlyVideo = exportPortableConversation(imported.id);
  mediaPromptBuffers.delete(importedPrompt.id);
  const videoPrompt = onlyVideo.messages.find((message) => message.id === importedPrompt.id)!;
  assert(
    videoPrompt.imageAssetIds.length === 0 && videoPrompt.activeImage === 0,
    'video-only messages have an empty valid attachment selection',
  );
  assert(
    videoPrompt.content === 'Video prompt currently streaming',
    'export includes the latest in-memory media prompt',
  );
  const importedVideo = importPortableConversation(onlyVideo);
  assert(
    getPathToMessage(importedVideo.activeLeafId!).length === 3,
    'video omission preserves the entire message path',
  );
});

databaseCase('conversation copy', async () => {
  const { imageConfig } = await import('../support/imageConfig.ts');

  const { basename, join } = await import('node:path');

  const { existsSync, readdirSync, readFileSync } = await import('node:fs');

  type MessageRow = import('../../server/src/routes/conversationCopies.ts').MessageRow;
  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const { IMAGES_DIR, stmt, toConversation, toMessage } = await import('../../server/src/db.ts');
  const { saveImage, deleteImageFiles } = await import('../../server/src/images.ts');
  const { copyConversation, copyMessageImages, insertCopiedMessage } =
    await import('../../server/src/routes/conversationCopies.ts');
  const { createImageRecipe } = await import('../../server/src/mediaRecipes.ts');
  const { makePlaceholderPng } = await import('../../server/src/pngCard.ts');

  const png = makePlaceholderPng();
  const images = ['/images/missing.png', saveImage('.png', png), saveImage('.png', png)];
  const now = Date.now();
  const id = Number(
    stmt('INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)').run(
      'Source',
      now,
      now,
    ).lastInsertRowid,
  );
  const messageId = Number(
    stmt(`INSERT INTO messages
  (conversation_id, role, content, reasoning, status, model, gen_meta_json, created_at, images_json, active_image, image_pending, render_recipe_id)
  VALUES (?, 'assistant', 'persisted', 'persisted reasoning', 'streaming', 'model', '{"test":true}', ?, ?, 1, 1, ?)`).run(
      id,
      now,
      JSON.stringify(images),
      createImageRecipe(
        imageConfig('{"1":{"inputs":{"text":"{{prompt}}"}}}', 'http://comfy.invalid'),
        'persisted',
      ),
    ).lastInsertRowid,
  );
  const source = toConversation(stmt('SELECT * FROM conversations WHERE id = ?').get(id)!);
  const row = stmt('SELECT * FROM messages WHERE id = ?').get(messageId)!;
  const live = { ...toMessage(row), content: 'live content', reasoning: 'live reasoning' };
  assert.deepEqual(
    live.media.map((asset) => asset.url),
    images,
    'Attachment order includes a missing file rather than shifting the selected asset',
  );
  assert.equal(live.media[live.activeImage]!.url, images[1]);
  assert.equal('images' in live, false, 'The live DTO has one ordered attachment representation');
  let copiedMessageId = 0;
  const copiedConversationId = copyConversation(source, ' (copy)', (conversationId, written) => {
    copiedMessageId = insertCopiedMessage(
      conversationId,
      null,
      row as unknown as MessageRow,
      live,
      written,
    );
  });
  const copiedRow = stmt('SELECT * FROM messages WHERE id = ?').get(copiedMessageId)!;
  const copied = toMessage(copiedRow);
  assert.equal(copied.conversationId, copiedConversationId);
  assert.equal(copied.content, live.content);
  assert.equal(copied.reasoning, live.reasoning);
  assert.equal(copied.status, 'stopped');
  assert.equal(copied.imagePending, false);
  assert.equal(copiedRow.render_recipe_id, row.render_recipe_id);
  assert.equal(copiedRow.gen_meta_json, row.gen_meta_json);
  assert.equal(copied.media.length, 2);
  for (const asset of copied.media) {
    assert.match(
      asset.url,
      new RegExp(`^/images/media-${asset.id}\\.(png|jpe?g|webp|webm)$`),
      'Copies of legacy paths use ownership-neutral original names',
    );
  }
  assert.equal(
    copied.activeImage,
    0,
    'selected A retains its identity after the preceding missing file is skipped',
  );
  assert.notEqual(copied.media[0]!.url, images[1]);
  assert.deepEqual(readFileSync(join(IMAGES_DIR, basename(copied.media[0]!.url))), png);

  for (const [selected, expected] of [
    [0, 0],
    [1, 0],
    [2, 1],
  ]) {
    const written: string[] = [];
    const result = copyMessageImages({ media: live.media, activeImage: selected! }, written);
    assert.equal(result.activeImage, expected);
    deleteImageFiles(written);
  }
  const filesBefore = readdirSync(IMAGES_DIR).sort();
  const countBefore = stmt('SELECT COUNT(*) AS n FROM conversations').get()!.n;
  assert.throws(
    () =>
      copyConversation(source, ' (failed)', (conversationId, written) => {
        insertCopiedMessage(conversationId, null, row as unknown as MessageRow, live, written);
        throw new Error('injected after copy');
      }),
    /injected after copy/,
  );
  assert.equal(stmt('SELECT COUNT(*) AS n FROM conversations').get()!.n, countBefore);
  assert.deepEqual(
    readdirSync(IMAGES_DIR).sort(),
    filesBefore,
    'rolled-back copies leave no files',
  );

  deleteImageFiles(images);
  for (const asset of copied.media)
    assert.ok(existsSync(join(IMAGES_DIR, basename(asset.url))), 'copy owns files independently');
});

databaseCase('media transfer', async () => {
  const { randomUUID } = await import('node:crypto');

  const { existsSync, readFileSync, readdirSync } = await import('node:fs');

  const { basename, join } = await import('node:path');

  type MediaJobInput = import('@tinytavern/shared').MediaJobInput;
  type MediaWorkflow = import('@tinytavern/shared').MediaWorkflow;
  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const { IMAGES_DIR, stmt, mediaAssetForPath, invalidateMediaAsset } =
    await import('../../server/src/db.ts');
  const { saveImage, deleteImageFiles, collectConversationImages } =
    await import('../../server/src/images.ts');
  const { exportPortableConversation, importPortableConversation } =
    await import('../../server/src/routes/conversationTransfer.ts');
  const { makePlaceholderPng } = await import('../../server/src/pngCard.ts');
  const { createMediaJobFromAsset, deleteMediaJob } = await import('../../server/src/mediaJobs.ts');
  const { getSettings } = await import('../../server/src/settingsStore.ts');
  const { requireMediaJob } = await import('../../server/src/mediaJobStore.ts');

  const { mediaCharacterIds, setMediaCharacters } =
    await import('../../server/src/mediaCharacters.ts');
  const organizationCharacters = ['Ashina', 'Haeun'].map((name) =>
    Number(
      stmt('INSERT INTO characters(name, created_at) VALUES (?, 1)').run(name).lastInsertRowid,
    ),
  );
  const png = makePlaceholderPng();
  const source = saveImage('.png', png);
  const reference = saveImage('.png', png);
  const output = saveImage('.png', png);
  const sourceId = mediaAssetForPath(source)!.id;
  const referenceId = mediaAssetForPath(reference)!.id;
  const workflow: MediaWorkflow = {
    id: 'saved-edit',
    name: 'Edit with references',
    operation: 'image-edit',
    referenceCount: 3,
    galleryPromptPresetId: 'private-preset',
    chatPromptPresetId: 'private-preset',
    json: JSON.stringify({
      strength: {
        class_type: 'PrimitiveFloat',
        inputs: { value: 0.5 },
        _meta: { title: 'Strength [input: min=0, max=1, step=0.1]' },
      },
      text: { class_type: 'Prompt', inputs: { text: '{{prompt}}' } },
      load: {
        class_type: 'Load',
        inputs: {
          a: '{{reference1}}',
          b: '{{reference2}}',
          c: '{{reference3}}',
        },
      },
      save: { class_type: 'SaveImage', inputs: { filename_prefix: '{{job_id}}' } },
    }),
  };
  const inputs: MediaJobInput[] = [
    { slot: 'reference3', assetId: referenceId },
    { slot: 'reference2', assetId: referenceId },
    { slot: 'reference1', assetId: sourceId },
  ];
  function recipe(id: string, path: string, workflow: MediaWorkflow, inputs: MediaJobInput[]) {
    stmt(
      'INSERT INTO media_recipes(id, prompt, instruction, configuration_json, inputs_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      'Preserve the subject',
      '  Change the background.\nKeep the pose.  ',
      JSON.stringify({
        comfyUrl: 'http://private-user:private-secret@source-only:8588',
        timeoutSeconds: 1234,
        workflow,
        workflowValues: workflow.id === 'saved-edit' ? { strength: 0.8 } : {},
        temporary: true,
        executionSecret: 'must-not-export',
      }),
      JSON.stringify(inputs.map((input) => ({ ...input, prompt: 'Captured source prompt' }))),
      Date.now(),
    );
    stmt('UPDATE media_assets SET recipe_id = ? WHERE path = ?').run(id, path);
    invalidateMediaAsset(path);
    for (const input of inputs) {
      stmt("INSERT INTO media_owners VALUES (?, 'recipe', ?, ?)").run(
        input.assetId,
        id,
        input.slot,
      );
    }
  }
  recipe(
    'original-recipe',
    source,
    {
      ...workflow,
      id: 'original-image',
      name: 'Create image',
      operation: 'image',
      referenceCount: 0,
      json: '{"save":{"class_type":"SaveImage","inputs":{"text":"{{prompt}}"}}}',
    },
    [],
  );
  recipe('edit-recipe', output, workflow, inputs);
  setMediaCharacters(mediaAssetForPath(output)!.id, organizationCharacters);
  setMediaCharacters(sourceId, organizationCharacters);
  const conversationId = Number(
    stmt(
      "INSERT INTO conversations(title, created_at, updated_at) VALUES ('Recipe transfer', 1, 1)",
    ).run().lastInsertRowid,
  );
  const insert = stmt(
    "INSERT INTO messages(conversation_id, parent_id, role, content, images_json, created_at) VALUES (?, ?, 'tool', 'Preserve the subject', ?, 1)",
  );
  const rootId = Number(insert.run(conversationId, null, JSON.stringify([output])).lastInsertRowid);
  const leafId = Number(
    insert.run(conversationId, rootId, JSON.stringify([output])).lastInsertRowid,
  );
  stmt('UPDATE messages SET active_child_id = ? WHERE id = ?').run(leafId, rootId);
  stmt('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run(leafId, conversationId);
  const portable = exportPortableConversation(conversationId);
  assert.equal(
    portable.assets.length,
    3,
    'Repeated source/reference slots embed each raster only once',
  );
  assert.equal(portable.recipes!.length, 2, 'Export follows recipes on referenced images');
  assert.deepEqual(
    portable.recipes![0]!.inputs.map((input) => input.slot),
    ['reference1', 'reference2', 'reference3'],
  );
  const json = JSON.stringify(portable);
  for (const secret of [
    'private-secret',
    'private-user',
    'source-only',
    'must-not-export',
    'private-preset',
    'original-recipe',
    'edit-recipe',
  ]) {
    assert(
      !json.includes(secret),
      `Connection/execution identity ${secret} stays on the source server`,
    );
  }
  stmt('DELETE FROM conversations WHERE id = ?').run(conversationId);
  deleteImageFiles([output]);
  assert.equal(stmt('SELECT count(*) AS n FROM media_assets').get()!.n, 0);
  assert.equal(stmt('SELECT count(*) AS n FROM media_recipes').get()!.n, 0);
  assert.equal(readdirSync(IMAGES_DIR).length, 0);

  const imported = importPortableConversation(portable);
  for (const row of stmt('SELECT id, path FROM media_assets').all()) {
    assert.match(
      String(row.path),
      new RegExp(`^/images/media-${row.id}\\.(png|jpe?g|webp|webm)$`),
      'Imported results and transitive inputs use ownership-neutral original names',
    );
  }
  const paths = collectConversationImages(imported.id);
  assert.equal(paths.length, 2);
  assert.notEqual(
    paths[0],
    paths[1],
    'Each imported message has an independently owned result file',
  );
  const asset = mediaAssetForPath(paths[0]!)!;
  assert.deepEqual(
    mediaCharacterIds(asset.id),
    organizationCharacters,
    'Image exports retain named character associations',
  );
  const importedRecipe = stmt('SELECT * FROM media_recipes WHERE id = ?').get(asset.recipeId!)!;
  const configuration = JSON.parse(String(importedRecipe.configuration_json));
  assert.equal(configuration.comfyUrl, getSettings().mediaRendering.comfyUrl);
  assert.equal(configuration.workflow.json, workflow.json);
  assert.equal(configuration.workflow.galleryPromptPresetId, null);
  assert.equal(configuration.workflow.chatPromptPresetId, null);
  assert.deepEqual(configuration.workflowValues, { strength: 0.8 });
  const importedInputs = JSON.parse(String(importedRecipe.inputs_json)) as MediaJobInput[];
  assert.notEqual(importedInputs[0]!.assetId, importedInputs[1]!.assetId);
  assert.equal(importedInputs[1]!.assetId, importedInputs[2]!.assetId);
  for (const input of importedInputs) {
    const row = stmt('SELECT path FROM media_assets WHERE id = ?').get(input.assetId)!;
    assert.deepEqual(readFileSync(join(IMAGES_DIR, basename(String(row.path)))), png);
  }
  const rerun = createMediaJobFromAsset(asset.id, { requestKey: randomUUID() });
  assert.equal(rerun.operation, 'image-edit');
  assert.equal(
    rerun.instruction,
    '  Change the background.\nKeep the pose.  ',
    'Exports preserve editable instructions',
  );
  assert.equal(rerun.inputs.length, 3);
  assert.deepEqual(rerun.workflowValues, { strength: 0.8 });
  assert.equal(
    rerun.workflowSnapshot!.json,
    workflow.json,
    'Imported result reruns without a saved workflow or source job',
  );
  deleteMediaJob(requireMediaJob(rerun.id));
  stmt('DELETE FROM conversations WHERE id = ?').run(imported.id);
  deleteImageFiles(paths);
  assert.equal(
    readdirSync(IMAGES_DIR).length,
    0,
    'Deleting imported results releases all transitive reference files',
  );
  assert.equal(stmt('SELECT count(*) AS n FROM media_recipes').get()!.n, 0);

  const invalidCases = [
    (value: typeof portable) => {
      value.recipes![0]!.inputs[0]!.assetId = 'missing';
    },
    (value: typeof portable) => {
      value.recipes![0]!.inputs[0]!.assetId = value.messages[0]!.imageAssetIds[0]!;
    },
    (value: typeof portable) => {
      value.recipes!.push({ ...value.recipes![1]!, id: 'unused' });
    },
    (value: typeof portable) => {
      value.recipes![0]!.inputs.reverse();
    },
  ];
  for (const mutate of invalidCases) {
    const invalid = structuredClone(portable);
    mutate(invalid);
    assert.throws(() => importPortableConversation(invalid), /recipe|reference/i);
    assert.equal(stmt('SELECT count(*) AS n FROM conversations').get()!.n, 0);
    assert.equal(readdirSync(IMAGES_DIR).length, 0, 'Invalid recipe imports never write files');
  }
  stmt(
    "CREATE TRIGGER reject_transfer BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected import failure'); END",
  ).run();
  assert.throws(() => importPortableConversation(portable), /injected import failure/);
  stmt('DROP TRIGGER reject_transfer').run();
  assert.equal(stmt('SELECT count(*) AS n FROM conversations').get()!.n, 0);
  assert.equal(stmt('SELECT count(*) AS n FROM media_recipes').get()!.n, 0);
  assert.equal(stmt('SELECT count(*) AS n FROM media_assets').get()!.n, 0);
  assert.equal(
    readdirSync(IMAGES_DIR).length,
    0,
    'Failed SQL commits discard every imported raster',
  );
  assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
  assert(!existsSync(join(IMAGES_DIR, basename(output))));

  const emptySource = importPortableConversation(portable);
  const emptyRows = stmt('SELECT id, images_json FROM messages WHERE conversation_id = ?').all(
    emptySource.id,
  );
  for (const row of emptyRows) {
    const path = (JSON.parse(String(row.images_json)) as string[])[0]!;
    const recipeId = mediaAssetForPath(path)!.recipeId!;
    stmt('UPDATE messages SET render_recipe_id = ? WHERE id = ?').run(recipeId, row.id!);
  }
  const originalFiles = collectConversationImages(emptySource.id);
  stmt("UPDATE messages SET images_json = '[]', active_image = 0 WHERE conversation_id = ?").run(
    emptySource.id,
  );
  deleteImageFiles(originalFiles);
  const emptyExport = exportPortableConversation(emptySource.id);
  assert(
    emptyExport.messages.every(
      (message) => message.renderRecipeId && message.imageAssetIds.length === 0,
    ),
  );
  assert.equal(
    emptyExport.assets.length,
    2,
    'Exporting a recipe without outputs still includes its transitive references',
  );
  const emptyCopy = importPortableConversation(emptyExport);
  assert(
    stmt('SELECT render_recipe_id FROM messages WHERE conversation_id = ? LIMIT 1').get(
      emptyCopy.id,
    )!.render_recipe_id,
  );
  for (const id of [emptySource.id, emptyCopy.id]) {
    const files = collectConversationImages(id);
    stmt('DELETE FROM conversations WHERE id = ?').run(id);
    deleteImageFiles(files);
  }
  assert.equal(
    readdirSync(IMAGES_DIR).length,
    0,
    'Deleting messages without outputs releases their remaining recipe inputs',
  );
  assert.equal(stmt('SELECT count(*) AS n FROM media_recipes').get()!.n, 0);
  const missingReferences = structuredClone(portable);
  const editedRecipe = missingReferences.recipes![0]!;
  for (const input of editedRecipe.inputs) input.assetId = null;
  missingReferences.recipes = [editedRecipe];
  missingReferences.assets = missingReferences.assets.filter(
    (asset) => asset.recipeId === editedRecipe.id,
  );
  const missingCopy = importPortableConversation(missingReferences);
  const missingExport = exportPortableConversation(missingCopy.id);
  assert.deepEqual(
    missingExport.recipes![0]!.inputs,
    editedRecipe.inputs,
    'Import/export preserves every deleted input slot without an image file',
  );
  const missingPaths = collectConversationImages(missingCopy.id);
  const missingRerun = createMediaJobFromAsset(mediaAssetForPath(missingPaths[0]!)!.id, {
    requestKey: randomUUID(),
  });
  assert.deepEqual(missingRerun.inputs, []);
  assert.equal(missingRerun.workflowSnapshot!.referenceCount, 3);
  deleteMediaJob(requireMediaJob(missingRerun.id));
  stmt('DELETE FROM conversations WHERE id = ?').run(missingCopy.id);
  deleteImageFiles(missingPaths);
  assert.equal(readdirSync(IMAGES_DIR).length, 0);
  assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
});
