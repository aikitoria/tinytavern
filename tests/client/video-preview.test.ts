import assert from 'node:assert/strict';
import { test } from 'bun:test';
import type { MediaVideoPreview } from '@tinytavern/shared';
import { createVideoPreviewFrames } from '../../client/src/media/videoPreviewFrames.ts';

function harness() {
  const bitmaps: { source: string; closed: number; close(): void }[] = [];
  type Bitmap = (typeof bitmaps)[number];
  const requests: {
    source: string;
    signal: AbortSignal;
    resolve: (bitmap: Bitmap) => void;
    reject: (error: Error) => void;
  }[] = [];
  const snapshots: string[][] = [];
  const buffer = createVideoPreviewFrames<Bitmap>(
    (source, signal) =>
      new Promise((resolve, reject) => requests.push({ source, signal, resolve, reject })),
    (frames) => snapshots.push(frames.map((frame) => `${frame.index}:${frame.bitmap.source}`)),
  );
  const update = (frames: MediaVideoPreview['frames'], enabled = true, id = 'sampler') =>
    buffer.update({ id, nodeId: 'node', frameCount: 3, frameRate: 6, frames }, enabled);
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

test('video previews eagerly decode every changed frame and swap complete available snapshots', async () => {
  const h = harness();
  h.update({ 0: 'a', 1: 'b', 2: 'a' });
  assert.deepEqual(
    h.requests.map((request) => request.source),
    ['a', 'b'],
    'All frames start before any decode finishes; identical JPEGs share a decode',
  );
  const a = await h.finish(0);
  assert.deepEqual(h.snapshots.at(-1), [], 'Partial decode is not exposed to playback');
  const b = await h.finish(1);
  assert.deepEqual(h.snapshots.at(-1), ['0:a', '1:b', '2:a']);

  h.update({ 0: 'c', 1: 'd', 2: 'a' });
  assert.deepEqual(
    h.requests.map((request) => request.source),
    ['a', 'b', 'c', 'd'],
  );
  await h.finish(3);
  assert.deepEqual(
    h.snapshots.at(-1),
    ['0:a', '1:b', '2:a'],
    'The old snapshot remains playable while new frames decode',
  );
  assert.equal(b.closed, 0);
  await h.finish(2);
  assert.deepEqual(h.snapshots.at(-1), ['0:c', '1:d', '2:a']);
  assert.equal(b.closed, 1);
  assert.equal(a.closed, 0, 'A frame reused in the new snapshot remains alive');
  h.update({ 0: 'c', 1: 'd', 2: null });
  assert.equal(a.closed, 1);
  assert.deepEqual(h.snapshots.at(-1), ['0:c', '1:d']);
  h.buffer.dispose();
  assert(h.bitmaps.every((bitmap) => bitmap.closed === 1));
});

test('superseded, hidden and disposed video previews cannot publish late decoded frames', async () => {
  const h = harness();
  h.update({ 0: 'old', 1: 'kept' });
  h.update({ 0: 'new', 1: 'kept' });
  assert(h.requests[0]!.signal.aborted);
  assert.equal((await h.finish(0)).closed, 1);
  await h.finish(1);
  await h.finish(2);
  assert.deepEqual(h.snapshots.at(-1), ['0:new', '1:kept']);

  h.update({ 0: 'hidden' }, false);
  assert.equal(h.requests.length, 3, 'Hidden views do not decode new frames');
  h.update({ 0: 'hidden' });
  h.update({ 0: 'hidden' }, false);
  assert(h.requests[3]!.signal.aborted);
  assert.equal((await h.finish(3)).closed, 1);
  assert.deepEqual(h.snapshots.at(-1), ['0:new', '1:kept']);

  h.update({ 0: 'same' }, true, 'next-sampler');
  assert.deepEqual(h.snapshots.at(-1), []);
  h.update({ 0: 'same' }, true, 'another-sampler');
  assert(h.requests[4]!.signal.aborted);
  assert.equal((await h.finish(4)).closed, 1, 'Even the same source from a replaced clip is stale');
  await h.finish(5);
  assert.deepEqual(h.snapshots.at(-1), ['0:same']);
  h.update({ 0: 'late' });
  const count = h.snapshots.length;
  h.buffer.dispose();
  assert(h.requests[6]!.signal.aborted);
  assert.equal((await h.finish(6)).closed, 1);
  assert.equal(h.snapshots.length, count);
  assert(h.bitmaps.every((bitmap) => bitmap.closed === 1));
});

test('bad video frames do not block usable previews or retry in a loop', async () => {
  const h = harness();
  h.update({ 0: 'bad', 1: 'good' });
  h.requests[0]!.reject(new Error('Malformed JPEG'));
  await h.finish(1);
  assert.deepEqual(h.snapshots.at(-1), ['1:good']);
  h.update({ 0: 'bad', 1: 'good' });
  assert.equal(h.requests.length, 2);
  h.update({ 0: 'also-bad' });
  h.requests[2]!.reject(new Error('Malformed JPEG'));
  await Promise.resolve();
  assert.deepEqual(h.snapshots.at(-1), ['1:good'], 'A failed replacement keeps the usable preview');
  h.update({ 0: 'recovered' });
  await h.finish(3);
  assert.deepEqual(h.snapshots.at(-1), ['0:recovered']);
  h.buffer.dispose();
  assert(h.bitmaps.every((bitmap) => bitmap.closed === 1));
});
