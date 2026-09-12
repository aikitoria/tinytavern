import assert from 'node:assert/strict';
import { test } from 'bun:test';
import type { MediaJob, ServerEvent } from '@tinytavern/shared';
import { mockFetch } from '../support/streams.ts';

test('ordered media snapshots preserve early progress and reject stale history after reconnect', async () => {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {} }),
  });
  const modulePath = '../../client/src/state/store.ts';
  const { state, handleServerEvent, refreshMediaJobs, applyMediaJob, mediaJobsByMessage, mediaJobWasDeleted } =
    (await import(modulePath)) as {
      state: { mediaJobs: Record<number, MediaJob> };
      handleServerEvent(event: ServerEvent): void;
      refreshMediaJobs(): Promise<void>;
      applyMediaJob(job: MediaJob): void;
      mediaJobsByMessage(): Map<number, MediaJob>;
      mediaJobWasDeleted(id: number): boolean;
    };
  const job = (id: number) =>
    ({
      id,
      revision: 1,
      createdAt: id,
      messageId: id + 100,
      state: 'rendering',
      assets: [],
      outputs: [],
      prompt: '',
    }) as unknown as MediaJob;
  let resolve!: (response: Response) => void;
  const originalFetch = globalThis.fetch;
  mockFetch(
    async () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const history = (jobs: MediaJob[]) => resolve(Response.json(jobs));
  try {
    const initial = refreshMediaJobs();
    handleServerEvent({ t: 'mediaJobs', jobs: [job(1)] });
    handleServerEvent({
      t: 'mediaJobProgress',
      id: 1,
      progress: { value: 2, max: 4, preview: 'frame' },
    });
    assert.equal(mediaJobsByMessage().get(101)?.progress?.preview, 'frame');
    history([job(1)]);
    await initial;
    assert.equal(state.mediaJobs[1]?.progress?.value, 2, 'History cannot overwrite early WS progress');

    const reconnect = refreshMediaJobs();
    handleServerEvent({ t: 'mediaJobs', jobs: [] });
    history([job(1), job(2)]);
    await reconnect;
    assert.deepEqual(Object.keys(state.mediaJobs), [], 'Reconnect removes stale and previously unknown active jobs');
    assert.equal(
      mediaJobWasDeleted(1),
      false,
      'An active snapshot cannot make an open editor abandon a possibly completed job',
    );

    const refreshed = refreshMediaJobs();
    handleServerEvent({ t: 'mediaJob', job: job(3) });
    handleServerEvent({ t: 'mediaJobDeleted', id: 3 });
    history([job(3)]);
    await refreshed;
    applyMediaJob(job(3));
    assert.equal(mediaJobWasDeleted(3), true, 'Confirmed deletion lets the editor change jobs');
    assert.equal(state.mediaJobs[3], undefined, 'Deletion rejects late history and action responses');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
