import { conversationFixture, insertFixture } from '../support/fixtures.ts';
import { imageConfig } from '../support/imageConfig.ts';
import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('media input prompts', async () => {
  const { newRequestId } = await import('@tinytavern/shared');
  type MediaJob = import('@tinytavern/shared').MediaJob;
  type MediaWorkflow = import('@tinytavern/shared').MediaWorkflow;
  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const { stmt, mediaAssetForPath, invalidateMediaAsset } =
    await import('../../server/src/db/db.ts');
  const { saveImage, deleteImageFiles } = await import('../../server/src/media/images.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const { getSettings, putSettings } = await import('../../server/src/settings/settingsStore.ts');
  const {
    createMediaJob,
    editMediaJob,
    createMediaJobFromAsset,
    startMediaJob,
    cancelMediaJob,
    deleteMediaJob,
  } = await import('../../server/src/media/mediaJobs.ts');
  const { requireMediaJob, updateMediaJob } =
    await import('../../server/src/media/mediaJobStore.ts');
  const { saveMediaRecipe, getMediaRecipe } =
    await import('../../server/src/media/mediaRecipes.ts');
  const { expandTemplate } = await import('../../server/src/generation/prompt.ts');
  const imageWorkflow = imageConfig(
    '{"1":{"inputs":{"prompt":"{{prompt}}"}}}',
    'http://unused.invalid',
  ).workflow;
  const operations: string[] = ['image-edit', 'video-first', 'video-references', 'sparse'];
  const workflows: MediaWorkflow[] = operations.map((operation) => ({
    ...imageWorkflow,
    id: operation,
    standalonePromptPresetId: operation,
    chatPromptPresetId: operation,
    json: JSON.stringify({
      '1': {
        inputs:
          operation === 'sparse'
            ? { prompt: '{{prompt}}', last: '{{input64}}', second: '{{input2}}' }
            : operation === 'video-first'
              ? { prompt: '{{prompt}}', first: '{{input1}}' }
              : {
                  prompt: '{{prompt}}',
                  a: '{{input1}}',
                  b: '{{input2}}',
                  c: '{{input3}}',
                },
      },
    }),
  }));
  const template =
    '{{#if INPUT1_PROMPT}}INPUT1<{{input1_prompt}}>{{#if input3_prompt}}THIRD{{/if}}{{/if}}' +
    '{{#if input2_prompt}}INPUT2<{{input2_prompt}}>{{/if}}' +
    '{{#if input3_prompt}}INPUT3<{{input3_prompt}}>{{/if}}' +
    '{{input4_prompt}}{{input64_prompt}}';
  const endpointId = insertFixture('endpoints', {
    name: 'Test',
    base_url: 'http://unused.invalid',
    created_at: 1,
  });
  const presets = operations.map((operation) => ({
    id: operation,
    name: operation,
    systemPrompt: template,
    userMessage: template,
    reasoningPrefill: template,
    messagePrefill: template,
  }));
  putSettings({
    ...getSettings(),
    activeEndpointId: endpointId,
    mediaRendering: {
      ...getSettings().mediaRendering,
      workflows,
      comfyUrl: 'http://unused.invalid',
    },
    mediaStandalonePrompts: { folders: [], presets, defaultPresetId: null },
    mediaChatPrompts: {
      folders: [],
      presets: operations.map((id) => ({ id, name: id, chatPrompt: '[System Note]\n' + template })),
      defaultPresetId: null,
    },
  });
  function image(prompt: string | null) {
    const path = saveImage('.png', makePlaceholderPng());
    let recipeId: number | null = null;
    if (prompt !== null) {
      recipeId = saveMediaRecipe(
        { comfyUrl: 'http://unused.invalid', workflowId: imageWorkflow.id, timeoutSeconds: 60 },
        [],
        prompt,
      );
      stmt('UPDATE media_assets SET recipe_id = ? WHERE path = ?').run(recipeId, path);
      invalidateMediaAsset(path);
    }
    const galleryId = insertFixture('gallery_items', {
      character_name: 'Test',
      prompt: prompt ?? '',
      image: path,
      created_at: 1,
      updated_at: 1,
    });
    return { id: mediaAssetForPath(path)!.id, path, recipeId, galleryId };
  }
  const original =
    '  A portrait\n\n\nwith {{instruction}} and {{#if input2_prompt}}literal{{/if}}.  ';
  const first = image(original);
  const upload = image(null);
  const blank = image(' \n ');
  const replacement = image('New source prompt');
  function prepare(job: MediaJob) {
    const conversation =
      job.contextConversationId === null
        ? null
        : stmt('SELECT active_leaf_id, mutation_revision FROM conversations WHERE id = ?').get(
            job.contextConversationId,
          );
    startMediaJob(
      requireMediaJob(job.id),
      {
        expectedActiveLeafId: conversation?.active_leaf_id,
        expectedMutationRevision: conversation?.mutation_revision,
      },
      true,
    );
    const context = JSON.parse(requireMediaJob(job.id).context_json!);
    cancelMediaJob(requireMediaJob(job.id));
    return context;
  }
  const job = (operation: string, inputs: unknown[], contextConversationId: number | null = null) =>
    createMediaJob({
      requestKey: newRequestId(),
      workflowId: operation,
      inputs,
      contextConversationId,
    });
  assert.equal(
    prepare(
      job('sparse', [
        { slot: 'input64', assetId: first.id },
        { slot: 'input2', assetId: replacement.id },
      ]),
    ).template.userMessage,
    `INPUT2<New source prompt>${original}`,
    'Sparse binding numbers determine macros independently of graph and selection order',
  );
  const firstFrame = (assetId: number) => job('video-first', [{ slot: 'input1', assetId }]);
  const edit = job('image-edit', [
    { slot: 'input1', assetId: first.id, prompt: 'Forged client prompt' },
    { slot: 'input2', assetId: upload.id },
    { slot: 'input3', assetId: blank.id },
  ]);
  assert.equal(
    edit.inputs[0]!.prompt,
    original,
    'Capture the saved gallery prompt, ignoring client metadata',
  );
  assert.equal(edit.inputs[1]!.prompt, '');
  stmt('UPDATE gallery_items SET prompt = ? WHERE id = ?').run('Changed later', first.galleryId);
  const unchanged = editMediaJob(requireMediaJob(edit.id), {
    instruction: 'Test',
    inputs: edit.inputs.map(({ slot, assetId }) => ({ slot, assetId })),
  });
  assert.equal(
    unchanged.inputs[0]!.prompt,
    original,
    'Editing a draft retains each unchanged input snapshot',
  );
  const context = prepare(unchanged);
  const expected = `INPUT1<${original}>`;
  for (const value of Object.values(context.template)) assert.equal(value, expected);
  const recipeId = saveMediaRecipe(
    { comfyUrl: 'http://unused.invalid', workflowId: workflows[0]!.id, timeoutSeconds: 60 },
    unchanged.inputs,
    'Final generated prompt',
  );
  const output = image(null);
  stmt('UPDATE media_assets SET recipe_id = ? WHERE id = ?').run(recipeId, output.id);
  deleteMediaJob(requireMediaJob(edit.id));
  const rerun = createMediaJobFromAsset(output.id, { requestKey: newRequestId() });
  assert.deepEqual(
    rerun.inputs,
    unchanged.inputs,
    'Rerun preserves snapshots after job deletion and source changes',
  );
  assert.equal(prepare(rerun).template.userMessage, expected);
  const changed = editMediaJob(requireMediaJob(rerun.id), {
    inputs: rerun.inputs.map((input) =>
      input.slot === 'input1' ? { ...input, assetId: replacement.id } : input,
    ),
  });
  assert.equal(
    changed.inputs[0]!.prompt,
    'New source prompt',
    'Replacing a slot captures its new image prompt',
  );
  assert.equal(changed.inputs[1]!.prompt, '');
  const reordered = job('image-edit', [
    { slot: 'input3', assetId: replacement.id },
    { slot: 'input2', assetId: upload.id },
    { slot: 'input1', assetId: blank.id },
  ]);
  assert.equal(
    prepare(reordered).template.userMessage,
    'INPUT3<New source prompt>',
    'Empty prompts retain their positions and request order does not determine numbering',
  );
  const swapped = editMediaJob(requireMediaJob(reordered.id), {
    inputs: [
      { slot: 'input3', assetId: blank.id },
      { slot: 'input2', assetId: upload.id },
      { slot: 'input1', assetId: replacement.id },
    ],
  });
  assert.equal(
    prepare(swapped).template.userMessage,
    'INPUT1<New source prompt>',
    'Moving an image to another input changes its matching prompt macro',
  );
  const newSelection = firstFrame(first.id);
  assert.equal(newSelection.inputs[0]!.prompt, 'Changed later');
  assert.equal(prepare(newSelection).template.userMessage, 'INPUT1<Changed later>');
  assert.equal(
    getMediaRecipe(first.recipeId!).prompt,
    original,
    'Editing gallery text preserves the original recipe',
  );
  stmt('UPDATE gallery_items SET prompt = ? WHERE id = ?').run(
    '  Uploaded image description  ',
    upload.galleryId,
  );
  const describedUpload = firstFrame(upload.id);
  assert.equal(
    prepare(describedUpload).template.userMessage,
    'INPUT1<  Uploaded image description  >',
  );
  stmt('UPDATE gallery_items SET prompt = ? WHERE id = ?').run('', upload.galleryId);
  stmt('UPDATE gallery_items SET prompt = ? WHERE id = ?').run('', first.galleryId);
  const cleared = firstFrame(first.id);
  assert.equal(
    cleared.inputs[0]!.prompt,
    '',
    'Clearing a saved prompt does not restore recipe text',
  );

  const conversationId = conversationFixture();
  for (const operation of ['video-first', 'video-references'] as const) {
    for (const contextConversationId of [null, conversationId]) {
      const inputs =
        operation === 'video-first'
          ? [{ slot: 'input1', assetId: replacement.id }]
          : [
              { slot: 'input1', assetId: replacement.id },
              { slot: 'input2', assetId: upload.id },
              { slot: 'input3', assetId: blank.id },
            ];
      const prepared = prepare(job(operation, inputs, contextConversationId));
      const body = 'INPUT1<New source prompt>';
      assert.equal(
        prepared.template.userMessage,
        contextConversationId === null
          ? body
          : '<system_instruction>\n' + body + '\n</system_instruction>',
      );
    }
  }
  const unsupportedNames = '{{first_frame_prompt}}|{{source_prompt}}|{{reference1_prompt}}';
  putSettings({
    ...getSettings(),
    mediaStandalonePrompts: {
      ...getSettings().mediaStandalonePrompts,
      presets: presets.map((preset) => ({ ...preset, systemPrompt: unsupportedNames })),
    },
  });
  assert.equal(
    prepare(firstFrame(replacement.id)).template.systemPrompt,
    unsupportedNames,
    'Input-name macros have no aliases; unknown tokens retain the normal template behavior',
  );
  const failedRender = job('image-edit', [
    { slot: 'input1', assetId: first.id },
    { slot: 'input2', assetId: upload.id },
    { slot: 'input3', assetId: blank.id },
  ]);
  updateMediaJob(failedRender.id, { state: 'failed', submission_id: crypto.randomUUID() });
  stmt('DELETE FROM gallery_items WHERE id = ?').run(first.galleryId);
  deleteImageFiles([first.path]);
  const retry = createMediaJob(
    { requestKey: newRequestId(), reviewBeforeSave: true },
    requireMediaJob(failedRender.id),
  );
  assert.deepEqual(
    retry.inputs.map((input) => input.slot),
    ['input2', 'input3'],
  );
  assert.throws(() => startMediaJob(requireMediaJob(retry.id), {}, false), /input1/);
  assert.throws(
    () =>
      createMediaJob(
        { requestKey: newRequestId(), inputs: failedRender.inputs },
        requireMediaJob(failedRender.id),
      ),
    { status: 409 },
    'Explicit unavailable references must still be rejected',
  );
  editMediaJob(requireMediaJob(retry.id), {
    prompt: 'Retry with a replacement',
    inputs: [{ slot: 'input1', assetId: replacement.id }, ...retry.inputs],
  });
  assert.equal(startMediaJob(requireMediaJob(retry.id), {}, false).state, 'submitting');
  const saved = getMediaRecipe(recipeId);
  assert.equal(saved.inputs[0]!.assetId, null);
  assert.equal(
    saved.inputs[0]!.prompt,
    original,
    'Deleting the source clears only the image reference',
  );
  assert.equal(saved.inputs[1]!.prompt, '');
  assert.equal(
    expandTemplate('{{#if input1_prompt}}Outer{{#if input2_prompt}}Inner{{/if}}{{/if}}', {
      input1_prompt: 'yes',
      input2_prompt: 'yes',
    }),
    'OuterInner',
  );
  assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
});

test('numbered automatic inputs honor manual choices, snapshot avatars and roll back failed fills', async () => {
  const { existsSync, readdirSync } = await import('node:fs');
  const { basename, join } = await import('node:path');
  const { newRequestId } = await import('@tinytavern/shared');
  const { stmt, IMAGES_DIR, mediaAssetForPath } = await import('../../server/src/db/db.ts');
  const { getSettings, putSettings } = await import('../../server/src/settings/settingsStore.ts');
  const { saveImage } = await import('../../server/src/media/images.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const { saveAvatar, readAvatarFile } = await import('../../server/src/characters/avatarStore.ts');
  const { createMediaJob, editMediaJob, startMediaJob, cancelMediaJob, deleteMediaJob } =
    await import('../../server/src/media/mediaJobs.ts');
  const { requireMediaJob } = await import('../../server/src/media/mediaJobStore.ts');
  const raster = makePlaceholderPng();
  const characterId = insertFixture('characters', { name: 'Input character', created_at: 1 });
  const avatar = saveAvatar('character', characterId, raster);
  stmt('UPDATE characters SET avatar=? WHERE id=?').run(avatar, characterId);
  const conversationId = conversationFixture({ character_id: characterId });
  const path = saveImage('.png', raster);
  insertFixture('gallery_items', {
    character_name: '',
    prompt: 'Manual input description',
    image: path,
    created_at: 1,
    updated_at: 1,
  });
  const assetId = mediaAssetForPath(path)!.id;
  const workflow: import('@tinytavern/shared').MediaWorkflow = {
    id: 'named',
    name: 'Numbered inputs',
    standalonePromptPresetId: null,
    chatPromptPresetId: 'named',
    textOutputNodeId: null,
    inputBindings: {
      chat: { input1: 'character-avatar', input2: 'character-avatar', input3: 'selected:1' },
      avatar: { input1: 'character-avatar', input2: 'character-avatar', input3: 'selected:1' },
    },
    json: JSON.stringify({
      identity: {
        class_type: 'LoadImage',
        inputs: { image: 'example.png' },
        _meta: { title: 'Identity [image:input1]' },
      },
      style: {
        class_type: 'LoadImage',
        inputs: { image: 'example.png' },
        _meta: { title: 'Style [image:input2]' },
      },
      backdrop: {
        class_type: 'LoadImage',
        inputs: { image: 'example.png' },
        _meta: { title: 'Backdrop [image:input3]' },
      },
      text: {
        class_type: 'PrimitiveString',
        inputs: { value: 'Sample' },
        _meta: { title: 'Prompt [prompt]' },
      },
    }),
  };
  putSettings({
    ...getSettings(),
    mediaRendering: { ...getSettings().mediaRendering, workflows: [workflow] },
    mediaChatPrompts: {
      folders: [],
      presets: [{ id: 'named', name: 'Named', chatPrompt: 'Input: {{input3_prompt}}' }],
      defaultPresetId: null,
    },
  });
  const draft = createMediaJob({
    requestKey: newRequestId(),
    workflowId: workflow.id,
    reviewBeforeSave: true,
    contextConversationId: conversationId,
    inputs: [{ slot: 'input2', assetId }],
    fillInputs: { selectedAssetIds: [assetId] },
  });
  assert.equal(
    draft.inputs.find((input) => input.slot === 'input2')!.assetId,
    assetId,
    'Manual input overrides automatic binding',
  );
  assert.equal(
    draft.inputs.find((input) => input.slot === 'input3')!.prompt,
    'Manual input description',
  );
  const identityId = draft.inputs.find((input) => input.slot === 'input1')!.assetId;
  assert.notEqual(identityId, assetId);
  const ownedPath = String(stmt('SELECT path FROM media_assets WHERE id=?').get(identityId)!.path);
  assert(existsSync(join(IMAGES_DIR, basename(ownedPath))));
  const again = editMediaJob(requireMediaJob(draft.id), {
    fillInputs: { selectedAssetIds: [assetId] },
  });
  assert.deepEqual(
    again.inputs,
    draft.inputs,
    'Repeated fill preserves prior selections and copied avatar',
  );
  startMediaJob(requireMediaJob(draft.id), {}, true);
  const context = JSON.parse(requireMediaJob(draft.id).context_json!);
  assert(
    context.messages.at(-1).content.includes('Input: Manual input description'),
    'Prompt numbering matches the binding, regardless of fill order',
  );
  cancelMediaJob(requireMediaJob(draft.id));
  deleteMediaJob(requireMediaJob(draft.id));
  assert(
    !existsSync(join(IMAGES_DIR, basename(ownedPath))),
    'Discarding the job releases its private avatar copy',
  );
  assert.deepEqual(
    readAvatarFile('character', characterId),
    raster,
    'Source avatar survives cleanup',
  );
  const snapshot = createMediaJob({
    requestKey: newRequestId(),
    workflowId: workflow.id,
    fillInputs: { avatar: { kind: 'character', id: characterId }, selectedAssetIds: [assetId] },
  });
  assert.equal(
    snapshot.inputs.find((input) => input.slot === 'input1')!.assetId,
    snapshot.inputs.find((input) => input.slot === 'input2')!.assetId,
    'One copied avatar serves repeated bindings',
  );
  deleteMediaJob(requireMediaJob(snapshot.id));
  const missing = createMediaJob({
    requestKey: newRequestId(),
    workflowId: workflow.id,
    prompt: 'Transform',
    fillInputs: {},
  });
  assert.deepEqual(missing.inputs, []);
  assert.throws(
    () => startMediaJob(requireMediaJob(missing.id), {}, false),
    /required media/,
    'Never execute sample image filenames when required selections are absent',
  );
  deleteMediaJob(requireMediaJob(missing.id));
  const before = readdirSync(IMAGES_DIR).sort();
  const jobCount = stmt('SELECT count(*) AS n FROM media_jobs').get()!.n;
  assert.throws(
    () =>
      createMediaJob({
        requestKey: newRequestId(),
        workflowId: workflow.id,
        contextConversationId: conversationId,
        fillInputs: { selectedAssetIds: [987654321] },
      }),
    /image|available|found/i,
  );
  assert.deepEqual(
    readdirSync(IMAGES_DIR).sort(),
    before,
    'A failed later binding removes earlier copied files',
  );
  assert.equal(stmt('SELECT count(*) AS n FROM media_jobs').get()!.n, jobCount);
  assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
});
