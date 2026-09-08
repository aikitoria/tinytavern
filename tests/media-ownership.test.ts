import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireTestIsolation } from './isolation.ts';
requireTestIsolation();
const { stmt, IMAGES_DIR, mediaAssetForPath, transaction } = await import('../server/src/db.ts');
const { saveImage, copyImage, deleteImageFiles, sweepOrphanedImages, reserveMediaFile } =
  await import('../server/src/images.ts');
const { makePlaceholderPng } = await import('../server/src/pngCard.ts');
const path = saveImage('.png', makePlaceholderPng());
const asset = mediaAssetForPath(path)!;
assert.equal(path, `/images/media-${asset.id}.png`);
assert.equal(asset.mime, 'image/png');
assert.ok(asset.byteSize! > 0);
stmt("INSERT INTO conversations(id, title, created_at, updated_at) VALUES (1, 'Test', 1, 1)").run();
stmt(
  "INSERT INTO messages(id, conversation_id, role, content, images_json, created_at) VALUES (1, 1, 'tool', 'image', ?, 1)",
).run(JSON.stringify([path]));
stmt("INSERT INTO media_owners VALUES (?, 'job', 'active', 'source')").run(asset.id);
const assetCount = stmt('SELECT count(*) AS count FROM media_assets').get()!.count;
const beforeFailedSave = readdirSync(IMAGES_DIR).sort();
stmt(`CREATE TRIGGER reject_saved_media BEFORE UPDATE OF byte_size ON media_assets
  BEGIN SELECT RAISE(ABORT, 'Injected metadata error'); END`).run();
transaction(() => {
  assert.throws(() => saveImage('.png', makePlaceholderPng()), /Injected metadata error/);
});
stmt('DROP TRIGGER reject_saved_media').run();
assert.equal(stmt('SELECT count(*) AS count FROM media_assets').get()!.count, assetCount);
assert.deepEqual(
  readdirSync(IMAGES_DIR).sort(),
  beforeFailedSave,
  'A failed save caught inside an outer transaction releases both its file and reservation',
);
transaction(() => {
  assert.equal(copyImage('/images/missing.png'), null);
});
assert.equal(
  stmt('SELECT count(*) AS count FROM media_assets').get()!.count,
  assetCount,
  'A skipped missing copy inside an outer transaction leaves no asset reservation',
);
const reservedBeforeCrash = reserveMediaFile('.part');
stmt('DELETE FROM messages WHERE id = 1').run();
deleteImageFiles([path]);
assert.ok(existsSync(join(IMAGES_DIR, path.slice(8))), 'A job retains a deleted message input');
sweepOrphanedImages();
assert.equal(
  stmt('SELECT id FROM media_assets WHERE id = ?').get(reservedBeforeCrash.id),
  undefined,
  'Startup releases a reservation whose process died before creating the file',
);
assert.ok(existsSync(join(IMAGES_DIR, path.slice(8))), 'Startup sweep retains input pins');
stmt("DELETE FROM media_owners WHERE owner_type = 'job'").run();
deleteImageFiles([path]);
assert.equal(existsSync(join(IMAGES_DIR, path.slice(8))), false);

const galleryPath = saveImage('.png', makePlaceholderPng());
stmt(
  "INSERT INTO gallery_items(id, character_name, prompt, image, created_at, updated_at) VALUES (1, 'Test', 'prompt', ?, 1, 1)",
).run(galleryPath);
const duplicate = copyImage(galleryPath)!;
assert.notEqual(mediaAssetForPath(galleryPath)!.id, mediaAssetForPath(duplicate)!.id);
stmt('DELETE FROM gallery_items WHERE id = 1').run();
deleteImageFiles([galleryPath]);
assert.ok(
  existsSync(join(IMAGES_DIR, duplicate.slice(8))),
  'Copies retain independent file ownership',
);
const input = saveImage('.png', makePlaceholderPng());
stmt(
  "INSERT INTO media_recipes(id, prompt, configuration_json, inputs_json, created_at) VALUES ('recipe', 'prompt', '{}', '[]', 1)",
).run();
stmt("INSERT INTO media_owners VALUES (?, 'recipe', 'recipe', 'source')").run(
  mediaAssetForPath(input)!.id,
);
stmt("UPDATE media_assets SET recipe_id = 'recipe' WHERE path = ?").run(duplicate);
const { invalidateMediaAsset } = await import('../server/src/db.ts');
invalidateMediaAsset(duplicate);
deleteImageFiles([input, duplicate]);
assert.equal(
  existsSync(join(IMAGES_DIR, input.slice(8))),
  false,
  'Deleting the last result releases its recipe inputs',
);
assert.equal(stmt('SELECT count(*) AS n FROM media_owners').get()!.n, 0);
writeFileSync(join(IMAGES_DIR, 'untracked.tmp'), 'partial');
sweepOrphanedImages();
assert.equal(existsSync(join(IMAGES_DIR, 'untracked.tmp')), false);
assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
console.log(
  'Media ownership covers legacy deletion, startup sweeps, copies and recipe input release',
);
