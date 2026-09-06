#!/usr/bin/env node
import { backup, DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

process.umask(0o077);
const DATA_DIR = process.env.DATA_DIR ?? '/data';
const sourcePath = process.env.DB_PATH ?? join(DATA_DIR, 'tinytavern.db');
const requested = process.argv[2];

if (!requested) {
  console.error('Usage: node server/src/backup.ts <destination.db>');
  process.exit(2);
}

const destination = resolve(requested);
if (resolve(sourcePath) === destination) {
  console.error('Backup destination must differ from the live database');
  process.exit(2);
}

try {
  await stat(destination);
  console.error(`Refusing to overwrite existing backup: ${destination}`);
  process.exit(2);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
const source = new DatabaseSync(sourcePath, { readOnly: true });
try {
  await backup(source, destination);
  await chmod(destination, 0o600);
} catch (err) {
  await unlink(destination).catch((cleanupErr: NodeJS.ErrnoException) => {
    if (cleanupErr.code !== 'ENOENT') {
      console.error(`Could not remove partial backup: ${cleanupErr.message}`);
    }
  });
  throw err;
} finally {
  source.close();
}

console.log(destination);
