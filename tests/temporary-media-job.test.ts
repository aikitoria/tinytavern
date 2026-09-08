import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MediaJobState } from '@tinytavern/shared';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { stmt, IMAGES_DIR, mediaAssetForPath } = await import('../server/src/db.ts');
const { saveImage } = await import('../server/src/images.ts');
const { makePlaceholderPng } = await import('../server/src/pngCard.ts');
const { consumeTemporaryMediaJob } = await import('../server/src/temporaryMediaJob.ts');
const { requireMediaJob, mediaJobRow, hasMediaJobObservers } =
  await import('../server/src/mediaJobStore.ts');
const { stopMediaWorker } = await import('../server/src/mediaWorker.ts');
const { deleteMediaJob } = await import('../server/src/mediaJobs.ts');
stopMediaWorker(); // Exercise consumption and cancellation without starting remote work.

const files = new Map<string, string>();
function job(id: string, state: MediaJobState = 'succeeded') {
  const path = saveImage('.png', makePlaceholderPng());
  files.set(id, join(IMAGES_DIR, basename(path)));
  const asset = mediaAssetForPath(path)!;
  stmt(`INSERT INTO media_jobs (id, operation, state, configuration_json, outputs_json,
    created_at, updated_at) VALUES (?, 'image', ?, '{"temporary":true}', ?, 1, 1)`).run(
    id,
    state,
    JSON.stringify([asset.id]),
  );
  stmt("INSERT INTO media_owners VALUES (?, 'job', ?, 'output:1')").run(asset.id, id);
  return requireMediaJob(id);
}

const completed = job('consumed');
let finishRead!: () => void;
const read = new Promise<void>((resolve) => {
  finishRead = resolve;
});
const result = consumeTemporaryMediaJob(completed, {}, async () => {
  await read;
  assert(existsSync(files.get('consumed')!), 'Ownership lasts through the read');
  return 'bytes';
});
await Promise.resolve();
assert(hasMediaJobObservers(completed.id), 'Worker cleanup must wait for asynchronous consumption');
finishRead();
assert.equal(await result, 'bytes');
assert(!mediaJobRow(completed.id));
assert(!existsSync(files.get('consumed')!));
assert(!hasMediaJobObservers(completed.id));

await assert.rejects(
  consumeTemporaryMediaJob(job('read-failure'), {}, () => {
    throw new Error('Read failed');
  }),
  /Read failed/,
);
assert(!existsSync(files.get('read-failure')!));

const abort = new AbortController();
abort.abort(new Error('Already cancelled'));
await assert.rejects(
  consumeTemporaryMediaJob(
    job('pre-abort', 'preparing'),
    {
      signal: abort.signal,
    },
    () => assert.fail('An aborted job must not be consumed'),
  ),
  /Already cancelled/,
);
assert(!mediaJobRow('pre-abort'), 'Prompt cancellation releases its result immediately');

const runningAbort = new AbortController();
await assert.rejects(
  consumeTemporaryMediaJob(
    job('running', 'rendering'),
    {
      signal: runningAbort.signal,
      onProgress: () => runningAbort.abort(new Error('Disconnected')),
    },
    () => assert.fail('An aborted job must not be consumed'),
  ),
  /Disconnected/,
);
assert.equal(requireMediaJob('running').state, 'cancelling');
assert(existsSync(files.get('running')!), 'Remote execution retains ownership until stopped');
assert(
  !hasMediaJobObservers('running'),
  'The worker can reclaim the cancelled job after stopping it',
);
stmt("UPDATE media_jobs SET state = 'cancelled' WHERE id = 'running'").run();
deleteMediaJob(requireMediaJob('running'));
assert(!existsSync(files.get('running')!));

const failed = job('failed', 'failed');
await assert.rejects(
  consumeTemporaryMediaJob(failed, {}, () => assert.fail()),
  /cancelled/,
);
assert(!mediaJobRow('failed'));
assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
console.log(
  'Temporary media consumption retains ownership through reads and releases on failure or cancellation',
);
