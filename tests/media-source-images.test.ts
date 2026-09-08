import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  GalleryItem,
  MediaAssetInput,
  MediaJob,
  MediaWorkflow,
  MediaResultDetails,
} from '@tinytavern/shared';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const signingKey = join(process.env.DATA_DIR!, 'source-test-key');
writeFileSync(signingKey, '11'.repeat(32));
process.env.MEDIA_SIGNING_KEY_FILE = signingKey;
const { stmt, IMAGES_DIR, mediaAssetForPath, invalidateMediaAsset } =
  await import('../server/src/db.ts');
const { saveImage, sweepOrphanedImages } = await import('../server/src/images.ts');
const { makePlaceholderPng } = await import('../server/src/pngCard.ts');
const { saveMediaRecipe, getMediaRecipe } = await import('../server/src/mediaRecipes.ts');
const { updateMediaJob } = await import('../server/src/mediaJobStore.ts');
const { finishMediaJob } = await import('../server/src/mediaJobResults.ts');
const { dispatch } = await import('../server/src/router.ts');
await import('../server/src/routes/mediaJobs.ts');
await import('../server/src/routes/gallery.ts');

function gallery(path: string): number {
  return Number(
    stmt(`INSERT INTO gallery_items(character_name, prompt, image, created_at, updated_at)
    VALUES ('Test', 'Saved prompt', ?, 1, 1)`).run(path).lastInsertRowid,
  );
}
const png = makePlaceholderPng();
const first = saveImage('first-frame.png', png);
const reference = saveImage('reference.png', png);
const firstAsset = mediaAssetForPath(first)!;
const referenceAsset = mediaAssetForPath(reference)!;
const firstGallery = gallery(first);
const referenceGallery = gallery(reference);
const videoPath = join(IMAGES_DIR, 'fixture.webm');
await promisify(execFile)('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=blue:s=32x24:r=5:d=0.2',
  '-c:v',
  'libaom-av1',
  '-cpu-used',
  '8',
  '-threads',
  '1',
  '-y',
  videoPath,
]);
const videoBytes = readFileSync(videoPath);
const workflows: MediaWorkflow[] = [
  {
    id: 'first',
    name: 'First frame',
    operation: 'video-first',
    referenceCount: 0,
    json: '{"1":{"class_type":"Test","inputs":{"prompt":"{{prompt}}","image":"{{first_frame}}"}}}',
    galleryPromptPresetId: null,
    chatPromptPresetId: null,
  },
  {
    id: 'references',
    name: 'References',
    operation: 'video-references',
    referenceCount: 3,
    json: '{"1":{"class_type":"Test","inputs":{"prompt":"{{prompt}}","images":["{{reference1}}","{{reference2}}","{{reference3}}"]}}}',
    galleryPromptPresetId: null,
    chatPromptPresetId: null,
  },
];
const savedInputs = [
  [{ slot: 'first_frame' as const, assetId: firstAsset.id, prompt: '' }],
  [
    { slot: 'reference1' as const, assetId: firstAsset.id, prompt: '' },
    { slot: 'reference2' as const, assetId: referenceAsset.id, prompt: '' },
    { slot: 'reference3' as const, assetId: firstAsset.id, prompt: '' },
  ],
];
const results = workflows.map((workflow, index) => {
  const recipeId = saveMediaRecipe(
    { comfyUrl: 'http://127.0.0.1:1', workflow, timeoutSeconds: 60 },
    savedInputs[index]!,
    'Saved prompt',
    { instruction: 'Original instruction', seed: index === 0 ? 0 : undefined },
  );
  const path = saveImage(`result-${index}.webm`, videoBytes);
  stmt('UPDATE media_assets SET recipe_id = ?, width = 32, height = 24 WHERE path = ?').run(
    recipeId,
    path,
  );
  invalidateMediaAsset(path);
  return { asset: mediaAssetForPath(path)!, galleryId: gallery(path) };
});

const server = createServer((req, res) => {
  void dispatch(req, res, new URL(req.url!, 'http://test').pathname).then((handled) => {
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert(
    response.ok,
    `${method} ${path}: ${response.status} ${response.ok ? '' : await response.text()}`,
  );
  return response.status === 204 ? undefined : response.json();
}
try {
  const { appendMessage } = await import('../server/src/tree.ts');
  stmt(
    "INSERT INTO conversations(id, title, created_at, updated_at) VALUES (1, 'Video chat', 1, 1)",
  ).run();
  const message = appendMessage(1, 'tool', 'Saved prompt', null);
  stmt('UPDATE messages SET images_json = ? WHERE id = ?').run(
    JSON.stringify([results[0]!.asset.url]),
    message.id,
  );
  const savedVideo = (await request('POST', '/api/gallery', { messageId: message.id })) as {
    item: GalleryItem;
    created: boolean;
  };
  assert.equal(savedVideo.item.media?.kind, 'video');
  assert.equal(savedVideo.item.imageWidth, 32);
  assert.equal(savedVideo.item.imageHeight, 24);
  assert.equal(savedVideo.item.media?.width, savedVideo.item.imageWidth);
  assert.equal(savedVideo.item.media?.height, savedVideo.item.imageHeight);
  const savedAgain = (await request('POST', '/api/gallery', { messageId: message.id })) as {
    item: GalleryItem;
    created: boolean;
  };
  assert.equal(savedAgain.created, false);
  assert.equal(savedAgain.item.imageHeight, 24);
  await request('DELETE', `/api/gallery/${savedVideo.item.id}`);
  stmt('DELETE FROM conversations WHERE id = 1').run();

  assert.deepEqual(await request('GET', `/api/media/assets/${firstAsset.id}/inputs`), []);
  const jobsBeforeDetails = stmt('SELECT COUNT(*) AS n FROM media_jobs').get()!.n;
  for (const [index, result] of results.entries()) {
    stmt('UPDATE gallery_items SET prompt = ? WHERE id = ?').run(
      'Edited gallery annotation',
      result.galleryId,
    );
    const details = (await request(
      'GET',
      `/api/media/assets/${result.asset.id}/details`,
    )) as MediaResultDetails;
    assert.deepEqual(
      details,
      {
        instruction: 'Original instruction',
        prompt: 'Saved prompt',
        workflowSnapshot: workflows[index],
        workflowValues: {},
        seed: index === 0 ? 0 : null,
      },
      'Details use the original recipe, without leaking server configuration or using edited gallery text',
    );
    const inputs = (await request(
      'GET',
      `/api/media/assets/${result.asset.id}/inputs`,
    )) as MediaAssetInput[];
    assert.deepEqual(
      inputs.map(({ slot, asset }) => ({ slot, assetId: asset!.id })),
      savedInputs[index]!.map(({ slot, assetId }) => ({ slot, assetId })),
    );
    for (const input of inputs) {
      const url = new URL(input.asset!.url, base);
      assert(url.searchParams.has('sig'), 'Available inputs use signed media URLs');
      assert.deepEqual(readFileSync(join(IMAGES_DIR, basename(url.pathname))), png);
    }
  }
  assert.equal(
    stmt('SELECT COUNT(*) AS n FROM media_jobs').get()!.n,
    jobsBeforeDetails,
    'Reading result details never creates a draft',
  );
  for (const id of [firstAsset.id, 999999]) {
    assert.equal((await fetch(`${base}/api/media/assets/${id}/details`)).status, 404);
  }
  const activeJob = (await request('POST', `/api/media/assets/${results[0]!.asset.id}/rerun`, {
    requestKey: 'active-input-owner',
  })) as MediaJob;
  updateMediaJob(activeJob.id, { state: 'rendering' });
  const idleJob = (await request('POST', `/api/media/assets/${results[1]!.asset.id}/rerun`, {
    requestKey: 'idle-input-owner',
  })) as MediaJob;
  await request('DELETE', `/api/gallery/${firstGallery}`);
  const partial = (await request(
    'GET',
    `/api/media/assets/${results[1]!.asset.id}/inputs`,
  )) as MediaAssetInput[];
  assert.deepEqual(
    partial.map(({ slot, asset }) => ({ slot, assetId: asset?.id ?? null })),
    [
      { slot: 'reference1', assetId: null },
      { slot: 'reference2', assetId: referenceAsset.id },
      { slot: 'reference3', assetId: null },
    ],
  );
  await request('POST', '/api/gallery/bulk-delete', { ids: [referenceGallery] });
  assert(
    existsSync(join(IMAGES_DIR, basename(first))),
    'A running job can finish reading its input',
  );
  assert(
    !existsSync(join(IMAGES_DIR, basename(reference))),
    'Idle jobs and recipes do not retain deleted inputs',
  );
  const lateRecipe = saveMediaRecipe(
    { comfyUrl: 'http://127.0.0.1:1', workflow: workflows[0]!, timeoutSeconds: 60 },
    savedInputs[0]!,
    'Result completed after source deletion',
  );
  assert.deepEqual(getMediaRecipe(lateRecipe).inputs, [
    { slot: 'first_frame', assetId: null, prompt: '' },
  ]);
  stmt('DELETE FROM media_recipes WHERE id = ?').run(lateRecipe);
  finishMediaJob(activeJob.id, 'failed', 'Test finished');
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert(
    !existsSync(join(IMAGES_DIR, basename(first))),
    'The running job releases the deleted input when it finishes',
  );
  sweepOrphanedImages();
  for (const [index, result] of results.entries()) {
    const inputs = (await request(
      'GET',
      `/api/media/assets/${result.asset.id}/inputs`,
    )) as MediaAssetInput[];
    assert.deepEqual(
      inputs,
      savedInputs[index]!.map(({ slot }) => ({ slot, asset: null })),
    );
    const rerun = (await request('POST', `/api/media/assets/${result.asset.id}/rerun`, {
      requestKey: `rerun-${index}`,
    })) as MediaJob;
    assert.deepEqual(rerun.inputs, [], 'Reruns leave missing input selectors empty');
    assert.equal(rerun.workflowSnapshot!.id, workflows[index]!.id);
    assert.equal(rerun.workflowSnapshot!.referenceCount, workflows[index]!.referenceCount);
    const render = await fetch(`${base}/api/media/jobs/${rerun.id}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: rerun.revision }),
    });
    assert.equal(render.status, 400, 'Rendering requires replacement images');
    await request('DELETE', `/api/media/jobs/${rerun.id}?expectedRevision=${rerun.revision}`);
  }
  await request('DELETE', `/api/media/jobs/${idleJob.id}?expectedRevision=${idleJob.revision}`);
  for (const result of results) await request('DELETE', `/api/gallery/${result.galleryId}`);
  assert(
    !existsSync(join(IMAGES_DIR, basename(first))),
    'Deleted inputs remain deleted after removing generated results',
  );
  assert(!existsSync(join(IMAGES_DIR, basename(reference))));
  assert.equal(
    (await fetch(`${base}/api/media/assets/${results[0]!.asset.id}/inputs`)).status,
    404,
  );
  assert.equal((await fetch(`${base}/api/media/assets/invalid/inputs`)).status, 400);
  assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
  console.log(
    'Source-image API preserves deleted slots, releases files, and requires replacements on rerun',
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
