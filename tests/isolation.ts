import { dirname } from 'node:path';

/** Call before dynamically importing any server module that may open SQLite. */
export function requireTestIsolation(): void {
  const { DATA_DIR, DB_PATH, MINITAVERN_TEST_DATA_DIR } = process.env;
  if (
    !DATA_DIR ||
    MINITAVERN_TEST_DATA_DIR !== DATA_DIR ||
    !DB_PATH ||
    dirname(DB_PATH) !== DATA_DIR
  ) {
    throw new Error(
      'Run standalone regressions through npm test; it creates an isolated database for each script.',
    );
  }
}
