import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { stmt, IMAGES_DIR, AVATAR_DIR, db } = await import('../server/src/db.ts');
const { sweepOrphanedImages } = await import('../server/src/images.ts');
const dbUrl = new URL('../server/src/db.ts', import.meta.url).href;
const migrationUrl = new URL('../server/src/mediaFileMigration.ts', import.meta.url).href;
const uuid1 = '11111111-1111-4111-8111-111111111111';
const uuid2 = '22222222-2222-4222-8222-222222222222';
const originalPattern = /^\/images\/media-[0-9a-f-]{36}\.(png|jpe?g|webp|webm)$/;
const thumbnailPattern = /^\/images\/thumb-[0-9a-f-]{36}\.jpg$/;
const file = (path: string) => join(IMAGES_DIR, basename(path));
const originalPaths = [
  '/images/gallery-old.png',
  '/images/job-old.webm',
  '/images/msg-copy-old.jpeg',
  '/images/msg-import-old.webp',
  `/images/media-${uuid1}.png`,
  '/images/missing.png',
];
const oldThumbnail = '/images/gallery-thumb-old.jpg';
const currentThumbnail = `/images/thumb-${uuid1}.jpg`;
const collisionThumbnail = `/images/thumb-${uuid2}.jpg`;
for (const path of [...originalPaths.slice(0, -1), oldThumbnail, currentThumbnail]) {
  writeFileSync(file(path), `Bytes belonging to ${path}`);
}
writeFileSync(file(collisionThumbnail), 'An existing file must never be overwritten');
writeFileSync(join(AVATAR_DIR, 'avatar-old.png'), 'Avatar bytes');

stmt(`INSERT INTO conversations(id, title, character_id, created_at, updated_at)
  VALUES (100, 'Migration', 1, 10, 20)`).run();
stmt(`INSERT INTO messages(id, conversation_id, role, content, images_json, active_image, created_at)
  VALUES (100, 100, 'assistant', 'Keep /images/gallery-old.png as literal prose', ?, 1, 10)`).run(
  JSON.stringify([...originalPaths, originalPaths[0]]),
);
stmt(`INSERT INTO gallery_items(id, character_name, prompt, image, source_image, created_at, updated_at)
  VALUES (100, 'Label', 'Prompt', ?, ?, 10, 20),
    (101, 'Second', '', ?, ?, 11, 21)`).run(
  originalPaths[0]!,
  originalPaths[1]!,
  originalPaths[2]!,
  originalPaths[3]!,
);
stmt(`UPDATE media_assets SET thumbnail = ?, thumbnail_size = 512, thumbnail_revision = 7
  WHERE path IN (?, ?)`).run(oldThumbnail, originalPaths[0]!, originalPaths[1]!);
stmt('UPDATE media_assets SET thumbnail = ?, thumbnail_revision = 3 WHERE path = ?').run(
  currentThumbnail,
  originalPaths[4]!,
);
const assets = stmt('SELECT * FROM media_assets ORDER BY id').all();
const assetIds = assets.map((asset) => asset.id!);
stmt(`INSERT INTO media_recipes(id, prompt, configuration_json, inputs_json, created_at)
  VALUES ('recipe', 'Recipe text', ?, ?, 10)`).run(
  JSON.stringify({ workflow: { literal: '/images/job-old.webm' } }),
  JSON.stringify([{ slot: 'reference1', assetId: assetIds[3], prompt: 'Captured input' }]),
);
stmt(`INSERT INTO media_jobs(id, operation, state, inputs_json, outputs_json, created_at, updated_at)
  VALUES ('job', 'image-edit', 'rendering', ?, ?, 10, 20)`).run(
  JSON.stringify([{ slot: 'reference1', assetId: assetIds[2], prompt: 'Input text' }]),
  JSON.stringify([assetIds[1]]),
);
stmt("INSERT INTO media_owners VALUES (?, 'recipe', 'recipe', 'reference1')").run(assetIds[3]!);
stmt("INSERT INTO media_owners VALUES (?, 'job', 'job', 'reference1')").run(assetIds[2]!);
stmt("INSERT INTO media_owners VALUES (?, 'job', 'job', 'output:1')").run(assetIds[1]!);
// A deliberately removed chat-character association must not return when paths are rewritten.
stmt('DELETE FROM media_characters WHERE asset_id = ?').run(assetIds[0]!);
const owners = stmt('SELECT * FROM media_owners ORDER BY owner_type, owner_id, slot').all();
const associations = stmt('SELECT * FROM media_characters ORDER BY asset_id, character_id').all();
const recipes = stmt('SELECT * FROM media_recipes').all();
const jobs = stmt('SELECT * FROM media_jobs').all();
const triggers = stmt(
  "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name",
).all();

function runMigration(prefix = '', suffix = '', migration = 'migrateMediaFileNames') {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `${prefix}
      const { stmt, transaction, IMAGES_DIR, db } = await import(${JSON.stringify(dbUrl)});
      const { ${migration} } = await import(${JSON.stringify(migrationUrl)});
      transaction(() => { ${migration}(IMAGES_DIR, stmt); ${suffix} });
      db.close();`,
    ],
    { env: process.env, encoding: 'utf8' },
  );
}
function checkUnchanged() {
  assert.deepEqual(stmt('SELECT * FROM media_assets ORDER BY id').all(), assets);
  assert.deepEqual(
    JSON.parse(String(stmt('SELECT images_json FROM messages WHERE id = 100').get()!.images_json)),
    [...originalPaths, originalPaths[0]],
  );
  assert.deepEqual(
    stmt("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all(),
    triggers,
  );
  for (const path of originalPaths.slice(0, -1)) assert(existsSync(file(path)));
}

// Crash after durable filesystem changes but before committing any database references.
const interrupted = runMigration(`
  import fs from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  const sync = fs.fsyncSync;
  fs.fsyncSync = (...args) => { sync(...args); process.kill(process.pid, 'SIGKILL'); };
  syncBuiltinESMExports();
`);
assert.equal(interrupted.signal, 'SIGKILL');
checkUnchanged();
assert(readdirSync(IMAGES_DIR).length > originalPaths.length + 2, 'Interrupted links exist');

// Failure after all reference updates also rolls back the temporarily removed triggers.
const rollback = runMigration('', "throw new Error('Injected post-rewrite failure');");
assert.equal(rollback.status, 1);
assert.match(rollback.stderr, /Injected post-rewrite failure/);
checkUnchanged();

// A database update error during startup cannot publish partially changed paths either.
stmt(`CREATE TRIGGER reject_file_migration BEFORE UPDATE OF path ON media_assets
  WHEN old.id = ${assetIds[1]} BEGIN SELECT RAISE(ABORT, 'Injected update failure'); END`).run();
const failed = runMigration();
assert.equal(failed.status, 1);
assert.match(failed.stderr, /Injected update failure/);
stmt('DROP TRIGGER reject_file_migration').run();
checkUnchanged();

// Exercise collisions with a reserved database path and with an unrelated file on disk.
const migrated = runMigration(`
  import crypto from 'node:crypto';
  import { syncBuiltinESMExports } from 'node:module';
  const uuid = crypto.randomUUID;
  const collisions = [${JSON.stringify(uuid1)}, ${JSON.stringify(uuid2)}];
  crypto.randomUUID = () => collisions.shift() ?? uuid();
  syncBuiltinESMExports();
`);
assert.equal(migrated.status, 0, migrated.stderr);
assert.equal(
  readFileSync(file(collisionThumbnail), 'utf8'),
  'An existing file must never be overwritten',
);
const renamed = stmt('SELECT * FROM media_assets ORDER BY id').all();
assert.deepEqual(
  renamed.map((asset) => asset.id),
  assetIds,
  'Asset IDs remain stable',
);
const mapped = new Map(
  assets.map((asset, index) => [String(asset.path), String(renamed[index]!.path)]),
);
for (const [index, asset] of renamed.entries()) {
  const old = assets[index]!;
  if (old.path === '/images/missing.png') {
    assert.equal(asset.path, old.path, 'Missing originals keep their references');
    continue;
  }
  assert.match(String(asset.path), originalPattern);
  assert.equal(readFileSync(file(String(asset.path)), 'utf8'), `Bytes belonging to ${old.path}`);
  assert.equal(statSync(file(String(asset.path))).ino, statSync(file(String(old.path))).ino);
}
assert.equal(
  mapped.get(originalPaths[4]!),
  originalPaths[4],
  'Current original names remain stable',
);
assert.equal(renamed[4]!.thumbnail, currentThumbnail);
assert.equal(renamed[4]!.thumbnail_revision, 3);
assert.equal(renamed[0]!.thumbnail, renamed[1]!.thumbnail, 'Shared thumbnails keep one path');
assert.match(String(renamed[0]!.thumbnail), thumbnailPattern);
assert.equal(renamed[0]!.thumbnail_revision, 8);
assert.equal(renamed[0]!.thumbnail_size, 512);
assert.equal(
  readFileSync(file(String(renamed[0]!.thumbnail)), 'utf8'),
  `Bytes belonging to ${oldThumbnail}`,
);
const message = stmt('SELECT * FROM messages WHERE id = 100').get()!;
assert.deepEqual(
  JSON.parse(String(message.images_json)),
  [...originalPaths, originalPaths[0]].map((path) => mapped.get(path!)),
);
assert.equal(message.active_image, 1);
assert.equal(message.content, 'Keep /images/gallery-old.png as literal prose');
assert.equal(message.created_at, 10);
const gallery = stmt('SELECT * FROM gallery_items WHERE id = 100').get()!;
assert.equal(gallery.image, mapped.get(originalPaths[0]!));
assert.equal(gallery.source_image, mapped.get(originalPaths[1]!));
assert.equal(gallery.updated_at, 20);
assert.deepEqual(
  stmt('SELECT * FROM media_owners ORDER BY owner_type, owner_id, slot').all(),
  owners,
);
assert.deepEqual(
  stmt('SELECT * FROM media_characters ORDER BY asset_id, character_id').all(),
  associations,
);
assert.deepEqual(stmt('SELECT * FROM media_recipes').all(), recipes);
assert.deepEqual(stmt('SELECT * FROM media_jobs').all(), jobs);
assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
assert.equal(stmt('PRAGMA integrity_check').get()!.integrity_check, 'ok');

// A restart between commit and orphan cleanup must not rename current files a second time.
const beforeRestart = readdirSync(IMAGES_DIR).sort();
const repeated = runMigration();
assert.equal(repeated.status, 0, repeated.stderr);
assert.deepEqual(stmt('SELECT * FROM media_assets ORDER BY id').all(), renamed);
assert.deepEqual(readdirSync(IMAGES_DIR).sort(), beforeRestart);
sweepOrphanedImages();
for (const path of [...originalPaths.slice(0, 4), oldThumbnail]) assert(!existsSync(file(path)));
for (const asset of renamed) {
  if (asset.path !== '/images/missing.png') assert(existsSync(file(String(asset.path))));
  if (asset.thumbnail) assert(existsSync(file(String(asset.thumbnail))));
}
assert.equal(readdirSync(IMAGES_DIR).length, 7, 'Sweep removes rollback links and old names only');
assert.equal(readFileSync(join(AVATAR_DIR, 'avatar-old.png'), 'utf8'), 'Avatar bytes');
assert.deepEqual(
  stmt("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all(),
  triggers,
);

// Numeric filenames use existing asset identities, including UUID names from migration 62.
const extraPaths = ['/images/gallery-numeric.png', '/images/job-numeric.webm'];
for (const path of extraPaths) writeFileSync(file(path), `Bytes belonging to ${path}`);
stmt(`INSERT INTO messages(id, conversation_id, role, content, images_json, active_image, created_at)
  VALUES (101, 100, 'assistant', 'Numeric migration', ?, 1, 10)`).run(JSON.stringify(extraPaths));
// One old derivative may be shared by multiple assets and independently owned as an original.
const sharedThumbnail = String(renamed[0]!.thumbnail);
stmt(`INSERT INTO gallery_items(character_name, prompt, image, source_image, created_at, updated_at)
  VALUES ('Shared thumbnail', '', ?, ?, 10, 20)`).run(sharedThumbnail, extraPaths[0]!);
stmt(`UPDATE media_assets SET thumbnail = '/images/missing-thumb.jpg', thumbnail_revision = 5
  WHERE path = '/images/missing.png'`).run();
const numericBefore = stmt('SELECT * FROM media_assets ORDER BY id').all();
const messagesBefore = stmt('SELECT * FROM messages ORDER BY id').all();
const galleryBefore = stmt('SELECT * FROM gallery_items ORDER BY id').all();
const ownersBefore = stmt('SELECT * FROM media_owners ORDER BY owner_type, owner_id, slot').all();
const charactersBefore = stmt(
  'SELECT * FROM media_characters ORDER BY asset_id, character_id',
).all();
const runNumeric = (prefix = '', suffix = '') =>
  runMigration(prefix, suffix, 'migrateNumericMediaFileNames');
function checkNumericUnchanged() {
  assert.deepEqual(stmt('SELECT * FROM media_assets ORDER BY id').all(), numericBefore);
  assert.deepEqual(stmt('SELECT * FROM messages ORDER BY id').all(), messagesBefore);
  assert.deepEqual(stmt('SELECT * FROM gallery_items ORDER BY id').all(), galleryBefore);
  assert.deepEqual(
    stmt("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all(),
    triggers,
  );
  for (const asset of numericBefore) {
    if (asset.path !== '/images/missing.png') assert(existsSync(file(String(asset.path))));
  }
}
const first = numericBefore[0]!;
const conflictingPath = `/images/media-${first.id}.png`;
writeFileSync(file(conflictingPath), 'Unrelated numeric target');
const collision = runNumeric();
assert.equal(collision.status, 1);
assert.match(collision.stderr, /target belongs to another file/);
assert.equal(readFileSync(file(conflictingPath), 'utf8'), 'Unrelated numeric target');
checkNumericUnchanged();
unlinkSync(file(conflictingPath));

const numericCrash = runNumeric(`
  import fs from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  const sync = fs.fsyncSync;
  fs.fsyncSync = (...args) => { sync(...args); process.kill(process.pid, 'SIGKILL'); };
  syncBuiltinESMExports();
`);
assert.equal(numericCrash.signal, 'SIGKILL');
checkNumericUnchanged();
assert.equal(statSync(file(conflictingPath)).ino, statSync(file(String(first.path))).ino);
const interruptedFiles = readdirSync(IMAGES_DIR).sort();
const numericRollback = runNumeric('', "throw new Error('Injected numeric rollback');");
assert.equal(numericRollback.status, 1);
assert.match(numericRollback.stderr, /Injected numeric rollback/);
checkNumericUnchanged();
assert.deepEqual(
  readdirSync(IMAGES_DIR).sort(),
  interruptedFiles,
  'Interrupted hardlinks are reused',
);

stmt(`CREATE TRIGGER reject_numeric_migration BEFORE UPDATE OF path ON media_assets
  WHEN old.id = ${first.id} BEGIN SELECT RAISE(ABORT, 'Injected numeric update failure'); END`).run();
const numericUpdateFailure = runNumeric();
assert.equal(numericUpdateFailure.status, 1);
assert.match(numericUpdateFailure.stderr, /Injected numeric update failure/);
stmt('DROP TRIGGER reject_numeric_migration').run();
checkNumericUnchanged();

const numericSuccess = runNumeric();
assert.equal(numericSuccess.status, 0, numericSuccess.stderr);
const numericAfter = stmt('SELECT * FROM media_assets ORDER BY id').all();
const numericPaths = new Map<string, string>();
for (const [index, asset] of numericAfter.entries()) {
  const old = numericBefore[index]!;
  assert.equal(asset.id, old.id);
  numericPaths.set(String(old.path), String(asset.path));
  if (old.path === '/images/missing.png') {
    assert.equal(asset.path, old.path);
    assert.equal(asset.thumbnail, old.thumbnail);
    assert.equal(asset.thumbnail_revision, old.thumbnail_revision);
    continue;
  }
  assert.match(
    String(asset.path),
    new RegExp(`^/images/media-${asset.id}\\.(png|jpe?g|webp|webm)$`),
  );
  assert.equal(statSync(file(String(asset.path))).ino, statSync(file(String(old.path))).ino);
  if (old.thumbnail) {
    assert.equal(
      asset.thumbnail,
      `/images/thumb-${asset.id}-${Number(old.thumbnail_revision) + 1}.jpg`,
    );
    assert.equal(asset.thumbnail_revision, Number(old.thumbnail_revision) + 1);
    assert.equal(
      statSync(file(String(asset.thumbnail))).ino,
      statSync(file(String(old.thumbnail))).ino,
    );
    assert.equal(asset.thumbnail_size, old.thumbnail_size);
  }
}
assert.notEqual(
  numericAfter[0]!.thumbnail,
  numericAfter[1]!.thumbnail,
  'Shared derivatives get one stable identity per asset',
);
for (const old of messagesBefore) {
  const actual = stmt('SELECT * FROM messages WHERE id = ?').get(old.id!)!;
  assert.deepEqual(
    { ...actual },
    {
      ...old,
      images_json: JSON.stringify(
        (JSON.parse(String(old.images_json)) as string[]).map(
          (path) => numericPaths.get(path) ?? path,
        ),
      ),
    },
  );
}
for (const old of galleryBefore) {
  const actual = stmt('SELECT * FROM gallery_items WHERE id = ?').get(old.id!)!;
  assert.deepEqual(
    { ...actual },
    {
      ...old,
      image: numericPaths.get(String(old.image)) ?? old.image,
      source_image: numericPaths.get(String(old.source_image)) ?? old.source_image,
    },
  );
}
assert.deepEqual(
  stmt('SELECT * FROM media_owners ORDER BY owner_type, owner_id, slot').all(),
  ownersBefore,
);
assert.deepEqual(
  stmt('SELECT * FROM media_characters ORDER BY asset_id, character_id').all(),
  charactersBefore,
);
assert.deepEqual(stmt('SELECT * FROM media_recipes').all(), recipes);
assert.deepEqual(stmt('SELECT * FROM media_jobs').all(), jobs);
assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
assert.equal(stmt('PRAGMA integrity_check').get()!.integrity_check, 'ok');
const numericRepeat = runNumeric();
assert.equal(numericRepeat.status, 0, numericRepeat.stderr);
assert.deepEqual(stmt('SELECT * FROM media_assets ORDER BY id').all(), numericAfter);
assert.deepEqual(
  readdirSync(IMAGES_DIR).sort(),
  interruptedFiles,
  'Restart does not allocate new names',
);
sweepOrphanedImages();
for (const old of numericBefore) {
  assert(!existsSync(file(String(old.path))), 'Old original names are removed only after commit');
}
for (const asset of numericAfter) {
  if (asset.path !== '/images/missing.png') assert(existsSync(file(String(asset.path))));
  if (asset.thumbnail && asset.thumbnail !== '/images/missing-thumb.jpg')
    assert(existsSync(file(String(asset.thumbnail))));
}

// The normal database startup runs every registered migration before worker cleanup starts.

const startupPath = '/images/job-startup.png';
writeFileSync(file(startupPath), 'Startup bytes');
stmt(`INSERT INTO gallery_items(character_name, prompt, image, created_at, updated_at)
  VALUES ('Startup', '', ?, 10, 20)`).run(startupPath);
const startupId = stmt('SELECT id FROM media_assets WHERE path = ?').get(startupPath)!.id!;
db.exec('ALTER TABLE avatar_thumbnails DROP COLUMN thumbnail_revision');
db.exec('PRAGMA user_version = 61');
const startup = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `const { db } = await import(${JSON.stringify(dbUrl)}); db.close();`,
  ],
  { env: process.env, encoding: 'utf8' },
);
assert.equal(startup.status, 0, startup.stderr);
assert.equal(stmt('PRAGMA user_version').get()!.user_version, 65);
const startupAsset = stmt('SELECT path FROM media_assets WHERE id = ?').get(startupId)!;
assert.equal(startupAsset.path, `/images/media-${startupId}.png`);
assert.equal(readFileSync(file(String(startupAsset.path)), 'utf8'), 'Startup bytes');
assert.equal(
  stmt("SELECT image FROM gallery_items WHERE character_name = 'Startup'").get()!.image,
  startupAsset.path,
);
sweepOrphanedImages();
assert(
  !existsSync(file(startupPath)),
  'Startup sweep removes the old name after migration commits',
);
assert(existsSync(file(String(startupAsset.path))));
db.close();
console.log(
  'Media filenames migrate without copying bytes, changing ownership, or losing crash recovery.',
);
