import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'tinytavern-isolation-check-'));
try {
  const inheritedData = join(root, 'inherited-data');
  const inheritedDb = join(root, 'inherited-db', 'tinytavern.db');
  const tests = [
    'chat-prompt',
    'draft-completion',
    'conversation-transfer',
    'image-recency',
    'media-url',
  ];
  for (const test of tests) {
    for (const marker of ['', inheritedData]) {
      const result = spawnSync(process.execPath, [join(import.meta.dirname, `${test}.test.ts`)], {
        encoding: 'utf8',
        env: {
          ...process.env,
          DATA_DIR: inheritedData,
          DB_PATH: inheritedDb,
          TINYTAVERN_TEST_DATA_DIR: marker,
        },
      });
      assert.equal(result.status, 1, `${test} rejects a missing marker or external DB_PATH`);
      assert.match(result.stderr, /Run standalone regressions through npm test/);
      assert.equal(
        existsSync(inheritedData),
        false,
        `${test} never initializes inherited DATA_DIR`,
      );
      assert.equal(existsSync(inheritedDb), false, `${test} never opens inherited DB_PATH`);
    }
  }
  const launched = spawnSync(
    process.execPath,
    [join(import.meta.dirname, 'run.ts'), 'client-sync'],
    {
      encoding: 'utf8',
      env: { ...process.env, DATA_DIR: inheritedData, DB_PATH: inheritedDb },
    },
  );
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /client-sync.test.ts/);
  assert.equal(existsSync(inheritedData), false, 'launcher replaces inherited DATA_DIR');
  assert.equal(existsSync(inheritedDb), false, 'launcher replaces inherited DB_PATH');
  console.log('Standalone test isolation checks passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
