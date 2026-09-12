import assert from 'node:assert/strict';
import { test } from 'bun:test';
import type { MediaVideoPreview } from '@tinytavern/shared';
import { createVideoPreviewFrames, type VideoPreviewSequence } from '../../client/src/media/videoPreviewFrames.ts';
import { createVideoPreviewPlayback } from '../../client/src/media/videoPreviewPlayback.ts';

function harness() {
  const bitmaps: { source: string; closed: number; close(): void }[] = [];
  type Bitmap = (typeof bitmaps)[number];
  const requests: {
    source: string;
    signal: AbortSignal;
    resolve: (bitmap: Bitmap) => void;
    reject: (error: Error) => void;
  }[] = [];
  const snapshots: VideoPreviewSequence<Bitmap>[] = [];
  const buffer = createVideoPreviewFrames<Bitmap>(
    (source, signal) => new Promise((resolve, reject) => requests.push({ source, signal, resolve, reject })),
    (sequence) => snapshots.push(sequence),
  );
  const update = (frames: MediaVideoPreview['frames'], sequence = 'step1', enabled = true) =>
    buffer.update({ id: 'sampler', sequence, nodeId: 'node', frameCount: 3, frameRate: 6, frames }, enabled);
  async function finish(index: number) {
    const request = requests[index]!;
    const bitmap = {
      source: request.source,
      closed: 0,
      close() {
        this.closed++;
      },
    };
    bitmaps.push(bitmap);
    request.resolve(bitmap);
    await Promise.resolve();
    return bitmap;
  }
  return { buffer, update, requests, snapshots, bitmaps, finish };
}

test('video previews wait for all sequence frames and decodes, retaining both sides of a fade', async () => {
  const h = harness();
  h.update({ 0: 'a' });
  const a = await h.finish(0);
  assert.equal(h.snapshots.length, 0, 'A fully decoded network fragment is not a complete sequence');
  h.update({ 0: 'a', 1: 'b', 2: 'a' });
  assert.deepEqual(
    h.requests.map((request) => request.source),
    ['a', 'b'],
  );
  const b = await h.finish(1);
  assert.deepEqual(
    h.snapshots[0]!.frames.map((frame) => frame.source),
    ['a', 'b', 'a'],
  );

  h.update({ 0: 'c', 1: 'd', 2: 'a' }, 'step2');
  assert.deepEqual(
    h.requests.map((request) => request.source),
    ['a', 'b', 'c', 'd'],
  );
  await h.finish(3);
  assert.equal(h.snapshots.length, 1, 'Every new decode must finish before the swap');
  await h.finish(2);
  assert.equal(h.snapshots.length, 2);
  assert.equal(b.closed, 0, 'The old sequence stays alive throughout the fade');
  h.snapshots[0]!.release();
  assert.equal(b.closed, 1);
  assert.equal(a.closed, 0, 'Shared frames remain alive in the replacement');
  h.update({ 0: 'c', 1: 'd', 2: 'a' }, 'step2');
  assert.equal(h.snapshots.length, 2, 'Repeated progress cannot restart the fade');
  h.snapshots[1]!.release();
  h.buffer.dispose();
  assert(h.bitmaps.every((bitmap) => bitmap.closed === 1));
});

test('superseded and hidden sequences cancel obsolete decoding without releasing playback frames', async () => {
  const h = harness();
  h.update({ 0: 'old', 1: 'kept', 2: 'kept' });
  h.update({ 0: 'new', 1: 'kept', 2: 'kept' }, 'step2');
  assert(h.requests[0]!.signal.aborted);
  assert.equal((await h.finish(0)).closed, 1);
  await h.finish(1);
  await h.finish(2);
  assert.equal(h.snapshots.length, 1);

  h.update({ 0: 'hidden', 1: 'hidden', 2: 'hidden' }, 'step3', false);
  assert.equal(h.requests.length, 3);
  h.update({ 0: 'hidden', 1: 'hidden', 2: 'hidden' }, 'step3');
  h.update({ 0: 'hidden', 1: 'hidden', 2: 'hidden' }, 'step3', false);
  assert(h.requests[3]!.signal.aborted);
  assert.equal((await h.finish(3)).closed, 1);
  assert(h.snapshots[0]!.frames.every((bitmap) => bitmap.closed === 0));
  h.update({ 0: 'late' }, 'step4');
  h.snapshots[0]!.release();
  h.buffer.dispose();
  assert(h.requests[4]!.signal.aborted);
  assert.equal((await h.finish(4)).closed, 1);
  assert.equal(h.snapshots.length, 1);
  assert(h.bitmaps.every((bitmap) => bitmap.closed === 1));
});

test('missing or malformed sequence frames preserve the previous complete loop', async () => {
  const h = harness();
  h.update({ 0: 'good', 1: 'good', 2: 'good' });
  await h.finish(0);
  h.update({ 0: 'bad', 1: 'good', 2: 'good' }, 'step2');
  h.requests[1]!.reject(new Error('Malformed JPEG'));
  await Promise.resolve();
  assert.equal(h.snapshots.length, 1);
  h.update({ 0: 'bad', 1: 'good', 2: 'good' }, 'step2');
  assert.equal(h.requests.length, 2, 'Failed JPEGs are not retried on every progress event');
  h.update({ 0: 'recovered', 1: 'good', 2: null }, 'step3');
  await h.finish(2);
  assert.equal(h.snapshots.length, 1, 'An evicted or dropped frame cannot produce a mixed loop');
  h.update({ 0: 'recovered', 1: 'good', 2: 'good' }, 'step3');
  assert.equal(h.snapshots.length, 2);
  for (const snapshot of h.snapshots) snapshot.release();
  h.buffer.dispose();
  assert(h.bitmaps.every((bitmap) => bitmap.closed === 1));
});

test('sequence crossfades preserve playback phase and animate both layers at the same index', () => {
  let now = 0;
  let finished!: () => void;
  let cancelled = 0;
  const draws: [number, string][] = [];
  const shows: [number, boolean][] = [];
  const releases: string[] = [];
  const sequence = (name: string): VideoPreviewSequence<string> => ({
    frames: Array.from({ length: 4 }, (_, index) => `${name}${index}`),
    frameRate: 10,
    release: () => releases.push(name),
  });
  const player = createVideoPreviewPlayback<string>({
    now: () => now,
    draw: (layer, frame) => {
      draws.push([layer, frame]);
    },
    show(layer, fade, done) {
      shows.push([layer, fade]);
      if (fade) {
        finished = done;
        return () => {
          cancelled++;
        };
      }
    },
  });
  player.setActive(true);
  player.present(sequence('a'));
  now = 250;
  player.tick(now);
  assert.deepEqual(draws.at(-1), [0, 'a2']);
  player.present(sequence('b'));
  assert.deepEqual(draws.slice(-2), [
    [0, 'a2'],
    [1, 'b2'],
  ]);
  assert.deepEqual(shows.at(-1), [1, true]);
  now = 300;
  player.tick(now);
  assert.deepEqual(
    draws.slice(-2),
    [
      [0, 'a3'],
      [1, 'b3'],
    ],
    'The swap must not restart the frame interval',
  );
  now = 400;
  player.tick(now);
  assert.deepEqual(
    draws.slice(-2),
    [
      [0, 'a0'],
      [1, 'b0'],
    ],
    'Both loops wrap together during the fade',
  );
  assert.deepEqual(releases, []);

  player.present(sequence('c'));
  player.present(sequence('d'));
  assert.deepEqual(releases, ['c'], 'Only the latest update waits for the active fade');
  now = 550;
  finished();
  assert.deepEqual(releases, ['c', 'a']);
  assert.deepEqual(draws.slice(-2), [
    [1, 'b1'],
    [0, 'd1'],
  ]);
  player.setActive(false);
  assert.equal(cancelled, 1);
  assert.deepEqual(releases, ['c', 'a', 'b']);
  now = 2000;
  player.setActive(true);
  player.tick(now);
  assert.deepEqual(draws.at(-1), [0, 'd1'], 'Hidden time does not skip through the loop');
  now = 2100;
  player.tick(now);
  assert.deepEqual(draws.at(-1), [0, 'd2']);
  player.dispose();
  assert.deepEqual(releases, ['c', 'a', 'b', 'd']);
});
