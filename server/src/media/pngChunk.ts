import { crc32 } from 'node:zlib';

export function chunk(type: string, data: Buffer): Buffer {
  if (type.length !== 4) throw new Error('PNG chunk types must contain four bytes');
  const out = Buffer.allocUnsafe(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, data.length + 8)), data.length + 8);
  return out;
}
