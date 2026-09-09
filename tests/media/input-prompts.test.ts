import { conversationFixture, insertFixture } from '../support/fixtures.ts';
import { imageConfig } from '../support/imageConfig.ts';
import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('media input prompts', async () => {
  const { newRequestId } = await import('@tinytavern/shared');
  type MediaJob = import('@tinytavern/shared').MediaJob;
  type MediaOperation = import('@tinytavern/shared').MediaOperation;
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
  const { requireMediaJob } = await import('../../server/src/media/mediaJobStore.ts');
  const { saveMediaRecipe, getMediaRecipe } =
    await import('../../server/src/media/mediaRecipes.ts');
  const { expandTemplate } = await import('../../server/src/generation/prompt.ts');
  const imageWorkflow = imageConfig(
    '{"1":{"inputs":{"prompt":"{{prompt}}"}}}',
    'http://unused.invalid',
  ).workflow;
  const operations: MediaOperation[] = ['image-edit', 'video-first', 'video-references'];
  const workflows: MediaWorkflow[] = operations.map((operation) => ({
    ...imageWorkflow,
    id: operation,
    operation,
    referenceCount: operation === 'video-first' ? 0 : 3,
    json: JSON.stringify({
      '1': {
        inputs:
          operation === 'video-first'
            ? { prompt: '{{prompt}}', first: '{{first_frame}}' }
            : {
                prompt: '{{prompt}}',
                a: '{{reference1}}',
                b: '{{reference2}}',
                c: '{{reference3}}',
              },
      },
    }),
  }));
  const template =
    '{{#if FIRST_FRAME_PROMPT}}FIRST<{{first_frame_prompt}}>{{/if}}' +
    '{{#if reference1_prompt}}REF1<{{reference1_prompt}}>{{#if reference3_prompt}}THIRD{{/if}}{{/if}}' +
    '{{#if reference2_prompt}}REF2<{{reference2_prompt}}>{{/if}}' +
    '{{#if reference3_prompt}}REF3<{{reference3_prompt}}>{{/if}}';
  const endpointId = insertFixture('endpoints', {
    name: 'Test',
    base_url: 'http://unused.invalid',
    created_at: 1,
  });
  const presets = operations.map((operation) => ({
    id: operation,
    name: operation,
    operation,
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
    galleryImagePrompts: {
      presets: presets.filter((preset) => preset.operation.startsWith('image')),
      defaults: { 'image-edit': 'image-edit' },
    },
    galleryVideoPrompts: {
      presets: presets.filter((preset) => preset.operation.startsWith('video')),
      defaults: { 'video-first': 'video-first', 'video-references': 'video-references' },
    },
    chatVideoPrompts: {
      presets: operations
        .filter((operation) => operation.startsWith('video'))
        .map((operation) => ({
          id: operation,
          name: operation,
          operation,
          chatPrompt: '[System Note]\n' + template,
        })),
      defaults: { 'video-first': 'video-first', 'video-references': 'video-references' },
    },
  });
  function image(prompt: string | null) {
    const path = saveImage('.png', makePlaceholderPng());
    let recipeId: number | null = null;
    if (prompt !== null) {
      recipeId = saveMediaRecipe(
        { comfyUrl: 'http://unused.invalid', workflow: imageWorkflow, timeoutSeconds: 60 },
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
    '  A portrait\n\n\nwith {{instruction}} and {{#if reference2_prompt}}literal{{/if}}.  ';
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
  const job = (
    operation: MediaOperation,
    inputs: unknown[],
    contextConversationId: number | null = null,
  ) =>
    createMediaJob({
      requestKey: newRequestId(),
      operation,
      workflowId: operation,
      inputs,
      contextConversationId,
    });
  const firstFrame = (assetId: number) => job('video-first', [{ slot: 'first_frame', assetId }]);
  const edit = job('image-edit', [
    { slot: 'reference1', assetId: first.id, prompt: 'Forged client prompt' },
    { slot: 'reference2', assetId: upload.id },
    { slot: 'reference3', assetId: blank.id },
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
  const expected = `REF1<${original}>`;
  for (const value of Object.values(context.template)) assert.equal(value, expected);
  const recipeId = saveMediaRecipe(
    { comfyUrl: 'http://unused.invalid', workflow: workflows[0]!, timeoutSeconds: 60 },
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
      input.slot === 'reference1' ? { ...input, assetId: replacement.id } : input,
    ),
  });
  assert.equal(
    changed.inputs[0]!.prompt,
    'New source prompt',
    'Replacing a slot captures its new image prompt',
  );
  assert.equal(changed.inputs[1]!.prompt, '');
  const newSelection = firstFrame(first.id);
  assert.equal(newSelection.inputs[0]!.prompt, 'Changed later');
  assert.equal(prepare(newSelection).template.userMessage, 'FIRST<Changed later>');
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
    'FIRST<  Uploaded image description  >',
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
          ? [{ slot: 'first_frame', assetId: replacement.id }]
          : [
              { slot: 'reference1', assetId: replacement.id },
              { slot: 'reference2', assetId: upload.id },
              { slot: 'reference3', assetId: blank.id },
            ];
      const prepared = prepare(job(operation, inputs, contextConversationId));
      const body =
        operation === 'video-first' ? 'FIRST<New source prompt>' : 'REF1<New source prompt>';
      assert.equal(
        prepared.template.userMessage,
        contextConversationId === null ? body : '[System Note]\n' + body,
      );
    }
  }
  stmt('DELETE FROM gallery_items WHERE id = ?').run(first.galleryId);
  deleteImageFiles([first.path]);
  const saved = getMediaRecipe(recipeId);
  assert.equal(saved.inputs[0]!.assetId, null);
  assert.equal(
    saved.inputs[0]!.prompt,
    original,
    'Deleting the source clears only the image reference',
  );
  assert.equal(saved.inputs[1]!.prompt, '');
  assert.equal(
    expandTemplate('{{#if reference1_prompt}}Outer{{#if reference2_prompt}}Inner{{/if}}{{/if}}', {
      reference1_prompt: 'yes',
      reference2_prompt: 'yes',
    }),
    'OuterInner',
  );
  assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
});
