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
import { isPng } from '../pngCard.ts';

const IMAGE_EXTS = ['png', 'jpg', 'webp'];

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

/** Copy the file so deleting the source cannot strand the duplicate.
 * Supports legacy extensions; returns null when no source file exists. */
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

/** Legacy avatars may still use jpg/webp. */
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
  // Card export embeds JSON in PNG; no transcoder is available.
  if (!isPng(data)) throw new HttpError(415, 'avatar must be a PNG image');
  const filename = `${kind}-${id}.png`;
  const destination = join(AVATAR_DIR, filename);
  const temporary = join(AVATAR_DIR, `.${filename}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    // Atomic replacement keeps readers from seeing a partial avatar.
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
