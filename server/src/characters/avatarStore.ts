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
import { join } from 'node:path';
import { AVATAR_DIR, stmt } from '../db/db.ts';
import { HttpError } from '../http/router.ts';
import { isPng } from './pngCard.ts';

const IMAGE_EXTS = ['png', 'jpg', 'webp'];

export type AvatarKind = 'character' | 'persona';

let lastVersion = 0;
function nextAvatarVersion(kind: AvatarKind, id: number): number {
  const table = kind === 'character' ? 'characters' : 'personas';
  const avatar = stmt(`SELECT avatar FROM ${table} WHERE id = ?`).get(id)?.avatar;
  const previous = typeof avatar === 'string' ? Number(avatar.match(/\?v=(\d+)$/)?.[1]) : 0;
  lastVersion = Math.max(Date.now(), lastVersion + 1, Number.isSafeInteger(previous) ? previous + 1 : 0);
  return lastVersion;
}

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
      copyFileSync(join(AVATAR_DIR, `${kind}-${fromId}.${ext}`), join(AVATAR_DIR, `${kind}-${toId}.${ext}`));
      return `/avatars/${kind}-${toId}.${ext}?v=${nextAvatarVersion(kind, toId)}`;
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
  // Preserve the original PNG for character-card export.
  if (!isPng(data)) throw new HttpError(415, 'avatar must be a PNG image');
  const filename = `${kind}-${id}.png`;
  const destination = join(AVATAR_DIR, filename);
  let version = nextAvatarVersion(kind, id);
  let temporary = join(AVATAR_DIR, `.${filename}.${version}.tmp`);
  let fd: number | null = null;
  try {
    for (;;) {
      try {
        fd = openSync(temporary, 'wx', 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        version = nextAvatarVersion(kind, id);
        temporary = join(AVATAR_DIR, `.${filename}.${version}.tmp`);
      }
    }
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
  return `/avatars/${filename}?v=${version}`;
}
