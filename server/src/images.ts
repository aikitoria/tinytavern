import { copyFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { IMAGES_DIR, stmt } from './db.ts';
import { imageFileDimensions } from './imageDimensions.ts';

/**
 * Collect image paths before deleting rows, then unlink after commit; FK cascades
 * cannot delete files. The startup sweep covers crash windows.
 */

export interface RasterImageFormat {
  ext: '.png' | '.jpg' | '.webp';
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function isValidPng(data: Buffer): boolean {
  if (data.length < 45 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let off = 8;
  let chunks = 0;
  let hasIdat = false;
  while (off + 12 <= data.length) {
    const length = data.readUInt32BE(off);
    const end = off + 12 + length;
    if (!Number.isSafeInteger(end) || end > data.length) return false;
    const type = data.toString('latin1', off + 4, off + 8);
    if (data.readUInt32BE(off + 8 + length) !== crc32(data.subarray(off + 4, off + 8 + length))) {
      return false;
    }
    if (chunks === 0) {
      if (
        type !== 'IHDR' ||
        length !== 13 ||
        data.readUInt32BE(off + 8) === 0 ||
        data.readUInt32BE(off + 12) === 0
      ) {
        return false;
      }
    } else if (type === 'IHDR') {
      return false;
    }
    if (type === 'IDAT') hasIdat = true;
    off = end;
    chunks++;
    if (type === 'IEND') return length === 0 && hasIdat && off === data.length;
  }
  return false;
}

function isStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function isValidJpeg(data: Buffer): boolean {
  if (
    data.length < 14 ||
    data[0] !== 0xff ||
    data[1] !== 0xd8 ||
    data[data.length - 2] !== 0xff ||
    data[data.length - 1] !== 0xd9
  ) {
    return false;
  }
  let off = 2;
  let hasFrame = false;
  while (off < data.length - 2) {
    if (data[off++] !== 0xff) return false;
    while (data[off] === 0xff) off++;
    const marker = data[off++]!;
    if (marker === 0xda) {
      if (!hasFrame || off + 2 > data.length - 2) return false;
      const length = data.readUInt16BE(off);
      return length >= 2 && off + length <= data.length - 2;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0xd9 || off + 2 > data.length) return false;
    const length = data.readUInt16BE(off);
    if (length < 2 || off + length > data.length - 2) return false;
    if (isStartOfFrame(marker)) {
      if (length < 8 || data.readUInt16BE(off + 3) === 0 || data.readUInt16BE(off + 5) === 0) {
        return false;
      }
      hasFrame = true;
    }
    off += length;
  }
  return false;
}

function isValidWebp(data: Buffer): boolean {
  if (
    data.length < 20 ||
    data.toString('latin1', 0, 4) !== 'RIFF' ||
    data.toString('latin1', 8, 12) !== 'WEBP' ||
    data.readUInt32LE(4) + 8 !== data.length
  ) {
    return false;
  }
  let off = 12;
  let hasImageData = false;
  while (off + 8 <= data.length) {
    const type = data.toString('latin1', off, off + 4);
    const length = data.readUInt32LE(off + 4);
    const end = off + 8 + length;
    if (!Number.isSafeInteger(end) || end > data.length) return false;
    if (type === 'VP8 ') {
      if (
        length < 10 ||
        data[off + 11] !== 0x9d ||
        data[off + 12] !== 0x01 ||
        data[off + 13] !== 0x2a
      ) {
        return false;
      }
      hasImageData = true;
    } else if (type === 'VP8L') {
      if (length < 5 || data[off + 8] !== 0x2f) return false;
      hasImageData = true;
    } else if (type === 'ANMF') {
      if (length < 16) return false;
      hasImageData = true;
    }
    off = end + (length % 2);
  }
  return off === data.length && hasImageData;
}

/** Returns a canonical safe extension from the bytes, never from an upstream filename. */
export function rasterImageFormat(data: Buffer): RasterImageFormat | null {
  if (isValidPng(data)) return { ext: '.png', mime: 'image/png' };
  if (isValidJpeg(data)) return { ext: '.jpg', mime: 'image/jpeg' };
  if (isValidWebp(data)) return { ext: '.webp', mime: 'image/webp' };
  return null;
}

function imageFile(imagePath: string): string | null {
  if (!imagePath.startsWith('/images/')) return null;
  const name = basename(imagePath.slice('/images/'.length));
  return name ? join(IMAGES_DIR, name) : null;
}

export function savedImageDimensions(imagePath: string) {
  const file = imageFile(imagePath);
  return file ? imageFileDimensions(file) : null;
}

export function saveImage(name: string, data: Buffer): string {
  writeFileSync(join(IMAGES_DIR, basename(name)), data);
  return `/images/${basename(name)}`;
}

/**
 * Copies must own separate files so deleting one message cannot break another.
 * Returns the new served path, or null if the source is invalid or missing.
 */
export function copyImage(imagePath: string, newName: string): string | null {
  const file = imageFile(imagePath);
  if (!file) return null;
  try {
    copyFileSync(file, join(IMAGES_DIR, basename(newName)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return `/images/${basename(newName)}`;
}

export function deleteImageFiles(imagePaths: string[]): void {
  for (const imagePath of imagePaths) {
    const file = imageFile(imagePath);
    if (!file) continue;
    try {
      unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[images] failed to delete ${file}:`, err);
      }
    }
  }
}

export function collectMessageImages(messageId: number): string[] {
  const rows = stmt(
    'SELECT j.value AS image FROM messages m, json_each(m.images_json) j WHERE m.id = ?',
  ).all(messageId) as { image: string }[];
  return rows.map((row) => row.image);
}

/** Includes every row reached by a cascading delete. */
export function collectSubtreeImages(messageId: number): string[] {
  const rows = stmt(
    `WITH RECURSIVE doomed(id) AS (
       SELECT id FROM messages WHERE id = ?
       UNION ALL
       SELECT m.id FROM messages m JOIN doomed d ON m.parent_id = d.id
     )
     SELECT j.value AS image FROM messages m, json_each(m.images_json) j
     WHERE m.id IN (SELECT id FROM doomed)`,
  ).all(messageId) as { image: string }[];
  return rows.map((row) => row.image);
}

/** Collects every child subtree of `parentId`, matching delete-tail scope. */
export function collectSiblingSubtreeImages(
  conversationId: number,
  parentId: number | null,
): string[] {
  const rows = stmt(
    `WITH RECURSIVE doomed(id) AS (
       SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ?
       UNION ALL
       SELECT m.id FROM messages m JOIN doomed d ON m.parent_id = d.id
     )
     SELECT j.value AS image FROM messages m, json_each(m.images_json) j
     WHERE m.id IN (SELECT id FROM doomed)`,
  ).all(conversationId, parentId) as { image: string }[];
  return rows.map((row) => row.image);
}

export function collectConversationImages(conversationId: number): string[] {
  const rows = stmt(
    'SELECT j.value AS image FROM messages m, json_each(m.images_json) j WHERE m.conversation_id = ?',
  ).all(conversationId) as { image: string }[];
  return rows.map((row) => row.image);
}

/** Removes files orphaned by crashes or late renders; gallery references also count. */
export function sweepOrphanedImages(): void {
  const referenced = new Set(
    (
      stmt(
        `SELECT j.value AS image FROM messages m, json_each(m.images_json) j
         UNION ALL
         SELECT image FROM gallery_items WHERE image IS NOT NULL`,
      ).all() as { image: string }[]
    )
      .map((row) => basename(row.image.slice('/images/'.length)))
      .filter(Boolean),
  );
  let removed = 0;
  for (const name of readdirSync(IMAGES_DIR)) {
    if (referenced.has(name)) continue;
    try {
      unlinkSync(join(IMAGES_DIR, name));
      removed++;
    } catch (err) {
      console.error(`[images] failed to sweep ${name}:`, err);
    }
  }
  if (removed > 0) console.log(`[images] swept ${removed} orphaned image file(s)`);
}
