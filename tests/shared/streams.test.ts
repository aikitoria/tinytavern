import { controlledStream, streamBody } from '../support/streams.ts';
import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('sse', async () => {
  const { readSseData } = await import('../../shared/src/sse.ts');

  const encoder = new TextEncoder();
  // Split at every byte boundary, including within UTF-8 code points and CRLF.
  // Ignore comments/metadata and retain an unterminated final data line.
  const bytes = encoder.encode(
    ': keepalive\r\nevent: token\r\ndata: hé🦊\r\n\r\ndata:\n  data: tail',
  );
  for (let boundary = 0; boundary <= bytes.length; boundary++) {
    const body = streamBody([bytes.subarray(0, boundary), bytes.subarray(boundary)]);
    const seen: string[] = [];
    let chunks = 0;
    await readSseData(
      body,
      (data) => {
        seen.push(data);
      },
      () => {
        chunks++;
      },
    );
    assert.deepEqual(seen, ['hé🦊', '', 'tail']);
    assert.equal(chunks, 2);
    assert.equal(body.locked, false);
  }

  // EOF must flush decoder state even when a truncated code point remains.
  const incomplete = streamBody([new Uint8Array([...encoder.encode('data: '), 0xc3])]);
  const flushed: string[] = [];
  await readSseData(incomplete, (data) => {
    flushed.push(data);
  });
  assert.deepEqual(flushed, ['�']);

  // Every frame in a chunk reaches its callback before the next read/promise turn.
  const seen: string[] = [];
  await readSseData(streamBody([encoder.encode('data: first\ndata: second\n')]), (data) => {
    seen.push(data);
    if (data === 'first') queueMicrotask(() => assert.deepEqual(seen, ['first', 'second']));
  });

  for (const stop of ['return', 'throw'] as const) {
    const stream = controlledStream();
    stream.write('data: first\ndata: second\n');
    const body = stream.body;
    const seen: string[] = [];
    const failure = new Error('callback failed');
    const reading = readSseData(body, (data) => {
      seen.push(data);
      if (stop === 'throw') throw failure;
      return false;
    });
    if (stop === 'throw') await assert.rejects(reading, (error) => error === failure);
    else await reading;
    assert.deepEqual(seen, ['first']);
    assert.equal(stream.cancelled, true);
    assert.equal(body.locked, false);
  }

  // Upstream read failures survive cleanup and release the body lock.
  const failure = new Error('connection lost');
  const stream = controlledStream();
  stream.error(failure);
  const broken = stream.body;
  await assert.rejects(
    readSseData(broken, () => {}),
    (error) => error === failure,
  );
  assert.equal(broken.locked, false);
});

test('server response', async () => {
  const { streamResponse } = await import('../../server/src/http/streamResponse.ts');
  const frames = async (response: Response) =>
    (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
  let finished = 0;
  const success = streamResponse(
    new Request('http://test'),
    async (send) => {
      send({ d: 'immediate' });
      await Promise.resolve();
      send({ d: 'flushed suffix' });
    },
    () => finished++,
  );
  assert.deepEqual(await frames(success), [
    { d: 'immediate' },
    { d: 'flushed suffix' },
    { done: true },
  ]);
  assert.equal(finished, 1);
  const stale = streamResponse(new Request('http://test'), async (send) => {
    send({ d: 'draft' });
    throw new Error('branch changed');
  });
  assert.deepEqual(await frames(stale), [{ d: 'draft' }, { error: 'branch changed' }]);
  for (const alreadyClosed of [false, true]) {
    const abort = new AbortController();
    if (alreadyClosed) abort.abort();
    const response = streamResponse(
      new Request('http://test', { signal: abort.signal }),
      async (send, signal) => {
        if (!alreadyClosed) abort.abort();
        assert(signal.aborted);
        send({ d: 'late output' });
        throw new Error('aborted');
      },
    );
    assert.deepEqual(await frames(response), []);
  }
  let cancelled!: Promise<void>;
  const response = streamResponse(new Request('http://test'), async (_send, signal) => {
    cancelled = new Promise((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    await cancelled;
  });
  await response.body!.cancel();
  await cancelled;
});

test('video preview', async () => {
  const { mergeMediaProgress } = await import('@tinytavern/shared');
  type MediaProgress = import('@tinytavern/shared').MediaProgress;
  const { ComfyVideoPreview, parseVideoPreviewFrame } =
    await import('../../server/src/media/comfy/comfyVideoPreview.ts');

  const { parsePreviewFrame } = await import('../../server/src/media/comfy/comfyPreview.ts');

  const { previewJpeg, videoPreviewFrame } = await import('../support/videoPreview.ts');

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
    videoPreview: clip.accept(videoPreviewFrame(0))!,
  });
  progress = mergeMediaProgress(progress, { videoPreview: clip.accept(packet)! });
  progress = mergeMediaProgress(progress, { value: 2 });
  assert.deepEqual(Object.keys(progress.videoPreview!.frames), ['0', '2']);
  assert.equal(progress.value, 2);
  assert.equal(progress.max, 20);
  const snapshot = structuredClone(progress);
  progress = mergeMediaProgress(progress, {
    videoPreview: { ...progress.videoPreview!, frames: { 0: null } },
  });
  assert.deepEqual(Object.keys(progress.videoPreview!.frames), ['2']);
  assert.deepEqual(
    Object.keys(snapshot.videoPreview!.frames),
    ['0', '2'],
    'Merging does not mutate snapshots',
  );
  const previousSequence = progress.videoPreview!.sequence;
  progress = mergeMediaProgress(progress, { videoPreview: clip.accept(videoPreviewFrame(0))! });
  assert.notEqual(progress.videoPreview!.sequence, previousSequence);
  assert.deepEqual(
    Object.keys(progress.videoPreview!.frames),
    ['0'],
    'Denoise updates never inherit old frame slots',
  );
  const resumed = ComfyVideoPreview.restore(clip.metadata, progress.videoPreview!.sequence);
  progress = mergeMediaProgress(progress, { videoPreview: resumed.accept(videoPreviewFrame(1))! });
  assert.deepEqual(
    Object.keys(progress.videoPreview!.frames),
    ['0', '1'],
    'Reconnect keeps the current sequence identity',
  );
  const nextClip = ComfyVideoPreview.fromEvent({ id: 'sampler', length: 3, rate: 6 }, 'sampler')!;
  progress = mergeMediaProgress(progress, { videoPreview: nextClip.accept(videoPreviewFrame(1))! });
  assert.notEqual(nextClip.metadata.id, clip.metadata.id);
  assert.deepEqual(Object.keys(progress.videoPreview!.frames), ['1']);
  assert.equal(mergeMediaProgress(progress, { videoPreview: null }).videoPreview, null);
  const longNode = 'subgraph:very-long-sampler-node';
  const nested = ComfyVideoPreview.fromEvent({ id: longNode, length: 3, rate: 6 }, longNode)!;
  assert(nested.accept(videoPreviewFrame(1, longNode)), 'VHS truncates node IDs in binary frames');

  // Complete sequences larger than the former 16 MiB base64 limit must retain every slot.
  const largeJpeg = Buffer.concat([
    previewJpeg.subarray(0, -2),
    Buffer.alloc(1024 * 1024),
    previewJpeg.subarray(-2),
  ]);
  const largeClip = ComfyVideoPreview.fromEvent({ id: 'sampler', length: 16, rate: 6 }, 'sampler')!;
  let cached: MediaProgress = {};
  for (let index = 0; index < 16; index++) {
    cached = mergeMediaProgress(cached, {
      videoPreview: largeClip.accept(videoPreviewFrame(index, 'sampler', largeJpeg))!,
    });
  }
  assert.equal(Object.keys(cached.videoPreview!.frames).length, 16);
  assert(Object.values(cached.videoPreview!.frames).every(Boolean));
  assert(
    Object.values(cached.videoPreview!.frames).reduce((sum, frame) => sum + frame!.length, 0) >
      16 * 1024 * 1024,
  );
  const restored = ComfyVideoPreview.restore(cached.videoPreview!, cached.videoPreview!.sequence);
  assert.equal(restored.metadata.id, largeClip.metadata.id);
  assert(!('frames' in restored.metadata), 'Metadata does not pin obsolete frame strings');
  cached = mergeMediaProgress(cached, {
    videoPreview: restored.accept(videoPreviewFrame(0, 'sampler', largeJpeg))!,
  });
  assert.deepEqual(
    Object.keys(cached.videoPreview!.frames),
    ['0'],
    'A new sequence releases the previous cache',
  );
});

test('image dimensions', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');

  const { join } = await import('node:path');

  const { imageDimensions, imageFileDimensions } =
    await import('../../server/src/media/imageDimensions.ts');

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
  const jpeg = readFileSync(new URL('../fixtures/image.jpg', import.meta.url));
  for (const [index, data] of [png, webp, jpeg].entries()) {
    const size = imageDimensions(data);
    assert(size && size.width > 0 && size.height > 0);
    const path = join(process.env.DATA_DIR!, `format-${index}`);
    writeFileSync(path, data);
    assert.deepEqual(
      imageFileDimensions(path),
      size,
      'File header reads agree with buffer inspection',
    );
  }
  assert.deepEqual(imageDimensions(png), { width: 1, height: 1 });
  assert.deepEqual(imageDimensions(webp), { width: 1, height: 1 });
  for (const data of [
    Buffer.alloc(0),
    Buffer.alloc(24),
    png.subarray(0, 20),
    jpeg.subarray(0, 20),
    webp.subarray(0, 24),
  ])
    assert.equal(imageDimensions(data), null);
  assert.equal(imageFileDimensions(join(process.env.DATA_DIR!, 'absent')), null);
  for (const little of [true, false]) {
    const exif = Buffer.alloc(36);
    exif.writeUInt16BE(0xffe1);
    exif.writeUInt16BE(34, 2);
    exif.write('Exif\0\0', 4, 'latin1');
    exif.write(little ? 'II' : 'MM', 10);
    const u16 = (v: number, at: number) =>
      little ? exif.writeUInt16LE(v, at) : exif.writeUInt16BE(v, at);
    const u32 = (v: number, at: number) =>
      little ? exif.writeUInt32LE(v, at) : exif.writeUInt32BE(v, at);
    u16(42, 12);
    u32(8, 14);
    u16(1, 18);
    u16(0x112, 20);
    u16(3, 22);
    u32(1, 24);
    u16(6, 28);
    const rotated = Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
    const original = imageDimensions(jpeg)!;
    assert.deepEqual(imageDimensions(rotated), { width: original.height, height: original.width });
    const path = join(process.env.DATA_DIR!, `rotated-${little}`);
    writeFileSync(path, rotated);
    assert.deepEqual(imageFileDimensions(path), imageDimensions(rotated));
    u32(0xffffffff, 14);
    assert.deepEqual(
      imageDimensions(Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)])),
      original,
      'Invalid metadata offsets are ignored',
    );
  }
});
