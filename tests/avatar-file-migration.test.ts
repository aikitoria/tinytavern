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
const { AVATAR_DIR, stmt, db } = await import('../server/src/db.ts');
const characterId = Number(
  stmt("INSERT INTO characters(name, created_at) VALUES ('Legacy avatar', 1)").run()
    .lastInsertRowid,
);
const personaId = Number(
  stmt("INSERT INTO personas(name, created_at) VALUES ('Current avatar', 1)").run().lastInsertRowid,
);
const original = `/avatars/character-${characterId}.png`;
const oldSource = `${original}?v=11111111-1111-4111-8111-111111111111`;
const staleSource = `${original}?v=1`;
const personaSource = `/avatars/persona-${personaId}.webp?v=42`;
const oldThumbnail = '/avatars/avatar-thumb-22222222-2222-4222-8222-222222222222.jpg';
const personaThumbnail = `/avatars/avatar-thumb-persona-${personaId}-42-4.jpg`;
for (const path of [original, oldThumbnail, personaThumbnail]) {
  writeFileSync(join(AVATAR_DIR, basename(path)), `Bytes for ${path}`);
}
stmt('UPDATE characters SET avatar = ? WHERE id = ?').run(oldSource, characterId);
stmt('UPDATE personas SET avatar = ? WHERE id = ?').run(personaSource, personaId);
stmt(`INSERT INTO avatar_thumbnails(source, thumbnail, thumbnail_size, thumbnail_revision)
  VALUES (?, ?, 128, 0), (?, NULL, NULL, 0), (?, ?, 128, 4)`).run(
  oldSource,
  oldThumbnail,
  staleSource,
  personaSource,
  personaThumbnail,
);
const before = stmt('SELECT * FROM avatar_thumbnails ORDER BY source').all();
const dbUrl = new URL('../server/src/db.ts', import.meta.url).href;
const migrationUrl = new URL('../server/src/avatarFileMigration.ts', import.meta.url).href;
function migrate(prefix = '', suffix = '') {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `${prefix}
    const { stmt, transaction, AVATAR_DIR, db } = await import(${JSON.stringify(dbUrl)});
    const { migrateAvatarFileNames } = await import(${JSON.stringify(migrationUrl)});
    transaction(() => { migrateAvatarFileNames(AVATAR_DIR, stmt); ${suffix} });
    db.close();`,
    ],
    { env: process.env, encoding: 'utf8' },
  );
}
const crashed = migrate(`import fs from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  const sync = fs.fsyncSync;
  fs.fsyncSync = (...args) => { sync(...args); process.kill(process.pid, 'SIGKILL'); };
  syncBuiltinESMExports();`);
assert.equal(crashed.signal, 'SIGKILL');
assert.deepEqual(stmt('SELECT * FROM avatar_thumbnails ORDER BY source').all(), before);
assert.equal(
  stmt('SELECT avatar FROM characters WHERE id = ?').get(characterId)!.avatar,
  oldSource,
);
const rollback = migrate('', "throw new Error('Avatar migration rollback');");
assert.equal(rollback.status, 1);
assert.match(rollback.stderr, /Avatar migration rollback/);
assert.deepEqual(stmt('SELECT * FROM avatar_thumbnails ORDER BY source').all(), before);
const migrated = migrate();
assert.equal(migrated.status, 0, migrated.stderr);
const source = `${original}?v=2`;
const thumbnail = `/avatars/avatar-thumb-character-${characterId}-2-1.jpg`;
assert.equal(stmt('SELECT avatar FROM characters WHERE id = ?').get(characterId)!.avatar, source);
assert.deepEqual(
  { ...stmt('SELECT * FROM avatar_thumbnails WHERE source = ?').get(source)! },
  { source, thumbnail, thumbnail_size: 128, thumbnail_retry_at: 0, thumbnail_revision: 1 },
);
assert.equal(
  stmt('SELECT avatar FROM personas WHERE id = ?').get(personaId)!.avatar,
  personaSource,
);
assert.equal(
  stmt('SELECT thumbnail FROM avatar_thumbnails WHERE source = ?').get(personaSource)!.thumbnail,
  personaThumbnail,
);
assert.equal(readFileSync(join(AVATAR_DIR, basename(original)), 'utf8'), `Bytes for ${original}`);
assert.equal(
  readFileSync(join(AVATAR_DIR, basename(thumbnail)), 'utf8'),
  `Bytes for ${oldThumbnail}`,
);
assert.equal(
  statSync(join(AVATAR_DIR, basename(thumbnail))).ino,
  statSync(join(AVATAR_DIR, basename(oldThumbnail))).ino,
);
assert(
  existsSync(join(AVATAR_DIR, basename(oldThumbnail))),
  'Old names survive until startup orphan cleanup',
);
const files = readdirSync(AVATAR_DIR).sort();
const repeated = migrate();
assert.equal(repeated.status, 0, repeated.stderr);
assert.deepEqual(readdirSync(AVATAR_DIR).sort(), files);
assert.equal(stmt('PRAGMA integrity_check').get()!.integrity_check, 'ok');
console.log(
  'Avatar startup migration preserves originals and source associations through crashes and retries.',
);

// Exercise the actual 64→65 startup, including collision refusal and interrupted linking.
const numericRows = stmt('SELECT * FROM avatar_thumbnails ORDER BY source').all();
const shortThumbnail = thumbnail.replace('/avatar-thumb-', '/thumb-');
const shortPersonaThumbnail = personaThumbnail.replace('/avatar-thumb-', '/thumb-');
const targetFile = join(AVATAR_DIR, basename(shortThumbnail));
db.exec('PRAGMA user_version = 64');
function startup(prefix = '') {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `${prefix}
const { db } = await import(${JSON.stringify(dbUrl)}); db.close();`,
    ],
    { env: process.env, encoding: 'utf8' },
  );
}
writeFileSync(targetFile, 'Unrelated file');
const collision = startup();
assert.equal(collision.status, 1);
assert.match(collision.stderr, /target belongs to another file/);
assert.equal(readFileSync(targetFile, 'utf8'), 'Unrelated file');
assert.deepEqual(stmt('SELECT * FROM avatar_thumbnails ORDER BY source').all(), numericRows);
assert.equal(stmt('PRAGMA user_version').get()!.user_version, 64);
unlinkSync(targetFile);
const prefixCrash = startup(`import fs from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  const sync = fs.fsyncSync;
  fs.fsyncSync = (...args) => { sync(...args); process.kill(process.pid, 'SIGKILL'); };
  syncBuiltinESMExports();`);
assert.equal(prefixCrash.signal, 'SIGKILL');
assert.deepEqual(stmt('SELECT * FROM avatar_thumbnails ORDER BY source').all(), numericRows);
assert.equal(stmt('PRAGMA user_version').get()!.user_version, 64);
const prefixMigrated = startup();
assert.equal(prefixMigrated.status, 0, prefixMigrated.stderr);
assert.equal(stmt('PRAGMA user_version').get()!.user_version, 65);
assert.deepEqual(
  stmt('SELECT * FROM avatar_thumbnails ORDER BY source')
    .all()
    .map((row) => ({ ...row })),
  numericRows.map((row) => ({
    ...row,
    thumbnail:
      typeof row.thumbnail === 'string'
        ? row.thumbnail.replace('/avatar-thumb-', '/thumb-')
        : row.thumbnail,
  })),
);
for (const [oldPath, newPath] of [
  [thumbnail, shortThumbnail],
  [personaThumbnail, shortPersonaThumbnail],
]) {
  assert.equal(
    statSync(join(AVATAR_DIR, basename(oldPath!))).ino,
    statSync(join(AVATAR_DIR, basename(newPath!))).ino,
  );
  assert.deepEqual(
    readFileSync(join(AVATAR_DIR, basename(oldPath!))),
    readFileSync(join(AVATAR_DIR, basename(newPath!))),
  );
}
const prefixFiles = readdirSync(AVATAR_DIR).sort();
const prefixRepeated = startup();
assert.equal(prefixRepeated.status, 0, prefixRepeated.stderr);
assert.deepEqual(readdirSync(AVATAR_DIR).sort(), prefixFiles);
const orphan = join(AVATAR_DIR, 'thumb-character-99999-1-1.jpg');
writeFileSync(orphan, 'Abandoned link');
const { initMediaThumbnails, stopMediaThumbnails } =
  await import('../server/src/mediaThumbnails.ts');
initMediaThumbnails();
stopMediaThumbnails();
assert(!existsSync(orphan));
assert(!readdirSync(AVATAR_DIR).some((file) => file.startsWith('avatar-thumb-')));
assert(existsSync(targetFile));
assert(existsSync(join(AVATAR_DIR, basename(shortPersonaThumbnail))));
console.log(
  'Avatar thumbnail prefix migration preserves bytes and revisions, survives collisions/crashes, and sweeps old names.',
);
