// Each child starts with isolated paths, before any test dependency can open SQLite.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const filters = process.argv.slice(2);
const tests = readdirSync(import.meta.dirname)
  .filter((name) => name.endsWith('.test.ts'))
  .filter(
    (name) =>
      filters.length === 0 ||
      filters.some((filter) => name === `${filter}.test.ts` || name === filter),
  )
  .sort();
if (tests.length === 0) throw new Error(`No standalone tests match: ${filters.join(', ')}`);
const root = mkdtempSync(join(tmpdir(), 'minitavern-tests-'));
try {
  for (const test of tests) {
    console.log(`\n== ${test} ==`);
    const dataDir = join(root, test.slice(0, -3));
    mkdirSync(dataDir);
    const result = spawnSync(process.execPath, [join(import.meta.dirname, test)], {
      stdio: 'inherit',
      env: {
        ...process.env,
        MEDIA_SIGNING_KEY_FILE: '',
        CADDY_PROXY_KEY_FILE: '',
        SESSION_COOKIE_NAME: 'minitavern_session',
        DATA_DIR: dataDir,
        DB_PATH: join(dataDir, 'minitavern.db'),
        MINITAVERN_TEST_DATA_DIR: dataDir,
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
