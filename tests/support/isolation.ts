import { dirname } from 'node:path';

/** Call before dynamically importing any server module that may open SQLite. */
export function requireTestIsolation(): void {
  const { DATA_DIR, DB_PATH, TINYTAVERN_TEST_DATA_DIR } = process.env;
  if (!DATA_DIR || TINYTAVERN_TEST_DATA_DIR !== DATA_DIR || !DB_PATH || dirname(DB_PATH) !== DATA_DIR) {
    throw new Error('Run scripts/run-isolated-tests.sh; test data must be created by the runner.');
  }
}
