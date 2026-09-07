import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const moduleUrl = new URL('../server/src/db.ts', import.meta.url).href;
const path = process.env.DB_PATH!;
function child(code: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: process.env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}
// Simulate the previous application leaving committed, uncheckpointed WAL data.
child(`
  const { db, stmt } = await import(${JSON.stringify(moduleUrl)});
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  db.exec('CREATE TABLE journal_regression (value TEXT)');
  stmt('INSERT INTO journal_regression VALUES (?)').run('committed in WAL');
  process.exit(0);
`);
assert(existsSync(`${path}-wal`));
assert(statSync(`${path}-wal`).size > 0);
child(`
  import assert from 'node:assert/strict';
  import { statSync, existsSync } from 'node:fs';
  const { db, stmt } = await import(${JSON.stringify(moduleUrl)});
  assert.equal(stmt('PRAGMA journal_mode').get().journal_mode, 'delete');
  assert.equal(stmt('PRAGMA synchronous').get().synchronous, 3);
  assert.equal(stmt('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(stmt('SELECT value FROM journal_regression').get().value, 'committed in WAL');
  db.exec('BEGIN');
  stmt('INSERT INTO journal_regression VALUES (?)').run('rolled back');
  assert.equal(statSync(process.env.DB_PATH + '-journal').mode & 0o777, 0o600);
  db.exec('ROLLBACK');
  assert.equal(stmt('SELECT COUNT(*) AS n FROM journal_regression').get().n, 1);
  db.close();
`);
assert(!existsSync(`${path}-wal`));
assert(!existsSync(`${path}-shm`));
assert(!existsSync(`${path}-journal`));
console.log('SQLite WAL conversion preserves committed data and uses private rollback journals');
