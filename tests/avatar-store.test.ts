import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { AVATAR_DIR, stmt } = await import('../server/src/db.ts');
const { saveAvatar, copyAvatarFiles, readAvatarFile } =
  await import('../server/src/routes/avatarStore.ts');
const { makePlaceholderPng } = await import('../server/src/pngCard.ts');
const id = Number(
  stmt("INSERT INTO characters(name, created_at) VALUES ('Numeric avatar', 1)").run()
    .lastInsertRowid,
);
const copyId = Number(
  stmt("INSERT INTO characters(name, created_at) VALUES ('Copied avatar', 1)").run()
    .lastInsertRowid,
);
const png = makePlaceholderPng();
const now = Date.now;
const timestamp = 4_000_000_000_000;
const stale = join(AVATAR_DIR, `.character-${id}.png.${timestamp}.tmp`);
writeFileSync(stale, 'Uncommitted prior attempt');
let saved: string;
try {
  Date.now = () => timestamp;
  saved = saveAvatar('character', id, png);
  assert.equal(saved, `/avatars/character-${id}.png?v=${timestamp + 1}`);
  assert.equal(readFileSync(stale, 'utf8'), 'Uncommitted prior attempt');
  unlinkSync(stale);
  stmt('UPDATE characters SET avatar = ? WHERE id = ?').run(saved, id);
  const again = saveAvatar('character', id, png);
  assert.equal(again, `/avatars/character-${id}.png?v=${timestamp + 2}`);
  stmt('UPDATE characters SET avatar = ? WHERE id = ?').run(again, id);
  const copied = copyAvatarFiles('character', id, copyId);
  assert.equal(copied, `/avatars/character-${copyId}.png?v=${timestamp + 3}`);
  assert.deepEqual(readAvatarFile('character', copyId), png);
} finally {
  Date.now = now;
}

// A restarted process recovers the persisted version even when its clock is behind it.
const dbUrl = new URL('../server/src/db.ts', import.meta.url).href;
const storeUrl = new URL('../server/src/routes/avatarStore.ts', import.meta.url).href;
const restarted = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `const { stmt, db } = await import(${JSON.stringify(dbUrl)});
    const { saveAvatar, readAvatarFile } = await import(${JSON.stringify(storeUrl)});
    Date.now = () => 1000;
    const avatar = saveAvatar('character', ${id}, readAvatarFile('character', ${id}));
    stmt('UPDATE characters SET avatar = ? WHERE id = ?').run(avatar, ${id});
    process.stdout.write(avatar);
    db.close();`,
  ],
  { env: process.env, encoding: 'utf8' },
);
assert.equal(restarted.status, 0, restarted.stderr);
assert.equal(restarted.stdout, `/avatars/character-${id}.png?v=${timestamp + 3}`);
assert.deepEqual(readAvatarFile('character', id), png);
assert.deepEqual(
  readdirSync(AVATAR_DIR).sort(),
  [`character-${id}.png`, `character-${copyId}.png`].sort(),
);
console.log(
  'Avatar writes and copies use numeric versions across collisions, repeated saves and restarts.',
);
