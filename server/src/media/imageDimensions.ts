import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface ImageDimensions {
  width: number;
  height: number;
}

type Read = (offset: number, length: number) => Buffer | null;
const dimensions = (width: number, height: number): ImageDimensions | null =>
  width > 0 && height > 0 ? { width, height } : null;

// Browsers apply EXIF orientation; row geometry must match the displayed axes.
function swapsExifAxes(read: Read, offset: number, size: number): boolean {
  const signature = read(offset, 6);
  if (signature?.toString('latin1') !== 'Exif\0\0') return false;
  const base = offset + 6;
  const end = offset + size;
  const header = read(base, 8);
  if (!header) return false;
  const order = header.toString('ascii', 0, 2);
  if (order !== 'II' && order !== 'MM') return false;
  const little = order === 'II';
  const u16 = (data: Buffer, start = 0) => (little ? data.readUInt16LE(start) : data.readUInt16BE(start));
  const u32 = (data: Buffer, start = 0) => (little ? data.readUInt32LE(start) : data.readUInt32BE(start));
  if (u16(header, 2) !== 42) return false;
  const directory = base + u32(header, 4);
  if (directory < base + 8 || directory + 2 > end) return false;
  const countBytes = read(directory, 2);
  if (!countBytes) return false;
  const count = Math.min(u16(countBytes), 256);
  for (let index = 0; index < count; index++) {
    const at = directory + 2 + index * 12;
    if (at + 12 > end) return false;
    const entry = read(at, 12);
    if (!entry) return false;
    if (u16(entry) === 0x112 && u16(entry, 2) === 3 && u32(entry, 4) === 1) {
      const orientation = u16(entry, 8);
      return orientation >= 5 && orientation <= 8;
    }
  }
  return false;
}

// Only headers are inspected; the raster is neither decoded nor copied.
function inspect(read: Read): ImageDimensions | null {
  const header = read(0, 12);
  if (!header) return null;
  if (header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    const ihdr = read(12, 12);
    return ihdr?.toString('ascii', 0, 4) === 'IHDR' ? dimensions(ihdr.readUInt32BE(4), ihdr.readUInt32BE(8)) : null;
  }
  if (header[0] === 0xff && header[1] === 0xd8) {
    let offset = 2;
    let swap = false;
    for (let segments = 0; segments < 4096; segments++) {
      let marker = read(offset++, 1);
      if (marker?.[0] !== 0xff) return null;
      do {
        marker = read(offset++, 1);
      } while (marker?.[0] === 0xff);
      if (!marker || marker[0] === 0xda || marker[0] === 0xd9) return null;
      if (marker[0] === 0x01 || (marker[0]! >= 0xd0 && marker[0]! <= 0xd8)) continue;
      const code = marker[0]!;
      const size = read(offset, 2)?.readUInt16BE(0);
      if (!size || size < 2) return null;
      if (code === 0xe1 && size >= 16) swap ||= swapsExifAxes(read, offset + 2, size - 2);
      if (code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc) {
        const frame = size >= 8 ? read(offset, 8) : null;
        return frame ? dimensions(frame.readUInt16BE(swap ? 3 : 5), frame.readUInt16BE(swap ? 5 : 3)) : null;
      }
      offset += size;
    }
  }
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') {
    const end = header.readUInt32LE(4) + 8;
    for (let offset = 12, chunks = 0; offset + 8 <= end && chunks < 4096; chunks++) {
      const chunk = read(offset, 8);
      if (!chunk) return null;
      const length = chunk.readUInt32LE(4);
      if (offset + 8 + length > end) return null;
      const type = chunk.toString('ascii', 0, 4);
      if (type === 'VP8X' && length >= 10) {
        const data = read(offset + 8, 10);
        return data ? dimensions(data.readUIntLE(4, 3) + 1, data.readUIntLE(7, 3) + 1) : null;
      }
      if (type === 'VP8 ' && length >= 10) {
        const data = read(offset + 8, 10);
        return data?.toString('hex', 3, 6) === '9d012a'
          ? dimensions(data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff)
          : null;
      }
      if (type === 'VP8L' && length >= 5) {
        const data = read(offset + 8, 5);
        if (data?.[0] !== 0x2f) return null;
        const bits = data.readUInt32LE(1);
        return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      offset += 8 + length + (length % 2);
    }
  }
  return null;
}

export function imageDimensions(data: Buffer): ImageDimensions | null {
  return inspect((offset, length) => (offset + length <= data.length ? data.subarray(offset, offset + length) : null));
}

/** Bounded header reads also skip large JPEG metadata without loading image pixels. */
export function imageFileDimensions(path: string): ImageDimensions | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const scratch = Buffer.allocUnsafe(16);
    return inspect((offset, length) => {
      if (offset + length > size) return null;
      return readSync(fd!, scratch, 0, length, offset) === length ? scratch.subarray(0, length) : null;
    });
  } catch {
    // Missing/older invalid files still keep their gallery rows and prompt snapshots.
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
