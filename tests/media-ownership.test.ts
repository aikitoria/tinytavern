import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireTestIsolation } from './isolation.ts';
requireTestIsolation();
const { stmt, IMAGES_DIR, mediaAssetForPath } = await import('../server/src/db.ts');
const { saveImage, copyImage, deleteImageFiles, sweepOrphanedImages } =
  await import('../server/src/images.ts');
const { makePlaceholderPng } = await import('../server/src/pngCard.ts');
const path = saveImage('owned.png', makePlaceholderPng());
const asset = mediaAssetForPath(path)!;
assert.equal(asset.mime, 'image/png');
assert.ok(asset.byteSize! > 0);
stmt("INSERT INTO conversations(id, title, created_at, updated_at) VALUES (1, 'Test', 1, 1)").run();
stmt(
  "INSERT INTO messages(id, conversation_id, role, content, images_json, created_at) VALUES (1, 1, 'tool', 'image', ?, 1)",
).run(JSON.stringify([path]));
stmt("INSERT INTO media_owners VALUES (?, 'job', 'active', 'source')").run(asset.id);
stmt('DELETE FROM messages WHERE id = 1').run();
deleteImageFiles([path]);
assert.ok(existsSync(join(IMAGES_DIR, 'owned.png')), 'A job retains a deleted message input');
sweepOrphanedImages();
assert.ok(existsSync(join(IMAGES_DIR, 'owned.png')), 'Startup sweep retains input pins');
stmt("DELETE FROM media_owners WHERE owner_type = 'job'").run();
deleteImageFiles([path]);
assert.equal(existsSync(join(IMAGES_DIR, 'owned.png')), false);

const galleryPath = saveImage('gallery.png', makePlaceholderPng());
stmt(
  "INSERT INTO gallery_items(id, character_name, prompt, image, created_at, updated_at) VALUES (1, 'Test', 'prompt', ?, 1, 1)",
).run(galleryPath);
const duplicate = copyImage(galleryPath, 'copy.png')!;
assert.notEqual(mediaAssetForPath(galleryPath)!.id, mediaAssetForPath(duplicate)!.id);
stmt('DELETE FROM gallery_items WHERE id = 1').run();
deleteImageFiles([galleryPath]);
assert.ok(existsSync(join(IMAGES_DIR, 'copy.png')), 'Copies retain independent file ownership');
const input = saveImage('recipe-input.png', makePlaceholderPng());
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
  existsSync(join(IMAGES_DIR, 'recipe-input.png')),
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
