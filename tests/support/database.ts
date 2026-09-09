import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'bun:test';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { db, stmt, transaction, invalidateMediaAsset, DATA_DIR } =
  await import('../../server/src/db.ts');
const tables = stmt('PRAGMA table_list')
  .all()
  .filter((row) => row.schema === 'main' && row.type === 'table' && row.name !== 'sqlite_schema')
  .map((row) => String(row.name));
const seeds = tables
  .filter((table) => table !== 'sqlite_sequence')
  .map((table) => ({ table, rows: stmt(`SELECT * FROM "${table}"`).all() }));
const sequences = stmt('SELECT * FROM sqlite_sequence').all();
let used = false;

/** Reuse this suite's schema/connection; only fixture rows and files are reset between cases. */
function reset(): void {
  assert.equal(db.inTransaction, false, 'A case must finish its transactions');
  for (const row of stmt('SELECT path FROM media_assets').all())
    invalidateMediaAsset(String(row.path));
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(() => {
      for (const table of tables) stmt(`DELETE FROM "${table}"`).run();
      for (const { table, rows } of seeds) {
        for (const row of rows) {
          const columns = Object.keys(row);
          stmt(
            `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          ).run(...Object.values(row));
        }
      }
      stmt('DELETE FROM sqlite_sequence').run();
      for (const row of sequences)
        stmt('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)').run(row.name!, row.seq!);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  for (const entry of readdirSync(DATA_DIR)) {
    if (entry !== 'tinytavern.db') rmSync(join(DATA_DIR, entry), { recursive: true, force: true });
  }
  mkdirSync(join(DATA_DIR, 'images'));
  mkdirSync(join(DATA_DIR, 'avatars'));
}

export function databaseCase(name: string, run: () => Promise<void>): void {
  test(name, async () => {
    if (used) reset();
    used = true;
    await run();
    assert.equal(db.inTransaction, false, 'A case must finish its transactions');
  });
}
