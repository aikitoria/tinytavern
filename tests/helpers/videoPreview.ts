import { readFileSync } from 'node:fs';

export const previewJpeg = readFileSync(new URL('../fixtures/image.jpg', import.meta.url));

/** The full WebSocket payload produced by the installed VHS latent preview hook. */
export function videoPreviewFrame(index: number, nodeId = 'sampler', jpeg = previewJpeg): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(index, 12);
  const node = nodeId.slice(0, 15);
  header[16] = node.length;
  header.write(node, 17, 'ascii');
  return Buffer.concat([header, jpeg]);
}
