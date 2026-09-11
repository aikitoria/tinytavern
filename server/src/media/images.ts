import {
  closeSync,
  openSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  statSync,
  constants,
} from 'node:fs';
import { basename, join, extname } from 'node:path';
import { crc32 } from 'node:zlib';
import {
  IMAGES_DIR,
  stmt,
  invalidateMediaAsset,
  mediaAssetForPath,
  transaction,
} from '../db/db.ts';
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

/** Allocate the SQLite ID and its filename together, before any file is created.
 * Committed reservations advance AUTOINCREMENT even if later released; exclusive creation
 * protects file names left by an outer transaction that rolled back its reservation. */
export function reserveMediaFile(extension: string): { id: number; path: string } {
  if (!/^\.(png|jpe?g|webp|webm|mp4|part)$/.test(extension))
    throw new Error('Invalid media extension');
  return stmt(`INSERT INTO media_assets(path, created_at)
    VALUES ('/images/media-' || (COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'media_assets'), 0) + 1) || ?, ?)
    RETURNING id, path`).get(extension, Date.now()) as { id: number; path: string };
}

function registerImage(path: string, byteSize: number): void {
  const size = savedImageDimensions(path);
  const ext = extname(path).toLowerCase();
  const kind = ext === '.webm' || ext === '.mp4' ? 'video' : 'image';
  const mime =
    ext === '.mp4'
      ? 'video/mp4'
      : ext === '.webm'
        ? 'video/webm'
        : ext === '.webp'
          ? 'image/webp'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : 'image/png';
  stmt(`UPDATE media_assets SET kind = ?, mime = ?, byte_size = ?, width = ?, height = ?
    WHERE path = ?`).run(kind, mime, byteSize, size?.width ?? null, size?.height ?? null, path);
  invalidateMediaAsset(path);
}

export function saveImage(extension: string, data: Buffer): string {
  return writeImage(extension, data);
}

/** Copies own separate files; invalid or missing sources return null. */
export function copyImage(imagePath: string): string | null {
  return writeImage(extname(imagePath).toLowerCase(), imagePath);
}

function writeImage(extension: string, source: Buffer): string;
function writeImage(extension: string, source: string): string | null;
function writeImage(extension: string, source: Buffer | string): string | null {
  const file = typeof source === 'string' ? imageFile(source) : null;
  if (typeof source === 'string' && !file) return null;
  let written: string | undefined;
  let reservation: { id: number; path: string } | undefined;
  try {
    return transaction(() => {
      reservation = reserveMediaFile(extension);
      const { path } = reservation;
      const destination = join(IMAGES_DIR, basename(path));
      let byteSize: number;
      if (typeof source === 'string') {
        copyFileSync(file!, destination, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
        written = destination;
        byteSize = statSync(file!).size;
      } else {
        // Exclusive creation protects files left by an interrupted outer transaction.
        const fd = openSync(destination, 'wx');
        written = destination;
        try {
          writeFileSync(fd, source);
        } finally {
          closeSync(fd);
        }
        byteSize = source.length;
      }
      registerImage(path, byteSize);
      const original = typeof source === 'string' ? mediaAssetForPath(source) : null;
      if (original) {
        stmt(
          'UPDATE media_assets SET kind = ?, mime = ?, width = ?, height = ?, duration = ?, recipe_id = ? WHERE path = ?',
        ).run(
          original.kind,
          original.mime,
          original.width,
          original.height,
          original.duration,
          original.recipeId,
          path,
        );
        stmt(`INSERT INTO media_characters(asset_id, character_id)
          SELECT target.id, mc.character_id FROM media_assets target, media_characters mc
          WHERE target.path = ? AND mc.asset_id = ?`).run(path, original.id);
        invalidateMediaAsset(path);
      }
      return path;
    });
  } catch (err) {
    try {
      if (written) unlinkSync(written);
    } finally {
      // A missing source is recoverable inside a larger copy/import transaction.
      if (reservation) {
        stmt('DELETE FROM media_assets WHERE id = ?').run(reservation.id);
        invalidateMediaAsset(reservation.path);
      }
    }
    if (typeof source === 'string' && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function deleteImageFiles(imagePaths: string[]): void {
  const pending = [...new Set(imagePaths)];
  const seen = new Set<string>();
  while (pending.length) {
    const imagePath = pending.pop()!;
    if (seen.has(imagePath)) continue;
    const file = imageFile(imagePath);
    if (!file) continue;
    // Every legacy deletion path passes here. A job/recipe pin owns the file even
    // after its original gallery item or message has been deleted.
    if (
      stmt(`SELECT 1 FROM media_assets a JOIN media_owners o ON o.asset_id = a.id
      WHERE a.path = ? OR a.thumbnail = ? LIMIT 1`).get(imagePath, imagePath)
    )
      continue;
    seen.add(imagePath);
    const asset = mediaAssetForPath(imagePath);
    transaction(() => {
      stmt('DELETE FROM media_assets WHERE path = ?').run(imagePath);
      invalidateMediaAsset(imagePath);
      if (asset?.thumbnail) pending.push(asset.thumbnail);
      if (
        asset?.recipeId &&
        !stmt('SELECT 1 FROM media_assets WHERE recipe_id = ? LIMIT 1').get(asset.recipeId) &&
        !stmt('SELECT 1 FROM messages WHERE render_recipe_id = ? LIMIT 1').get(asset.recipeId)
      ) {
        const inputs =
          stmt(`SELECT a.path FROM media_assets a JOIN media_owners o ON o.asset_id = a.id
          WHERE o.owner_type = 'recipe' AND o.owner_id = ?`).all(asset.recipeId) as {
            path: string;
          }[];
        stmt('DELETE FROM media_recipes WHERE id = ?').run(asset.recipeId);
        pending.push(...inputs.map((input) => input.path));
      }
    });
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
  const rows = stmt('SELECT image FROM message_media_files WHERE message_id = ?').all(
    messageId,
  ) as { image: string }[];
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
     SELECT image FROM message_media_files WHERE message_id IN (SELECT id FROM doomed)`,
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
     SELECT image FROM message_media_files WHERE message_id IN (SELECT id FROM doomed)`,
  ).all(conversationId, parentId) as { image: string }[];
  return rows.map((row) => row.image);
}

export function collectConversationImages(conversationId: number): string[] {
  const rows = stmt(
    'SELECT f.image FROM message_media_files f JOIN messages m ON m.id = f.message_id WHERE m.conversation_id = ?',
  ).all(conversationId) as { image: string }[];
  return rows.map((row) => row.image);
}

/** Removes files orphaned by crashes or late renders; gallery references also count. */
export function sweepOrphanedImages(): void {
  const referenced = new Set(
    (
      stmt(
        `SELECT a.path AS image FROM media_assets a WHERE EXISTS
          (SELECT 1 FROM media_owners o WHERE o.asset_id = a.id)
         UNION ALL SELECT a.thumbnail AS image FROM media_assets a WHERE a.thumbnail IS NOT NULL
         AND EXISTS (SELECT 1 FROM media_owners o WHERE o.asset_id = a.id)`,
      ).all() as { image: string }[]
    )
      .map((row) => basename(row.image.slice('/images/'.length)))
      .filter(Boolean),
  );
  let removed = 0;
  for (const name of readdirSync(IMAGES_DIR)) {
    if (referenced.has(name)) continue;
    try {
      deleteImageFiles([`/images/${name}`]);
      removed++;
    } catch (err) {
      console.error(`[images] failed to sweep ${name}:`, err);
    }
  }
  // A process may die after reserving an ID but before creating its .part file.
  stmt(`DELETE FROM media_assets WHERE path = '/images/media-' || id || '.part'
    AND NOT EXISTS (SELECT 1 FROM media_owners WHERE asset_id = media_assets.id)`).run();
  if (removed > 0) console.log(`[images] swept ${removed} orphaned image file(s)`);
}
