import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, extname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { DEFAULT_SETTINGS, GENERAL_TRANSFER_FIELDS, type GalleryItem } from '@tinytavern/shared';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { IMAGES_DIR, AVATAR_DIR, stmt, toGalleryItem, mediaAssetForPath } =
  await import('../server/src/db.ts');
const { saveImage, deleteImageFiles, sweepOrphanedImages, rasterImageFormat } =
  await import('../server/src/images.ts');
const { imageDimensions } = await import('../server/src/imageDimensions.ts');
const { getSettings } = await import('../server/src/settingsStore.ts');
const { invalidate } = await import('../server/src/events.ts');
const { initMediaThumbnails, stopMediaThumbnails } =
  await import('../server/src/mediaThumbnails.ts');
const { publicAvatar } = await import('../server/src/mediaUrls.ts');
const { saveAvatar, deleteAvatarFiles, readAvatarFile } =
  await import('../server/src/routes/avatarStore.ts');
const { dispatch } = await import('../server/src/router.ts');
await import('../server/src/routes/gallery.ts');
await import('../server/src/routes/settings.ts');
const runFile = promisify(execFile);

async function fixture(
  name: string,
  width: number,
  height: number,
  video = false,
): Promise<GalleryItem> {
  const file = join(IMAGES_DIR, name);
  await runFile('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=blue:s=${width}x${height}:r=5:d=0.2`,
    ...(video ? ['-c:v', 'libaom-av1', '-cpu-used', '8'] : ['-frames:v', '1']),
    '-threads',
    '1',
    '-y',
    file,
  ]);
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
      stmt('SELECT count(*) AS n FROM media_assets WHERE thumbnail_size IS NOT ?').get(size)!.n ===
      0,
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
const server = createServer((request, response) => {
  void dispatch(request, response, new URL(request.url!, 'http://test').pathname);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
async function resize(size: unknown, status = 200) {
  const response = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ galleryThumbnailSize: size, expectedRevision: getSettings().revision }),
  });
  assert.equal(response.status, status, await response.text());
}
async function remove(id: number) {
  const response = await fetch(`${base}/api/gallery/${id}`, { method: 'DELETE' });
  assert.equal(response.status, 204, await response.text());
}
try {
  assert.equal(DEFAULT_SETTINGS.galleryThumbnailSize, 512);
  assert(GENERAL_TRANSFER_FIELDS.includes('galleryThumbnailSize'));
  const landscape = await fixture('landscape.png', 1280, 720);
  const portrait = await fixture('portrait.webp', 360, 640);
  const tiny = await fixture('tiny.jpg', 32, 20);
  const video = await fixture('video.webm', 1280, 720, true);
  const avatarOriginal = readFileSync(file(landscape.image));
  const characterId = Number(
    stmt("INSERT INTO characters(name, created_at) VALUES ('Avatar test', 1)").run()
      .lastInsertRowid,
  );
  const avatar = saveAvatar('character', characterId, avatarOriginal);
  assert.match(avatar, /^\/avatars\/character-\d+\.png\?v=\d+$/);
  stmt('UPDATE characters SET avatar = ? WHERE id = ?').run(avatar, characterId);
  const personaId = Number(
    stmt("INSERT INTO personas(name, created_at) VALUES ('Persona test', 1)").run().lastInsertRowid,
  );
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
  console.log(
    'Media thumbnails: JPEG image/video sizing, no upscaling, settings validation, rebuilds, original preservation, new items, deletion races, ownership and restart recovery passed.',
  );
} finally {
  await stopMediaThumbnails();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
