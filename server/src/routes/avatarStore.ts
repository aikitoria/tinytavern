import {
  closeSync,
  copyFileSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AVATAR_DIR } from '../db.ts';
import { HttpError } from '../router.ts';

const IMAGE_EXTS = ['png', 'jpg', 'webp'];

/** File type from magic bytes — content-type headers lie (a renamed JPEG
 * stored as character-N.png would later break PNG card export). */
function sniffImageExt(data: Buffer): string | null {
  if (
    data.length >= 8 &&
    data.readUInt32BE(0) === 0x89504e47 &&
    data.readUInt32BE(4) === 0x0d0a1a0a
  )
    return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (
    data.length >= 12 &&
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'webp';
  return null;
}

export type AvatarKind = 'character' | 'persona';

export function deleteAvatarFiles(kind: AvatarKind, id: number): void {
  for (const ext of IMAGE_EXTS) {
    try {
      unlinkSync(join(AVATAR_DIR, `${kind}-${id}.${ext}`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/** Remove legacy alternate extensions after the DB points at `keepExt`.
 * Cleanup is best-effort: the selected file is already authoritative. */
export function deleteObsoleteAvatarFiles(kind: AvatarKind, id: number, keepExt = 'png'): void {
  for (const ext of IMAGE_EXTS) {
    if (ext === keepExt) continue;
    try {
      unlinkSync(join(AVATAR_DIR, `${kind}-${id}.${ext}`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[avatars] failed to remove obsolete ${ext} avatar:`, err);
      }
    }
  }
}

/** Copies the stored avatar file (any legacy extension) to another entity id.
 * Files are keyed by id, so a row copy must not share the source's file: the
 * source's delete would strand the copy. Returns the copy's avatar URL, or
 * null when the source has no file. */
export function copyAvatarFiles(kind: AvatarKind, fromId: number, toId: number): string | null {
  for (const ext of IMAGE_EXTS) {
    try {
      copyFileSync(
        join(AVATAR_DIR, `${kind}-${fromId}.${ext}`),
        join(AVATAR_DIR, `${kind}-${toId}.${ext}`),
      );
      return `/avatars/${kind}-${toId}.${ext}?v=${Date.now()}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}

/** Reads the stored avatar file regardless of extension (legacy avatars may
 * be jpg/webp from before uploads were restricted to PNG). */
export function readAvatarFile(kind: AvatarKind, id: number): Buffer | null {
  for (const ext of IMAGE_EXTS) {
    try {
      return readFileSync(join(AVATAR_DIR, `${kind}-${id}.${ext}`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}

export function saveAvatar(kind: AvatarKind, id: number, data: Buffer): string {
  const ext = sniffImageExt(data);
  // PNG only: character card export embeds the card JSON into the avatar PNG,
  // and dependency-free transcoding isn't available — accept nothing else.
  if (ext !== 'png') throw new HttpError(415, 'avatar must be a PNG image');
  const filename = `${kind}-${id}.${ext}`;
  const destination = join(AVATAR_DIR, filename);
  const temporary = join(AVATAR_DIR, `.${filename}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    // Same-filesystem rename atomically replaces an existing PNG: until this
    // succeeds, every reader continues to see the complete old avatar.
    renameSync(temporary, destination);
  } catch (err) {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* retain the original write/rename error */
      }
    }
    try {
      unlinkSync(temporary);
    } catch (cleanupErr) {
      if ((cleanupErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[avatars] failed to remove temporary file ${temporary}:`, cleanupErr);
      }
    }
    throw err;
  }
  return `/avatars/${filename}?v=${Date.now()}`;
}
