import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MediaJobInput, MediaWorkflow } from '@tinytavern/shared';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { IMAGES_DIR, stmt, mediaAssetForPath, invalidateMediaAsset } =
  await import('../server/src/db.ts');
const { saveImage, deleteImageFiles, collectConversationImages } =
  await import('../server/src/images.ts');
const { exportPortableConversation, importPortableConversation } =
  await import('../server/src/routes/conversationTransfer.ts');
const { makePlaceholderPng } = await import('../server/src/pngCard.ts');
const { createMediaJobFromAsset, deleteMediaJob } = await import('../server/src/mediaJobs.ts');
const { getSettings } = await import('../server/src/settingsStore.ts');
const { requireMediaJob } = await import('../server/src/mediaJobStore.ts');

const { mediaCharacterIds, setMediaCharacters } = await import('../server/src/mediaCharacters.ts');
const organizationCharacters = ['Ashina', 'Haeun'].map((name) =>
  Number(stmt('INSERT INTO characters(name, created_at) VALUES (?, 1)').run(name).lastInsertRowid),
);
const png = makePlaceholderPng();
const source = saveImage('transfer-original.png', png);
const reference = saveImage('transfer-reference.png', png);
const output = saveImage('transfer-edited.png', png);
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
    stmt("INSERT INTO media_owners VALUES (?, 'recipe', ?, ?)").run(input.assetId, id, input.slot);
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
const leafId = Number(insert.run(conversationId, rootId, JSON.stringify([output])).lastInsertRowid);
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
const paths = collectConversationImages(imported.id);
assert.equal(paths.length, 2);
assert.notEqual(paths[0], paths[1], 'Each imported message has an independently owned result file');
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
assert.equal(readdirSync(IMAGES_DIR).length, 0, 'Failed SQL commits discard every imported raster');
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
  stmt('SELECT render_recipe_id FROM messages WHERE conversation_id = ? LIMIT 1').get(emptyCopy.id)!
    .render_recipe_id,
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
console.log(
  'Image recipe transfer preserves reruns, ordered/deduplicated references, ownership and atomic failure without exporting connection settings',
);
