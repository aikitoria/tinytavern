import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { requireTestIsolation } from './isolation.ts';
import type { MediaWorkflow } from '@tinytavern/shared';

requireTestIsolation();
const { stmt, mediaAssetForPath } = await import('../server/src/db.ts');
const { saveImage, copyImage, reserveMediaFile } = await import('../server/src/images.ts');
const { makePlaceholderPng } = await import('../server/src/pngCard.ts');
const { mediaCharacterIds, setMediaCharacters, captureMediaCharacters } =
  await import('../server/src/mediaCharacters.ts');
const { getSettings, putSettings } = await import('../server/src/settingsStore.ts');
const { createMediaJob, startMediaJob, createMediaJobFromAsset } =
  await import('../server/src/mediaJobs.ts');
const { requireMediaJob, mediaJobDto } = await import('../server/src/mediaJobStore.ts');
const { recordMediaResult } = await import('../server/src/mediaJobResults.ts');
const { getMediaRecipe } = await import('../server/src/mediaRecipes.ts');
const characters = ['Ashina', 'Haeun'].map((name) =>
  Number(stmt('INSERT INTO characters(name, created_at) VALUES (?, 1)').run(name).lastInsertRowid),
);
const inputs = characters.map((characterId, index) => {
  const path = saveImage('.png', makePlaceholderPng());
  const asset = mediaAssetForPath(path)!;
  stmt(
    "INSERT INTO gallery_items(character_name, prompt, image, created_at, updated_at) VALUES ('Uploads', '', ?, 1, 1)",
  ).run(path);
  setMediaCharacters(asset.id, [characterId]);
  return asset;
});
setMediaCharacters(inputs[1]!.id, characters);
const workflows: MediaWorkflow[] = ['image-edit', 'video-references'].map((operation) => ({
  id: operation,
  name: operation,
  operation: operation as MediaWorkflow['operation'],
  referenceCount: 2,
  galleryPromptPresetId: null,
  chatPromptPresetId: null,
  json: '{"text":{"inputs":{"prompt":"{{prompt}}"}},"a":{"class_type":"LoadImage","inputs":{"image":"reference1.png"}},"b":{"class_type":"LoadImage","inputs":{"image":"reference2.png"}}}',
}));
putSettings({ ...getSettings(), mediaRendering: { ...getSettings().mediaRendering, workflows } });
const jobs = workflows.map((workflow) => {
  const job = createMediaJob({
    requestKey: randomUUID(),
    operation: workflow.operation,
    workflowId: workflow.id,
    prompt: 'Both characters',
    reviewBeforeSave: true,
    inputs: inputs.map((asset, index) => ({ slot: `reference${index + 1}`, assetId: asset.id })),
  });
  assert.deepEqual(job.characterIds, characters, 'Draft cards expose input character associations');
  startMediaJob(requireMediaJob(job.id), {}, false);
  assert.deepEqual(
    JSON.parse(requireMediaJob(job.id).configuration_json!).characterIds,
    characters,
  );
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
  captureMediaCharacters(
    requireMediaJob(jobs[0]!.id),
    JSON.parse(requireMediaJob(jobs[0]!.id).configuration_json!),
  ),
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
  const rerun = createMediaJobFromAsset(assetId, { requestKey: randomUUID() });
  assert.deepEqual(
    JSON.parse(requireMediaJob(rerun.id).configuration_json!).characterIds,
    characters,
  );
}
const original = saveImage('.png', makePlaceholderPng());
const originalAsset = mediaAssetForPath(original)!;
setMediaCharacters(originalAsset.id, characters);
const copy = copyImage(original)!;
const copiedAsset = mediaAssetForPath(copy)!;
assert.deepEqual(mediaCharacterIds(copiedAsset.id), characters);
setMediaCharacters(copiedAsset.id, [characters[1]!]);
assert.deepEqual(
  mediaCharacterIds(originalAsset.id),
  characters,
  'Copies can be organized independently',
);
stmt('DELETE FROM characters WHERE id = ?').run(characters[0]!);
assert.deepEqual(mediaCharacterIds(originalAsset.id), [characters[1]!]);
assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
console.log(
  'Media characters: deduplicated reference unions, image/video results, durable snapshots, copies, reruns, and character deletion passed',
);
