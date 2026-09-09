import { testApi } from '../support/http.ts';
import { renderMediaFixture } from '../support/media.ts';
import { conversationFixture, insertFixture } from '../support/fixtures.ts';
import { testRequestKey } from '../support/requestKey.ts';
import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('media source images', async () => {
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
  const { basename, join } = await import('node:path');
  type GalleryItem = import('@tinytavern/shared').GalleryItem;
  type MediaAssetInput = import('@tinytavern/shared').MediaAssetInput;
  type MediaJob = import('@tinytavern/shared').MediaJob;
  type MediaWorkflow = import('@tinytavern/shared').MediaWorkflow;
  type MediaResultDetails = import('@tinytavern/shared').MediaResultDetails;
  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const signingKey = join(process.env.DATA_DIR!, 'source-test-key');
  writeFileSync(signingKey, '11'.repeat(32));
  process.env.MEDIA_SIGNING_KEY_FILE = signingKey;
  const { stmt, IMAGES_DIR, mediaAssetForPath, invalidateMediaAsset } =
    await import('../../server/src/db/db.ts');
  const { saveImage, sweepOrphanedImages } = await import('../../server/src/media/images.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const { saveMediaRecipe, getMediaRecipe } =
    await import('../../server/src/media/mediaRecipes.ts');
  const { updateMediaJob } = await import('../../server/src/media/mediaJobStore.ts');
  const { finishMediaJob } = await import('../../server/src/media/mediaJobResults.ts');
  await import('../../server/src/routes/mediaJobs.ts');
  await import('../../server/src/routes/gallery.ts');

  const gallery = (image: string) =>
    insertFixture('gallery_items', {
      character_name: 'Test',
      prompt: 'Saved prompt',
      image,
      created_at: 1,
      updated_at: 1,
    });
  const png = makePlaceholderPng();
  const first = saveImage('.png', png);
  const reference = saveImage('.png', png);
  const firstAsset = mediaAssetForPath(first)!;
  const referenceAsset = mediaAssetForPath(reference)!;
  const firstGallery = gallery(first);
  const referenceGallery = gallery(reference);
  const videoPath = join(IMAGES_DIR, 'fixture.webm');
  await renderMediaFixture(videoPath, 32, 24, true);
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
    const path = saveImage('.webm', videoBytes);
    stmt('UPDATE media_assets SET recipe_id = ?, width = 32, height = 24 WHERE path = ?').run(
      recipeId,
      path,
    );
    invalidateMediaAsset(path);
    return { asset: mediaAssetForPath(path)!, galleryId: gallery(path) };
  });

  const { server, base, request } = await testApi();
  try {
    const { appendMessage } = await import('../../server/src/conversations/tree.ts');
    conversationFixture({ id: 1, title: 'Video chat' });
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
      requestKey: testRequestKey('active-input-owner'),
    })) as MediaJob;
    updateMediaJob(activeJob.id, { state: 'rendering' });
    const idleJob = (await request('POST', `/api/media/assets/${results[1]!.asset.id}/rerun`, {
      requestKey: testRequestKey('idle-input-owner'),
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
        requestKey: testRequestKey(`rerun-${index}`),
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
  } finally {
    await server.stop(true);
  }
});
