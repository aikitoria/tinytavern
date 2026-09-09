#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { link, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

process.umask(0o077);
const sourcePath = resolve(
  process.env.DB_PATH ?? join(process.env.DATA_DIR ?? '/data', 'tinytavern.db'),
);
const requested = process.argv[2];
if (!requested) {
  console.error('Usage: bun server/src/db/backup.ts <destination.db>');
  process.exit(2);
}
const destination = resolve(requested);
if (sourcePath === destination) {
  console.error('Backup destination must differ from the live database');
  process.exit(2);
}
const directory = dirname(destination);
await mkdir(directory, { recursive: true, mode: 0o700 });
const temporary = await mkdtemp(join(directory, '.backup-'));
try {
  // VACUUM INTO takes a consistent online snapshot without modifying the source.
  // This separate process owns its read lock; application queries remain synchronous.
  const source = new Database(sourcePath, { readonly: true, strict: true });
  const snapshot = join(temporary, 'snapshot.db');
  try {
    source.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = EXTRA');
    source.prepare('VACUUM INTO ?').run(snapshot);
  } finally {
    source.close(true);
  }
  const file = await open(snapshot, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  // Publish only a complete snapshot. link is atomic and refuses every existing path.
  try {
    await link(snapshot, destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`Refusing to overwrite existing backup: ${destination}`);
    throw err;
  }
  const parent = await open(directory, 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(destination);
