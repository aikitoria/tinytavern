import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { MediaJob, MediaOperation, MediaWorkflow } from '@tinytavern/shared';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { stmt, mediaAssetForPath, invalidateMediaAsset } = await import('../server/src/db.ts');
const { saveImage, deleteImageFiles } = await import('../server/src/images.ts');
const { makePlaceholderPng } = await import('../server/src/pngCard.ts');
const { getSettings, putSettings } = await import('../server/src/settingsStore.ts');
const {
  createMediaJob,
  editMediaJob,
  createMediaJobFromAsset,
  startMediaJob,
  cancelMediaJob,
  deleteMediaJob,
} = await import('../server/src/mediaJobs.ts');
const { requireMediaJob } = await import('../server/src/mediaJobStore.ts');
const { saveMediaRecipe, getMediaRecipe } = await import('../server/src/mediaRecipes.ts');
const { expandTemplate } = await import('../server/src/prompt.ts');
const imageWorkflow: MediaWorkflow = {
  id: 'image',
  name: 'Image',
  operation: 'image',
  referenceCount: 0,
  json: '{"1":{"inputs":{"prompt":"{{prompt}}"}}}',
  galleryPromptPresetId: null,
  chatPromptPresetId: null,
};
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
const endpointId = Number(
  stmt(
    "INSERT INTO endpoints(name, base_url, created_at) VALUES ('Test', 'http://unused.invalid', 1)",
  ).run().lastInsertRowid,
);
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
  mediaRendering: { ...getSettings().mediaRendering, workflows, comfyUrl: 'http://unused.invalid' },
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
function image(name: string, prompt: string | null) {
  const path = saveImage('.png', makePlaceholderPng());
  let recipeId: string | null = null;
  if (prompt !== null) {
    recipeId = saveMediaRecipe(
      { comfyUrl: 'http://unused.invalid', workflow: imageWorkflow, timeoutSeconds: 60 },
      [],
      prompt,
    );
    stmt('UPDATE media_assets SET recipe_id = ? WHERE path = ?').run(recipeId, path);
    invalidateMediaAsset(path);
  }
  const galleryId = Number(
    stmt(
      "INSERT INTO gallery_items(character_name, prompt, image, created_at, updated_at) VALUES ('Test', ?, ?, 1, 1)",
    ).run(prompt ?? '', path).lastInsertRowid,
  );
  return { id: mediaAssetForPath(path)!.id, path, recipeId, galleryId };
}
const original =
  '  A portrait\n\n\nwith {{instruction}} and {{#if reference2_prompt}}literal{{/if}}.  ';
const first = image('first', original);
const upload = image('upload', null);
const blank = image('blank', ' \n ');
const replacement = image('replacement', 'New source prompt');
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
const edit = createMediaJob({
  requestKey: randomUUID(),
  operation: 'image-edit',
  workflowId: 'image-edit',
  inputs: [
    { slot: 'reference1', assetId: first.id, prompt: 'Forged client prompt' },
    { slot: 'reference2', assetId: upload.id },
    { slot: 'reference3', assetId: blank.id },
  ],
});
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
const output = image('output', null);
stmt('UPDATE media_assets SET recipe_id = ? WHERE id = ?').run(recipeId, output.id);
deleteMediaJob(requireMediaJob(edit.id));
const rerun = createMediaJobFromAsset(output.id, { requestKey: randomUUID() });
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
const newSelection = createMediaJob({
  requestKey: randomUUID(),
  operation: 'video-first',
  workflowId: 'video-first',
  inputs: [{ slot: 'first_frame', assetId: first.id }],
});
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
const describedUpload = createMediaJob({
  requestKey: randomUUID(),
  operation: 'video-first',
  workflowId: 'video-first',
  inputs: [{ slot: 'first_frame', assetId: upload.id }],
});
assert.equal(
  prepare(describedUpload).template.userMessage,
  'FIRST<  Uploaded image description  >',
);
stmt('UPDATE gallery_items SET prompt = ? WHERE id = ?').run('', upload.galleryId);
stmt('UPDATE gallery_items SET prompt = ? WHERE id = ?').run('', first.galleryId);
const cleared = createMediaJob({
  requestKey: randomUUID(),
  operation: 'video-first',
  workflowId: 'video-first',
  inputs: [{ slot: 'first_frame', assetId: first.id }],
});
assert.equal(cleared.inputs[0]!.prompt, '', 'Clearing a saved prompt does not restore recipe text');

const conversationId = Number(
  stmt("INSERT INTO conversations(title, created_at, updated_at) VALUES ('Test', 1, 1)").run()
    .lastInsertRowid,
);
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
    const job = createMediaJob({
      requestKey: randomUUID(),
      operation,
      workflowId: operation,
      contextConversationId,
      inputs,
    });
    const prepared = prepare(job);
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
console.log(
  'Input prompt snapshots preserve source text across draft edits, reruns and deletion; conditional macros work in chat and gallery templates',
);
