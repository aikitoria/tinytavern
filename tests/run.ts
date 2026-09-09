import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

if (process.argv.length > 2) throw new Error('The test suite always runs every test; no filters.');
const started = performance.now();
const root = mkdtempSync(join(tmpdir(), 'tinytavern-tests-'));
const seed = join(root, 'seed');
mkdirSync(seed);
const environment = (data: string) => ({
  ...process.env,
  MEDIA_SIGNING_KEY_FILE: '',
  CADDY_PROXY_KEY_FILE: '',
  SESSION_COOKIE_NAME: 'tinytavern_session',
  TINYTAVERN_IP_ALLOWLIST: '',
  E2E_BASE: '',
  E2E_MOCK: '',
  DATA_DIR: data,
  DB_PATH: join(data, 'tinytavern.db'),
  TINYTAVERN_TEST_DATA_DIR: data,
});
const children = new Set<ReturnType<typeof spawn>>();
let failed = false;
let interrupted = false;
let count = 0;
const suites = readdirSync(import.meta.dirname, { recursive: true, encoding: 'utf8' })
  .filter((name) => name.endsWith('.test.ts'))
  .sort();
if (!suites.length) throw new Error('No test suites found');

async function execute(file: string): Promise<void> {
  const data = join(root, file.replaceAll('/', '-'));
  mkdirSync(data);
  // The seed is closed and immutable. Copying it is not another schema initialization.
  copyFileSync(join(seed, 'tinytavern.db'), join(data, 'tinytavern.db'));
  const before = performance.now();
  const child = spawn(
    process.execPath,
    [
      ...(file.startsWith('client/') ? ['--conditions=browser'] : []),
      '--test',
      '--test-isolation=none',
      '--test-reporter=tap',
      '--test-force-exit',
      join(import.meta.dirname, file),
    ],
    { env: environment(data), stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 },
  );
  children.add(child);
  let output = '';
  child.stdout!.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr!.on('data', (chunk) => {
    output += String(chunk);
  });
  await new Promise<void>((resolve) => {
    child.once('error', (error) => {
      output += String(error);
    });
    child.once('close', (code, signal) => {
      children.delete(child);
      const seconds = ((performance.now() - before) / 1000).toFixed(2);
      console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${file} (${seconds}s)`);
      if (code !== 0) {
        failed = true;
        console.error(output.trim(), signal ? `\nTerminated: ${signal}` : '');
      }
      count += Number(output.match(/# tests (\d+)/)?.[1] ?? 0);
      resolve();
    });
  });
}

const stop = () => {
  interrupted = true;
  failed = true;
  for (const child of children) child.kill('SIGTERM');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  // Initialize SQLite once for the entire run, before any test worker can import server code.
  Object.assign(process.env, environment(seed));
  const { db } = await import('../server/src/db.ts');
  db.close();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, availableParallelism(), suites.length) }, async () => {
      while (!interrupted && next < suites.length) await execute(suites[next++]!);
    }),
  );
  console.log(
    `\n${failed ? 'FAILED' : 'PASSED'}: ${suites.length} suites, ${count} cases in ${((performance.now() - started) / 1000).toFixed(2)}s. Schema initialized once.`,
  );
  process.exitCode = failed ? 1 : 0;
} finally {
  stop();
  rmSync(root, { recursive: true, force: true });
}
