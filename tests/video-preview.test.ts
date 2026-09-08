import assert from 'node:assert/strict';
import { mergeMediaProgress, type MediaProgress } from '@tinytavern/shared';
import { ComfyVideoPreview, parseVideoPreviewFrame } from '../server/src/comfyVideoPreview.ts';
import { parsePreviewFrame } from '../server/src/comfyPreview.ts';
import { previewJpeg, videoPreviewFrame } from './helpers/videoPreview.ts';

const packet = videoPreviewFrame(2);
assert.deepEqual(parseVideoPreviewFrame(packet), {
  index: 2,
  nodeId: 'sampler',
  image: `data:image/jpeg;base64,${previewJpeg.toString('base64')}`,
});
assert.equal(
  parsePreviewFrame(packet),
  null,
  'VHS packets must not be treated as ordinary JPEG previews',
);
assert.equal(parseVideoPreviewFrame(packet.subarray(0, 32)), null);
assert.equal(parseVideoPreviewFrame(videoPreviewFrame(512)), null);
assert.equal(
  parseVideoPreviewFrame(videoPreviewFrame(0, 'sampler', Buffer.from('not a jpeg'))),
  null,
);
for (const offset of [0, 4, 8, 16]) {
  const invalid = Buffer.from(packet);
  invalid[offset] = 99;
  assert.equal(parseVideoPreviewFrame(invalid), null);
}
for (const data of [
  null,
  { id: 'other', length: 3, rate: 6 },
  { id: 'sampler', length: 0, rate: 6 },
  { id: 'sampler', length: 513, rate: 6 },
  { id: 'sampler', length: 3, rate: 0 },
]) {
  assert.equal(ComfyVideoPreview.fromEvent(data, 'sampler'), null);
}
const clip = ComfyVideoPreview.fromEvent({ id: 'sampler', length: 3, rate: 6 }, 'sampler')!;
assert(clip);
assert.equal(clip.accept(videoPreviewFrame(0, 'other')), null);
assert.equal(clip.accept(videoPreviewFrame(3)), null);
let progress = mergeMediaProgress(undefined, {
  value: 1,
  max: 20,
  videoPreview: clip.accept(packet)!,
});
progress = mergeMediaProgress(progress, { videoPreview: clip.accept(videoPreviewFrame(0))! });
progress = mergeMediaProgress(progress, { value: 2 });
assert.deepEqual(Object.keys(progress.videoPreview!.frames), ['0', '2']);
assert.equal(progress.value, 2);
assert.equal(progress.max, 20);
const snapshot = structuredClone(progress);
progress = mergeMediaProgress(progress, {
  videoPreview: { ...clip.metadata, frames: { 0: null } },
});
assert.deepEqual(Object.keys(progress.videoPreview!.frames), ['2']);
assert.deepEqual(
  Object.keys(snapshot.videoPreview!.frames),
  ['0', '2'],
  'Merging does not mutate snapshots',
);
const nextClip = ComfyVideoPreview.fromEvent({ id: 'sampler', length: 3, rate: 6 }, 'sampler')!;
progress = mergeMediaProgress(progress, { videoPreview: nextClip.accept(videoPreviewFrame(1))! });
assert.notEqual(nextClip.metadata.id, clip.metadata.id);
assert.deepEqual(Object.keys(progress.videoPreview!.frames), ['1']);
assert.equal(mergeMediaProgress(progress, { videoPreview: null }).videoPreview, null);
const longNode = 'subgraph:very-long-sampler-node';
const nested = ComfyVideoPreview.fromEvent({ id: longNode, length: 3, rate: 6 }, longNode)!;
assert(nested.accept(videoPreviewFrame(1, longNode)), 'VHS truncates node IDs in binary frames');

// Use a large JPEG to exercise eviction without retaining hundreds of tiny fixtures.
const largeJpeg = Buffer.concat([
  previewJpeg.subarray(0, -2),
  Buffer.alloc(1024 * 1024),
  previewJpeg.subarray(-2),
]);
const bounded = ComfyVideoPreview.fromEvent({ id: 'sampler', length: 32, rate: 6 }, 'sampler')!;
let cached: MediaProgress = {};
let sawEviction = false;
for (let index = 0; index < 32; index++) {
  const update = bounded.accept(videoPreviewFrame(index, 'sampler', largeJpeg))!;
  sawEviction ||= Object.values(update.frames).includes(null);
  cached = mergeMediaProgress(cached, { videoPreview: update });
  const characters = Object.values(cached.videoPreview!.frames).reduce(
    (sum, frame) => sum + (frame?.length ?? 0),
    0,
  );
  assert(characters <= 16 * 1024 * 1024);
}
assert(sawEviction);
assert(cached.videoPreview!.frames[31]);
assert.equal(cached.videoPreview!.frames[0], undefined);
console.log('Video preview protocol, routing, merging and cache bounds passed');
