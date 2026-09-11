import { putSettings } from '../../server/src/settings/settingsStore.ts';
import { requireMediaWorkflow } from '../../server/src/media/mediaWorkflows.ts';
import assert from 'node:assert/strict';
import { databaseCase } from '../support/database.ts';
import { conversationFixture, messageFixture } from '../support/fixtures.ts';
import { imageConfig } from '../support/imageConfig.ts';
import { basename, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

databaseCase('conversation copies retain live media prompts', async () => {
  const { stmt } = await import('../../server/src/db/db.ts');
  const { mediaPromptBuffers } = await import('../../server/src/media/mediaJobStore.ts');
  const { getActivePath, setActiveLeaf } = await import('../../server/src/conversations/tree.ts');
  await import('../../server/src/routes/conversations.ts');
  const { testApi } = await import('../support/http.ts');
  const { server, request } = await testApi();
  const conversationId = conversationFixture();
  const messageId = messageFixture(conversationId, {
    role: 'tool',
    content: '',
    status: 'streaming',
    image_pending: 1,
  });
  setActiveLeaf(conversationId, messageId);
  mediaPromptBuffers.set(messageId, {
    prompt: 'Visible partial prompt',
    reasoning: 'Live reasoning',
  });
  try {
    const tree = await request('GET', `/api/conversations/${conversationId}/tree`);
    for (const path of [
      `/api/conversations/${conversationId}/duplicate`,
      `/api/messages/${messageId}/branch-conversation`,
    ]) {
      const copy = await request('POST', path);
      const message = getActivePath(copy.id)[0]!;
      assert.equal(message.content, tree.messages[0].content);
      assert.equal(message.reasoning, tree.messages[0].reasoning);
      assert.equal(message.content, 'Visible partial prompt');
      assert.equal(message.reasoning, 'Live reasoning');
      assert.equal(message.status, 'stopped');
      assert.equal(message.imagePending, false);
    }
    assert.equal(stmt('SELECT content FROM messages WHERE id = ?').get(messageId)!.content, '');
  } finally {
    mediaPromptBuffers.delete(messageId);
    server.stop(true);
  }
});

databaseCase('conversation transfer', async () => {
  const { IMAGES_DIR, stmt } = await import('../../server/src/db/db.ts');
  const { deleteImageFiles, saveImage } = await import('../../server/src/media/images.ts');
  const { exportPortableConversation, importPortableConversation } =
    await import('../../server/src/routes/conversationTransfer.ts');
  const { getPathToMessage } = await import('../../server/src/conversations/tree.ts');

  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const png = makePlaceholderPng();
  const sourceImages = [saveImage('.png', png), saveImage('.png', png)];
  const { createImageRecipe, getMediaRecipe } =
    await import('../../server/src/media/mediaRecipes.ts');
  const now = Date.now();
  const sourceConversationId = conversationFixture({
    title: 'Portable tree',
    speaker_name: 'Narrator',
    scenario_override: 'A portable scenario',
    created_at: now - 1000,
    updated_at: now,
  });
  const root = messageFixture(sourceConversationId, {
    role: 'user',
    content: 'Root prompt',
    created_at: now - 900,
  });
  // Middle splices can give parents greater IDs than their children.
  const continuation = messageFixture(sourceConversationId, {
    content: 'Older continuation',
    reasoning: 'reasoning',
    model: 'model-a',
    gen_meta_json: JSON.stringify({ note: 'kept' }),
    name: 'Narrator',
    created_at: now - 800,
  });
  const imagePrompt = messageFixture(sourceConversationId, {
    parent_id: root,
    role: 'tool',
    content: 'Long silver hair like the previous portrait',
    name: 'Image',
    images_json: JSON.stringify(sourceImages),
    active_image: 1,
    created_at: now - 700,
    render_recipe_id: createImageRecipe(
      imageConfig('{"node":{"inputs":{"text":"{{prompt}}","seed":0}}}', 'http://comfy:8588'),
      'image prompt',
    ),
  });
  messageFixture(sourceConversationId, {
    parent_id: root,
    role: 'tool',
    content: 'Short red hair',
    name: 'Image',
    images_json: JSON.stringify([sourceImages[0]]),
    created_at: now - 600,
  });
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

  const conversationCount = () => stmt('SELECT count(*) AS n FROM conversations').get()!.n;
  const countBeforeInvalid = conversationCount();
  const invalid = structuredClone(portable);
  invalid.messages.find((message) => message.id === root)!.parentId = continuation;
  assert.throws(() => importPortableConversation(invalid), 'cyclic trees are rejected');
  assert.equal(conversationCount(), countBeforeInvalid, 'Invalid imports leave no conversation');

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
  ) as { render_recipe_id: number };
  assert(
    requireMediaWorkflow(
      getMediaRecipe(importedPromptRow.render_recipe_id).configuration.workflowId,
    ).json.includes('\"seed\":0'),
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

  // Missing video files prove exports omit their bytes, including the selected attachment.
  const rasterPaths = importedPrompt.media.map((asset) => asset.url);
  const mixedPaths = ['/images/omitted-first.webm', ...rasterPaths, '/images/omitted-last.webm'];
  const { mediaPromptBuffers } = await import('../../server/src/media/mediaJobStore.ts');
  mediaPromptBuffers.set(importedPrompt.id, {
    prompt: 'Video prompt currently streaming',
    reasoning: '',
  });
  try {
    for (const [name, images, selected, expected] of [
      ['mixed rasters', mixedPaths, 2, [2, 1]],
      ['selected video falls back to preceding raster', mixedPaths, 3, [2, 1]],
      ['video-only selection is empty', ['/images/omitted-only.webm'], 0, [0, 0]],
    ] as const) {
      stmt('UPDATE messages SET images_json = ?, active_image = ? WHERE id = ?').run(
        JSON.stringify(images),
        selected,
        importedPrompt.id,
      );
      const exported = exportPortableConversation(imported.id);
      const message = exported.messages.find((message) => message.id === importedPrompt.id)!;
      assert.deepEqual([message.imageAssetIds.length, message.activeImage], expected, name);
      assert.equal(
        message.content,
        'Video prompt currently streaming',
        'Export includes live text',
      );
      const copy = importPortableConversation(exported);
      assert.equal(
        getPathToMessage(copy.activeLeafId!).length,
        3,
        `${name}: path survives omission`,
      );
    }
  } finally {
    mediaPromptBuffers.delete(importedPrompt.id);
  }
});

databaseCase('conversation copy', async () => {
  type MessageRow = import('../../server/src/conversations/conversationCopies.ts').MessageRow;
  const { IMAGES_DIR, stmt, toConversation, toMessage } = await import('../../server/src/db/db.ts');
  const { saveImage, deleteImageFiles } = await import('../../server/src/media/images.ts');
  const { copyConversation, copyMessageImages, insertCopiedMessage } =
    await import('../../server/src/conversations/conversationCopies.ts');
  const { createImageRecipe } = await import('../../server/src/media/mediaRecipes.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');

  const png = makePlaceholderPng();
  const images = ['/images/missing.png', saveImage('.png', png), saveImage('.png', png)];
  const now = Date.now();
  const id = conversationFixture({ title: 'Source', created_at: now, updated_at: now });
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
  const { newRequestId } = await import('@tinytavern/shared');

  type MediaJobInput = import('@tinytavern/shared').MediaJobInput;
  type MediaWorkflow = import('@tinytavern/shared').MediaWorkflow;
  const { IMAGES_DIR, stmt, mediaAssetForPath, invalidateMediaAsset } =
    await import('../../server/src/db/db.ts');
  const { saveImage, deleteImageFiles, collectConversationImages } =
    await import('../../server/src/media/images.ts');
  const { exportPortableConversation, importPortableConversation } =
    await import('../../server/src/routes/conversationTransfer.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const { createMediaJobFromAsset, deleteMediaJob } =
    await import('../../server/src/media/mediaJobs.ts');
  const { getSettings } = await import('../../server/src/settings/settingsStore.ts');
  const { requireMediaJob } = await import('../../server/src/media/mediaJobStore.ts');
  const { getMediaAssetResultDetails } = await import('../../server/src/media/mediaRecipes.ts');

  const { mediaCharacterIds, setMediaCharacters } =
    await import('../../server/src/media/mediaCharacters.ts');
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
    inputBindings: {},
    textOutputNodeId: null,
    standalonePromptPresetId: 'private-preset',
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
          a: '{{input1}}',
          b: '{{input2}}',
          c: '{{input3}}',
        },
      },
      save: { class_type: 'SaveImage', inputs: { filename_prefix: '{{job_id}}' } },
    }),
  };
  const inputs: MediaJobInput[] = [
    { slot: 'input3', assetId: referenceId },
    { slot: 'input2', assetId: referenceId },
    { slot: 'input1', assetId: sourceId },
  ];
  function recipe(id: number, path: string, workflow: MediaWorkflow, inputs: MediaJobInput[]) {
    const settings = getSettings();
    putSettings({
      ...settings,
      mediaRendering: {
        ...settings.mediaRendering,
        workflows: [
          ...settings.mediaRendering.workflows.filter((w) => w.id !== workflow.id),
          workflow,
        ],
      },
    });
    stmt(
      'INSERT INTO media_recipes(id, prompt, instruction, configuration_json, inputs_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      'Preserve the subject',
      '  Change the background.\nKeep the pose.  ',
      JSON.stringify({
        comfyUrl: 'http://private-user:private-secret@source-only:8588',
        timeoutSeconds: 1234,
        workflowId: workflow.id,
        workflowValues: workflow.id === 'saved-edit' ? { strength: 0.8 } : {},
        seed: workflow.id === 'saved-edit' ? 4294967295 : 0,
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
    902,
    source,
    {
      ...workflow,
      id: 'original-image',
      name: 'Create image',
      inputBindings: {},
      textOutputNodeId: null,
      json: '{"save":{"class_type":"SaveImage","inputs":{"text":"{{prompt}}"}}}',
    },
    [],
  );
  recipe(901, output, workflow, inputs);
  setMediaCharacters(mediaAssetForPath(output)!.id, organizationCharacters);
  setMediaCharacters(sourceId, organizationCharacters);
  const conversationId = conversationFixture({ title: 'Recipe transfer' });
  const message = (parent_id: number | null) =>
    messageFixture(conversationId, {
      parent_id,
      role: 'tool',
      content: 'Preserve the subject',
      images_json: JSON.stringify([output]),
    });
  const rootId = message(null);
  const leafId = message(rootId);
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
    portable.recipes!.map((recipe) => recipe.seed),
    [4294967295, 0],
    'Export includes the original seed of results and their transitive sources',
  );
  assert.deepEqual(
    portable.recipes![0]!.inputs.map((input) => input.slot),
    ['input1', 'input2', 'input3'],
  );
  const json = JSON.stringify(portable);
  for (const secret of [
    'private-secret',
    'private-user',
    'source-only',
    'must-not-export',
    'private-preset',
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
  const expectedGraph = JSON.parse(workflow.json);
  expectedGraph.load.inputs = { a: '{{input1}}', b: '{{input2}}', c: '{{input3}}' };
  assert.deepEqual(JSON.parse(requireMediaWorkflow(configuration.workflowId).json), expectedGraph);
  assert.equal(
    requireMediaWorkflow(configuration.workflowId).standalonePromptPresetId,
    workflow.standalonePromptPresetId,
  );
  assert.equal(
    requireMediaWorkflow(configuration.workflowId).chatPromptPresetId,
    workflow.chatPromptPresetId,
  );
  assert.deepEqual(configuration.workflowValues, { strength: 0.8 });
  assert.equal(getMediaAssetResultDetails(asset.id).seed, 4294967295);
  const importedInputs = JSON.parse(String(importedRecipe.inputs_json)) as MediaJobInput[];
  assert.deepEqual(
    importedInputs.map((input) => input.slot),
    ['input1', 'input2', 'input3'],
  );
  assert.equal(
    getMediaAssetResultDetails(importedInputs[0]!.assetId).seed,
    0,
    'A zero seed remains available in imported result details',
  );
  assert.notEqual(importedInputs[0]!.assetId, importedInputs[1]!.assetId);
  assert.equal(importedInputs[1]!.assetId, importedInputs[2]!.assetId);
  for (const input of importedInputs) {
    const row = stmt('SELECT path FROM media_assets WHERE id = ?').get(input.assetId)!;
    assert.deepEqual(readFileSync(join(IMAGES_DIR, basename(String(row.path)))), png);
  }
  const rerun = createMediaJobFromAsset(asset.id, { requestKey: newRequestId() });
  assert.equal(
    rerun.instruction,
    '  Change the background.\nKeep the pose.  ',
    'Exports preserve editable instructions',
  );
  assert.equal(rerun.inputs.length, 3);
  assert.deepEqual(rerun.workflowValues, { strength: 0.8 });
  assert.equal(
    requireMediaWorkflow(rerun.workflowId!).json,
    requireMediaWorkflow(configuration.workflowId).json,
    'Imported result references the matching saved workflow without retaining its own graph',
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
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '123', false].map(
      (seed) => (value: typeof portable) => {
        Object.assign(value.recipes![0]!, { seed });
      },
    ),
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
  delete editedRecipe.seed;
  for (const input of editedRecipe.inputs) input.assetId = null;
  missingReferences.recipes = [editedRecipe];
  missingReferences.assets = missingReferences.assets.filter(
    (asset) => asset.recipeId === editedRecipe.id,
  );
  const missingCopy = importPortableConversation(missingReferences);
  const missingExport = exportPortableConversation(missingCopy.id);
  assert.deepEqual(
    missingExport.recipes![0]!.inputs,
    editedRecipe.inputs.map((input, i) => ({ ...input, slot: `input${i + 1}` })),
    'Import/export preserves every deleted input slot without an image file',
  );
  const missingPaths = collectConversationImages(missingCopy.id);
  assert.equal(
    getMediaAssetResultDetails(mediaAssetForPath(missingPaths[0]!)!.id).seed,
    null,
    'Older version 1 exports without a seed remain importable',
  );
  const missingRerun = createMediaJobFromAsset(mediaAssetForPath(missingPaths[0]!)!.id, {
    requestKey: newRequestId(),
  });
  assert.deepEqual(missingRerun.inputs, []);
  assert.equal(
    (await import('@tinytavern/shared')).mediaInputSlots(
      requireMediaWorkflow(missingRerun.workflowId!),
    ).length,
    3,
  );
  deleteMediaJob(requireMediaJob(missingRerun.id));
  stmt('DELETE FROM conversations WHERE id = ?').run(missingCopy.id);
  deleteImageFiles(missingPaths);
  assert.equal(readdirSync(IMAGES_DIR).length, 0);
  assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
});
