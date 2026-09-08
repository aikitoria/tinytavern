import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireTestIsolation } from './isolation.ts';
import { imageConfig } from './imageConfig.ts';

requireTestIsolation();
const { stmt, IMAGES_DIR, mediaAssetForPath } = await import('../server/src/db.ts');
const { makePlaceholderPng } = await import('../server/src/pngCard.ts');
const { getSettings, putSettings } = await import('../server/src/settingsStore.ts');
const { createMediaJob, createMediaJobFromAsset, startMediaJob, deleteMediaJob } =
  await import('../server/src/mediaJobs.ts');
const { requireMediaJob, updateMediaJob, mediaJobDto, mediaDraft } =
  await import('../server/src/mediaJobStore.ts');
const { recordMediaResult, completeMediaJob, finishMediaJob } =
  await import('../server/src/mediaJobResults.ts');
const {
  acceptMediaVariation,
  selectMediaVariation,
  discardMediaDraft,
  cleanupDiscardedMediaDraft,
} = await import('../server/src/mediaDrafts.ts');
const { appendMessage } = await import('../server/src/tree.ts');
const { saveImage, deleteImageFiles, sweepOrphanedImages } =
  await import('../server/src/images.ts');

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
    const name = `${randomUUID()}.png`;
    const bytes = makePlaceholderPng();
    writeFileSync(join(IMAGES_DIR, name), bytes);
    outputs.push(
      recordMediaResult(jobId, ++remoteId, {
        path: `/images/${name}`,
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
const { initMediaWorker, stopMediaWorker } = await import('../server/src/mediaWorker.ts');
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
assert.equal(accepted.draft!.state, 'accepted');
assert.deepEqual(
  accepted.outputs.map((asset) => asset.id),
  [firstAssets[0]],
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
  0,
);
assert.equal(stmt('SELECT id FROM media_drafts WHERE id = ?').get(first.draft!.id), undefined);
assert.equal(stmt("SELECT owner_id FROM media_owners WHERE owner_type = 'job'").get(), undefined);
assert.ok(existsSync(join(IMAGES_DIR, basename(beforeAccept[0]!.url))));
assert.equal(
  existsSync(join(IMAGES_DIR, basename(beforeAccept[1]!.url))),
  false,
  'Unselected outputs of the accepted job are removed',
);
assert.equal(
  stmt('SELECT id FROM media_assets WHERE id = ?').get(secondAssets[0]!),
  undefined,
  'Other variations are discarded',
);
assert.throws(
  () => acceptMediaVariation(requireMediaJob(accepted.id), request),
  { status: 404 },
  'Repeated acceptance never duplicates the attachment',
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
assert.equal(stmt('SELECT image FROM gallery_items').get()!.image, saved.outputs[0]!.url);
assert.throws(() => requireMediaJob(saved.id), { status: 404 });
assert.equal(
  stmt('SELECT id FROM media_drafts WHERE id = ?').get(galleryDraft.draft!.id),
  undefined,
);
assert.ok(
  existsSync(join(IMAGES_DIR, basename(saved.outputs[0]!.url))),
  'Accepted output outlives draft history',
);

const inputPath = saveImage('draft-reference.png', makePlaceholderPng());
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
  existsSync(join(IMAGES_DIR, 'draft-reference.png')),
  'Running discard keeps inputs until cancellation completes',
);
finishMediaJob(discarded.id, 'cancelled');
cleanupDiscardedMediaDraft(requireMediaJob(discarded.id));
assert.equal(existsSync(join(IMAGES_DIR, 'draft-reference.png')), false);
assert.equal(stmt('SELECT id FROM media_drafts WHERE id = ?').get(discarded.draft!.id), undefined);
assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
console.log(
  'Draft variations: deferred attachment, persisted selection, branch/revision guards, accept-one cleanup, gallery ownership and safe discard passed',
);
