import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { IMAGES_DIR, stmt } = await import('../server/src/db.ts');
const { downloadMedia, InvalidMediaOutput } = await import('../server/src/mediaFiles.ts');
const { makePlaceholderPng } = await import('../server/src/pngCard.ts');
const runFile = promisify(execFile);

const sourcePath = join(IMAGES_DIR, 'source.webm');
await runFile('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=blue:s=64x48:r=5:d=0.6',
  '-c:v',
  'libaom-av1',
  '-cpu-used',
  '8',
  '-threads',
  '2',
  '-y',
  sourcePath,
]);
const original = readFileSync(sourcePath);
const matroskaPath = join(IMAGES_DIR, 'source.mkv');
await runFile('ffmpeg', ['-v', 'error', '-i', sourcePath, '-c', 'copy', '-y', matroskaPath]);
await assert.rejects(
  downloadMedia(new Response(readFileSync(matroskaPath)), 'video', new AbortController().signal),
  InvalidMediaOutput,
  'An AV1 Matroska file must not be stored or served as WebM',
);
const video = await downloadMedia(new Response(original), 'video', new AbortController().signal);
assert.equal(video.mime, 'video/webm');
assert.equal(video.width, 64);
assert.equal(video.height, 48);
assert(video.duration !== null && video.duration > 0);
assert(!readdirSync(IMAGES_DIR).some((name) => name.includes('poster')));
assert.deepEqual(
  readFileSync(join(IMAGES_DIR, basename(video.path))),
  original,
  'The AV1 WebM original is stored byte-for-byte',
);
assert(!readdirSync(IMAGES_DIR).some((name) => name.endsWith('.part')));

const png = makePlaceholderPng();
const image = await downloadMedia(new Response(png), 'image', new AbortController().signal);
assert.equal(image.mime, 'image/png');
assert.deepEqual(readFileSync(join(IMAGES_DIR, basename(image.path))), png);

await assert.rejects(
  downloadMedia(new Response(original), 'image', new AbortController().signal),
  /invalid raster/,
);
await assert.rejects(
  downloadMedia(
    new Response(png, { headers: { 'content-length': String(2 ** 30 + 1) } }),
    'video',
    new AbortController().signal,
  ),
  /size limit/,
);
assert(
  !readdirSync(IMAGES_DIR).some((name) => name.endsWith('.part')),
  'Rejected downloads leave no partial files',
);

const chunk = new Uint8Array(1024 * 1024);
let chunksSent = 0;
await assert.rejects(
  downloadMedia(
    new Response(
      new ReadableStream({
        pull(stream) {
          stream.enqueue(chunk);
          if (++chunksSent === 65) {
            stream.close();
          }
        },
      }),
    ),
    'image',
    new AbortController().signal,
  ),
  InvalidMediaOutput,
  'An oversized chunked download is a terminal invalid output, not a retrieval retry',
);

const controller = new AbortController();
const response = new Response(
  new ReadableStream({
    start(stream) {
      stream.enqueue(original.subarray(0, 12));
      setTimeout(() => controller.abort(), 10);
    },
  }),
);
await assert.rejects(downloadMedia(response, 'video', controller.signal), /abort/i);
assert(!readdirSync(IMAGES_DIR).some((name) => name.endsWith('.part')));
assert.equal(
  stmt('SELECT count(*) AS count FROM media_assets').get()!.count,
  2,
  'Failed downloads release their asset reservations',
);
for (const asset of stmt('SELECT id, path FROM media_assets').all()) {
  assert.match(String(asset.path), new RegExp(`/media-${asset.id}\\.(png|webm)$`));
}

// Deterministic names must preserve unexpected files rather than overwrite or clean them up.
for (const extension of ['.part', '.png']) {
  const nextId =
    Number(stmt("SELECT seq FROM sqlite_sequence WHERE name = 'media_assets'").get()!.seq) + 1;
  const collision = join(IMAGES_DIR, `media-${nextId}${extension}`);
  writeFileSync(collision, 'Unrelated bytes');
  await assert.rejects(downloadMedia(new Response(png), 'image', new AbortController().signal), {
    code: 'EEXIST',
  });
  assert.equal(readFileSync(collision, 'utf8'), 'Unrelated bytes');
  assert.equal(stmt('SELECT count(*) AS count FROM media_assets').get()!.count, 2);
  unlinkSync(collision);
}

console.log(
  'Media files preserve AV1 WebM originals, extract dimensions/duration without separate posters and discard invalid, oversized or aborted downloads',
);
