import { testApi } from '../support/http.ts';
import { renderMediaFixture } from '../support/media.ts';
import { insertFixture } from '../support/fixtures.ts';
import assert from 'node:assert/strict';
import { databaseCase } from '../support/database.ts';

databaseCase('media files', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { readFileSync, readdirSync, unlinkSync, writeFileSync } = await import('node:fs');
  const { basename, join } = await import('node:path');
  const { IMAGES_DIR, stmt } = await import('../../server/src/db/db.ts');
  const { downloadMedia, InvalidMediaOutput } =
    await import('../../server/src/media/mediaFiles.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  const runFile = promisify(execFile);

  const sourcePath = join(IMAGES_DIR, 'source.webm');
  await renderMediaFixture(sourcePath, 64, 48, true, 0.6, 2);
  const original = readFileSync(sourcePath);
  const matroskaPath = join(IMAGES_DIR, 'source.mkv');
  await runFile('ffmpeg', ['-v', 'error', '-i', sourcePath, '-c', 'copy', '-y', matroskaPath]);
  await assert.rejects(
    downloadMedia(new Response(readFileSync(matroskaPath)), 'video', new AbortController().signal),
    InvalidMediaOutput,
    'An AV1 Matroska file must not be stored or served as WebM',
  );
  const video = await downloadMedia(new Response(original), 'video', new AbortController().signal);
  assert.equal(video.mime, 'video/webm');
  assert.equal(video.width, 64);
  assert.equal(video.height, 48);
  assert(video.duration !== null && video.duration > 0);
  assert(!readdirSync(IMAGES_DIR).some((name) => name.includes('poster')));
  assert.deepEqual(
    readFileSync(join(IMAGES_DIR, basename(video.path))),
    original,
    'The AV1 WebM original is stored byte-for-byte',
  );
  assert(!readdirSync(IMAGES_DIR).some((name) => name.endsWith('.part')));

  const png = makePlaceholderPng();
  const image = await downloadMedia(new Response(png), 'image', new AbortController().signal);
  assert.equal(image.mime, 'image/png');
  assert.deepEqual(readFileSync(join(IMAGES_DIR, basename(image.path))), png);

  await assert.rejects(
    downloadMedia(new Response(original), 'image', new AbortController().signal),
    /invalid raster/,
  );
  await assert.rejects(
    downloadMedia(
      new Response(png, { headers: { 'content-length': String(2 ** 30 + 1) } }),
      'video',
      new AbortController().signal,
    ),
    /size limit/,
  );
  assert(
    !readdirSync(IMAGES_DIR).some((name) => name.endsWith('.part')),
    'Rejected downloads leave no partial files',
  );

  const chunk = new Uint8Array(1024 * 1024);
  let chunksSent = 0;
  await assert.rejects(
    downloadMedia(
      new Response(
        new ReadableStream({
          pull(stream) {
            stream.enqueue(chunk);
            if (++chunksSent === 65) {
              stream.close();
            }
          },
        }),
      ),
      'image',
      new AbortController().signal,
    ),
    InvalidMediaOutput,
    'An oversized chunked download is a terminal invalid output, not a retrieval retry',
  );

  const controller = new AbortController();
  const response = new Response(
    new ReadableStream({
      start(stream) {
        stream.enqueue(original.subarray(0, 12));
        setTimeout(() => controller.abort(), 10);
      },
    }),
  );
  await assert.rejects(downloadMedia(response, 'video', controller.signal), /abort/i);
  assert(!readdirSync(IMAGES_DIR).some((name) => name.endsWith('.part')));
  assert.equal(
    stmt('SELECT count(*) AS count FROM media_assets').get()!.count,
    2,
    'Failed downloads release their asset reservations',
  );
  for (const asset of stmt('SELECT id, path FROM media_assets').all()) {
    assert.match(String(asset.path), new RegExp(`/media-${asset.id}\\.(png|webm)$`));
  }

  // Deterministic names must preserve unexpected files rather than overwrite or clean them up.
  for (const extension of ['.part', '.png']) {
    const nextId =
      Number(stmt("SELECT seq FROM sqlite_sequence WHERE name = 'media_assets'").get()!.seq) + 1;
    const collision = join(IMAGES_DIR, `media-${nextId}${extension}`);
    writeFileSync(collision, 'Unrelated bytes');
    await assert.rejects(downloadMedia(new Response(png), 'image', new AbortController().signal), {
      code: 'EEXIST',
    });
    assert.equal(readFileSync(collision, 'utf8'), 'Unrelated bytes');
    assert.equal(stmt('SELECT count(*) AS count FROM media_assets').get()!.count, 2);
    unlinkSync(collision);
  }
});

databaseCase('gallery video uploads', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { readFileSync, existsSync, readdirSync, unlinkSync } = await import('node:fs');
  const { basename, join } = await import('node:path');
  const { IMAGES_DIR, stmt, mediaAssetForPath } = await import('../../server/src/db/db.ts');
  const { copyImage, deleteImageFiles } = await import('../../server/src/media/images.ts');
  await import('../../server/src/routes/gallery.ts');
  const { server, base, request } = await testApi();
  const webm = join(IMAGES_DIR, 'upload-source.webm');
  const mp4 = join(IMAGES_DIR, 'upload-source.mp4');
  await renderMediaFixture(webm, 64, 48, true);
  await promisify(execFile)('ffmpeg', [
    '-v',
    'error',
    '-i',
    webm,
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-y',
    mp4,
  ]);
  try {
    for (const [source, mime] of [
      [webm, 'video/webm'],
      [mp4, 'video/mp4'],
    ] as const) {
      const original = readFileSync(source);
      const response = await fetch(`${base}/api/gallery/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: original,
      });
      assert.equal(response.status, 200, await response.clone().text());
      const item = (await response.json()) as import('@tinytavern/shared').GalleryItem;
      assert.equal(item.media?.kind, 'video');
      assert.equal(item.media?.mime, mime);
      assert.equal(item.imageWidth, 64);
      assert.equal(item.imageHeight, 48);
      assert(item.media!.duration! > 0);
      const path = String(
        stmt('SELECT path FROM media_assets WHERE id = ?').get(item.media!.id)!.path,
      );
      const file = join(IMAGES_DIR, basename(path));
      assert.deepEqual(readFileSync(file), original, 'Uploads preserve the original video bytes');
      const copied = copyImage(path)!;
      assert.equal(mediaAssetForPath(copied)?.mime, mime);
      assert.equal(mediaAssetForPath(copied)?.duration, item.media!.duration);
      await request('DELETE', `/api/gallery/${item.id}`, undefined, 204);
      assert(!existsSync(file), 'Deleting the gallery entry releases its video');
      assert.deepEqual(readFileSync(join(IMAGES_DIR, basename(copied))), original);
      deleteImageFiles([copied]);
    }
    const invalid = await fetch(`${base}/api/gallery/upload`, {
      method: 'POST',
      headers: { 'content-type': 'video/mp4' },
      body: 'not a video',
    });
    assert.equal(invalid.status, 400, 'A claimed video MIME type cannot bypass validation');
    assert.equal(stmt('SELECT count(*) AS n FROM media_assets').get()!.n, 0);
    assert(!readdirSync(IMAGES_DIR).some((name) => name.endsWith('.part')));
  } finally {
    await server.stop(true);
    unlinkSync(webm);
    unlinkSync(mp4);
  }
});

databaseCase('media thumbnails', async () => {
  const { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } =
    await import('node:fs');
  const { basename, extname, join } = await import('node:path');
  const { setTimeout: sleep } = await import('node:timers/promises');
  const { DEFAULT_SETTINGS, GENERAL_TRANSFER_FIELDS } = await import('@tinytavern/shared');
  type GalleryItem = import('@tinytavern/shared').GalleryItem;
  const { IMAGES_DIR, AVATAR_DIR, stmt, toGalleryItem, mediaAssetForPath } =
    await import('../../server/src/db/db.ts');
  const { saveImage, deleteImageFiles, sweepOrphanedImages, rasterImageFormat } =
    await import('../../server/src/media/images.ts');
  const { imageDimensions } = await import('../../server/src/media/imageDimensions.ts');
  const { getSettings } = await import('../../server/src/settings/settingsStore.ts');
  const { invalidate } = await import('../../server/src/realtime/events.ts');
  const { initMediaThumbnails, stopMediaThumbnails } =
    await import('../../server/src/media/mediaThumbnails.ts');
  const { publicAvatar } = await import('../../server/src/media/mediaUrls.ts');
  const { saveAvatar, deleteAvatarFiles, readAvatarFile } =
    await import('../../server/src/characters/avatarStore.ts');
  await import('../../server/src/routes/gallery.ts');
  await import('../../server/src/routes/settings.ts');

  async function fixture(
    name: string,
    width: number,
    height: number,
    video = false,
  ): Promise<GalleryItem> {
    const file = join(IMAGES_DIR, name);
    await renderMediaFixture(file, width, height, video);
    const path = saveImage(extname(name), readFileSync(file));
    unlinkSync(file);
    const result =
      stmt(`INSERT INTO gallery_items(character_name, prompt, image, image_width, image_height, created_at, updated_at)
    VALUES ('Uploads', 'Saved prompt', ?, ?, ?, 1, 1)`).run(path, width, height);
    invalidate('gallery');
    return item(Number(result.lastInsertRowid));
  }
  function item(id: number): GalleryItem {
    return toGalleryItem(
      stmt("SELECT *, '[]' AS characters_json FROM gallery_items WHERE id = ?").get(id)!,
    );
  }
  function file(path: string): string {
    return join(IMAGES_DIR, basename(path));
  }
  async function until(condition: () => boolean) {
    const deadline = Date.now() + 15_000;
    while (!condition() && Date.now() < deadline) await sleep(20);
    assert(condition(), 'Thumbnail work completed before the timeout');
  }
  async function ready(size: number) {
    await until(
      () =>
        stmt('SELECT count(*) AS n FROM media_assets WHERE thumbnail_size IS NOT ?').get(size)!
          .n === 0,
    );
  }
  function checkThumbnail(gallery: GalleryItem, width: number, height: number) {
    const current = item(gallery.id);
    assert(current.media!.thumbnail);
    assert.equal(
      current.media!.thumbnail,
      `/images/thumb-${current.media!.id}-${current.media!.thumbnailRevision}.jpg`,
    );
    const data = readFileSync(file(current.media!.thumbnail));
    assert.equal(rasterImageFormat(data)?.mime, 'image/jpeg');
    assert.deepEqual(imageDimensions(data), { width, height });
    assert.equal(current.updatedAt, 1, 'Generating a thumbnail must not reorder the gallery');
  }
  const { server, request } = await testApi();
  const resize = (size: unknown, status = 200) =>
    request(
      'PUT',
      '/api/settings',
      {
        galleryThumbnailSize: size,
        expectedRevision: getSettings().revision,
      },
      status,
    );
  const remove = (id: number) => request('DELETE', `/api/gallery/${id}`, undefined, 204);
  try {
    assert.equal(DEFAULT_SETTINGS.galleryThumbnailSize, 512);
    assert(GENERAL_TRANSFER_FIELDS.includes('galleryThumbnailSize'));
    const landscape = await fixture('landscape.png', 1280, 720);
    const portrait = await fixture('portrait.webp', 360, 640);
    const tiny = await fixture('tiny.jpg', 32, 20);
    const video = await fixture('video.webm', 1280, 720, true);
    const avatarOriginal = readFileSync(file(landscape.image));
    const characterId = insertFixture('characters', { name: 'Avatar test', created_at: 1 });
    const avatar = saveAvatar('character', characterId, avatarOriginal);
    assert.match(avatar, /^\/avatars\/character-\d+\.png\?v=\d+$/);
    stmt('UPDATE characters SET avatar = ? WHERE id = ?').run(avatar, characterId);
    const personaId = insertFixture('personas', { name: 'Persona test', created_at: 1 });
    const personaAvatar = saveAvatar('persona', personaId, avatarOriginal);
    stmt('UPDATE personas SET avatar = ? WHERE id = ?').run(personaAvatar, personaId);
    const originals = [landscape, portrait, tiny, video].map((gallery) =>
      readFileSync(file(gallery.image)),
    );
    assert.equal(landscape.media!.thumbnail, null);
    initMediaThumbnails();
    await ready(512);
    await until(
      () =>
        Number(
          stmt('SELECT count(*) AS n FROM avatar_thumbnails WHERE thumbnail_size = 128').get()!.n,
        ) === 2,
    );
    const avatarPreview = publicAvatar({ avatar }).avatarThumbnail!;
    assert.equal(
      avatarPreview,
      `/avatars/thumb-character-${characterId}-${avatar.split('?v=')[1]}-1.jpg`,
    );
    assert.equal(
      publicAvatar({ avatar: personaAvatar }).avatarThumbnail,
      `/avatars/thumb-persona-${personaId}-${personaAvatar.split('?v=')[1]}-1.jpg`,
    );
    assert.deepEqual(imageDimensions(readFileSync(join(AVATAR_DIR, basename(avatarPreview)))), {
      width: 128,
      height: 72,
    });
    assert.deepEqual(
      readAvatarFile('character', characterId),
      avatarOriginal,
      'Avatar export retains original PNG bytes',
    );
    const replacement = saveAvatar('character', characterId, avatarOriginal);
    assert(Number(replacement.split('?v=')[1]) > Number(avatar.split('?v=')[1]));
    stmt('UPDATE characters SET avatar = ? WHERE id = ?').run(replacement, characterId);
    invalidate('characters');
    await until(() => Boolean(publicAvatar({ avatar: replacement }).avatarThumbnail));
    assert(
      !existsSync(join(AVATAR_DIR, basename(avatarPreview))),
      'Replacing an avatar removes its old thumbnail',
    );
    await stopMediaThumbnails();
    const replacedPreview = publicAvatar({ avatar: replacement }).avatarThumbnail!;
    unlinkSync(join(AVATAR_DIR, basename(replacedPreview)));
    initMediaThumbnails();
    await until(() => {
      const preview = publicAvatar({ avatar: replacement }).avatarThumbnail;
      return Boolean(preview && preview !== replacedPreview);
    });
    assert.equal(
      publicAvatar({ avatar: replacement }).avatarThumbnail,
      `/avatars/thumb-character-${characterId}-${replacement.split('?v=')[1]}-2.jpg`,
      'A restart repair advances the derivative revision without reusing its old URL',
    );
    deleteAvatarFiles('character', characterId);
    stmt('DELETE FROM characters WHERE id = ?').run(characterId);
    deleteAvatarFiles('persona', personaId);
    stmt('DELETE FROM personas WHERE id = ?').run(personaId);
    invalidate('characters');
    invalidate('personas');
    await until(() => stmt('SELECT count(*) AS n FROM avatar_thumbnails').get()!.n === 0);
    assert.deepEqual(readdirSync(AVATAR_DIR), [], 'Deleting avatars removes their previews too');
    checkThumbnail(landscape, 512, 288);
    checkThumbnail(portrait, 288, 512);
    checkThumbnail(tiny, 32, 20);
    checkThumbnail(video, 512, 288);
    const thumbnails = [landscape, portrait, tiny, video].map(
      (gallery) => item(gallery.id).media!.thumbnail!,
    );
    deleteImageFiles(thumbnails);
    sweepOrphanedImages();
    assert(
      thumbnails.every((path) => existsSync(file(path))),
      'Owned thumbnails survive file cleanup',
    );

    for (const invalid of [0, 63, 2049, 128.5, null, '256']) await resize(invalid, 400);
    assert.equal(getSettings().galleryThumbnailSize, 512);
    await resize(256);
    for (const gallery of [landscape, portrait, tiny, video]) {
      assert(
        existsSync(file(item(gallery.id).media!.thumbnail!)),
        'A rebuild always keeps a usable thumbnail',
      );
    }
    await ready(256);
    checkThumbnail(landscape, 256, 144);
    checkThumbnail(video, 256, 144);
    assert(
      thumbnails.every((path) => !existsSync(file(path))),
      'Replaced thumbnails are deleted',
    );
    for (const [index, gallery] of [landscape, portrait, tiny, video].entries()) {
      assert.deepEqual(
        readFileSync(file(gallery.image)),
        originals[index],
        'Original bytes stay unchanged',
      );
    }

    await resize(128);
    await resize(64);
    await resize(384);
    await ready(384);
    checkThumbnail(video, 384, 216);
    const standalone = saveImage('.png', originals[0]!);
    const standaloneAsset = mediaAssetForPath(standalone)!;
    stmt("INSERT INTO media_owners VALUES (?, 'job', 'draft-only', 'output:1')").run(
      standaloneAsset.id,
    );
    await ready(384);
    const standaloneThumbnail = mediaAssetForPath(standalone)!.thumbnail!;
    assert(standaloneThumbnail, 'Media outside the gallery receives thumbnails');
    stmt("DELETE FROM media_owners WHERE owner_id = 'draft-only'").run();
    deleteImageFiles([standalone]);
    assert(!existsSync(file(standaloneThumbnail)), 'Discarding a draft removes its thumbnail');
    const added = await fixture('new.png', 640, 480);
    await ready(384);
    checkThumbnail(added, 384, 288);

    const doomed = await fixture('doomed.png', 1600, 900);
    await sleep(5);
    await remove(doomed.id);
    await ready(384);
    await stopMediaThumbnails();
    assert(
      !stmt('SELECT id FROM media_assets WHERE path = ?').get(doomed.image),
      'Deletion during generation leaves no late thumbnail',
    );

    const missing = item(added.id).media!.thumbnail!;
    unlinkSync(file(missing));
    writeFileSync(join(IMAGES_DIR, 'gallery-thumb-orphan.jpg'), 'orphan');
    writeFileSync(join(IMAGES_DIR, 'old-poster.jpg'), 'obsolete');
    sweepOrphanedImages();
    assert(!existsSync(join(IMAGES_DIR, 'gallery-thumb-orphan.jpg')));
    assert(!existsSync(join(IMAGES_DIR, 'old-poster.jpg')));
    initMediaThumbnails();
    await ready(384);
    assert.notEqual(
      item(added.id).media!.thumbnail,
      missing,
      'Startup repairs missing thumbnail files',
    );
    checkThumbnail(added, 384, 288);
    const saved = [landscape, portrait, tiny, video, added].map((gallery) => item(gallery.id));
    for (const gallery of saved) {
      await remove(gallery.id);
      assert(!existsSync(file(gallery.image)));
      assert(
        !existsSync(file(gallery.media!.thumbnail!)),
        'Deleting gallery media also deletes its thumbnail',
      );
    }
    await stopMediaThumbnails();
    assert.deepEqual(readdirSync(IMAGES_DIR), []);
    assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    await stopMediaThumbnails();
    await server.stop(true);
  }
});
