import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageDimensions, imageFileDimensions } from '../server/src/imageDimensions.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const jpeg = readFileSync(new URL('./fixtures/image.jpg', import.meta.url));
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
console.log(
  'Image dimension regressions passed: PNG, JPEG, WebP, EXIF axes, truncated headers and bounded file reads.',
);
