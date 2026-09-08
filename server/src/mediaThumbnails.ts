import { execFile } from 'node:child_process';
import { readdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { AVATAR_DIR, IMAGES_DIR, stmt, invalidateMediaAsset, observeMediaAssets } from './db.ts';
import { broadcast, invalidate, observeInvalidation } from './events.ts';
import { deleteImageFiles } from './images.ts';
import { signMediaUrl } from './mediaUrls.ts';
import { getSettings } from './settingsStore.ts';
import { avatarThumbnailName } from './avatarFileNames.ts';

const runFile = promisify(execFile);
const CONCURRENCY = 2;
const RETRY_DELAY = 60_000;
interface ThumbnailSource {
  id: number | string;
  path: string;
  avatar: number;
  thumbnail: string | null;
  thumbnail_revision: number;
}

let running = false;
let size = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let notificationTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribe: (() => void) | undefined;
let unsubscribeAssets: (() => void) | undefined;
let avatarsDirty = true;
const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
const notifications = new Map<number, { thumbnail: string; revision: number }>();

function schedule(delay = 0): void {
  if (!running) return;
  clearTimeout(timer);
  timer = setTimeout(pump, delay);
}

const avatarChanges = new Set<'characters' | 'personas'>();

function scheduleNotifications(): void {
  if (notificationTimer) return;
  notificationTimer = setTimeout(() => {
    notificationTimer = undefined;
    const items = [...notifications].map(([id, item]) => ({
      id,
      thumbnail: signMediaUrl(item.thumbnail),
      revision: item.revision,
    }));
    notifications.clear();
    if (items.length) broadcast({ t: 'mediaThumbnails', items });
    for (const entity of avatarChanges) invalidate(entity);
    avatarChanges.clear();
  }, 100);
}

function publishThumbnail(id: number, thumbnail: string, revision: number): void {
  notifications.set(id, { thumbnail, revision });
  scheduleNotifications();
}

function removeTemporary(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[thumbnails] Could not remove temporary file:', error);
    }
  }
}

function sourceKey(source: ThumbnailSource): string {
  return `${source.avatar}:${source.id}`;
}

function sourceTable(source: ThumbnailSource) {
  return source.avatar
    ? { table: 'avatar_thumbnails', key: 'source', path: 'source' }
    : { table: 'media_assets', key: 'id', path: 'path' };
}

function synchronizeAvatars(): void {
  avatarsDirty = false;
  const sources = new Set(
    stmt(`SELECT avatar FROM characters WHERE avatar IS NOT NULL
    UNION SELECT avatar FROM personas WHERE avatar IS NOT NULL`)
      .all()
      .map((row) => String(row.avatar)),
  );
  for (const row of stmt('SELECT source, thumbnail FROM avatar_thumbnails').all()) {
    if (sources.has(String(row.source))) continue;
    stmt('DELETE FROM avatar_thumbnails WHERE source = ?').run(row.source!);
    if (row.thumbnail) removeTemporary(join(AVATAR_DIR, basename(String(row.thumbnail))));
  }
  for (const source of sources) {
    stmt('INSERT OR IGNORE INTO avatar_thumbnails(source) VALUES (?)').run(source);
  }
}

const pendingSources = `
  SELECT id, path, thumbnail, thumbnail_revision, thumbnail_retry_at, 0 AS avatar, '0:' || id AS task_key
  FROM media_assets WHERE thumbnail_size IS NULL
    AND EXISTS (SELECT 1 FROM media_owners o WHERE o.asset_id = media_assets.id
      AND (o.owner_type != 'job' OR NOT EXISTS (
        SELECT 1 FROM media_jobs j WHERE j.id = o.owner_id
          AND json_extract(j.configuration_json, '$.temporary') = 1
      )))
  UNION ALL
  SELECT source AS id, source AS path, thumbnail, thumbnail_revision, thumbnail_retry_at, 1 AS avatar,
    '1:' || source AS task_key
  FROM avatar_thumbnails WHERE thumbnail_size IS NULL`;

async function generate(
  source: ThumbnailSource,
  targetSize: number,
  signal: AbortSignal,
): Promise<void> {
  const directory = source.avatar ? AVATAR_DIR : IMAGES_DIR;
  const revision = source.thumbnail_revision + 1;
  let temporary: string | undefined;
  const { table, key, path: pathColumn } = sourceTable(source);
  try {
    const name = source.avatar
      ? avatarThumbnailName(source.path, revision)
      : `thumb-${source.id}-${revision}.jpg`;
    const path = `/${source.avatar ? 'avatars' : 'images'}/${name}`;
    temporary = join(directory, `${name}.part`);
    const destination = join(directory, name);
    const encoding = runFile(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-threads',
        '2',
        '-i',
        join(directory, basename(source.path.split('?')[0]!)),
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-vf',
        `scale=w='min(${targetSize},iw)':h='min(${targetSize},ih)':force_original_aspect_ratio=decrease`,
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-c:v',
        'mjpeg',
        '-q:v',
        '3',
        '-pix_fmt',
        'yuvj444p',
        '-f',
        'image2',
        '-y',
        temporary,
      ],
      { timeout: 60_000, maxBuffer: 64 * 1024, signal },
    );

    // Abort rejects execFile before the process necessarily exits. Reap it before cleanup.
    const exited = new Promise<void>((resolve) => encoding.child.once('close', () => resolve()));
    try {
      await encoding;
    } finally {
      await exited;
    }

    // Nothing can delete the item or change its settings between this check and publication.
    signal.throwIfAborted();
    const current = stmt(
      `SELECT ${pathColumn} AS path, thumbnail, thumbnail_revision FROM ${table} WHERE ${key} = ?`,
    ).get(source.id);
    if (
      !running ||
      targetSize !== (source.avatar ? 128 : size) ||
      !current ||
      current.path !== source.path ||
      current.thumbnail_revision !== source.thumbnail_revision
    )
      return;
    renameSync(temporary, destination);
    try {
      stmt(
        `UPDATE ${table} SET thumbnail = ?, thumbnail_size = ?, thumbnail_retry_at = 0,
          thumbnail_revision = ? WHERE ${key} = ?`,
      ).run(path, targetSize, revision, source.id);
    } catch (error) {
      removeTemporary(destination);
      throw error;
    }
    if (source.avatar) {
      if (current.thumbnail) removeTemporary(join(directory, basename(String(current.thumbnail))));
      avatarChanges.add(source.path.includes('/character-') ? 'characters' : 'personas');
      scheduleNotifications();
    } else {
      invalidateMediaAsset(source.path);
      if (typeof current.thumbnail === 'string') deleteImageFiles([current.thumbnail]);
      publishThumbnail(Number(source.id), path, revision);
    }
  } catch (error) {
    if (!running || signal.aborted) return;
    stmt(`UPDATE ${table} SET thumbnail_retry_at = ? WHERE ${key} = ? AND ${pathColumn} = ?`).run(
      Date.now() + RETRY_DELAY,
      source.id,
      source.path,
    );
    console.error(`[thumbnails] Could not generate thumbnail for source ${source.path}:`, error);
  } finally {
    if (temporary) removeTemporary(temporary);
  }
}

function pump(): void {
  timer = undefined;
  if (!running) return;
  try {
    if (avatarsDirty) synchronizeAvatars();
    const nextSize = getSettings().galleryThumbnailSize;
    if (nextSize !== size) {
      size = nextSize;
      for (const task of active.values()) task.controller.abort();
      stmt('UPDATE media_assets SET thumbnail_size = NULL, thumbnail_retry_at = 0').run();
    }
    const now = Date.now();
    const available = CONCURRENCY - active.size;
    if (available > 0) {
      const rows = stmt(`SELECT * FROM (${pendingSources})
        WHERE thumbnail_retry_at <= ? AND task_key NOT IN (SELECT value FROM json_each(?))
        ORDER BY avatar DESC, thumbnail_retry_at, id LIMIT ?`).all(
        now,
        JSON.stringify([...active.keys()]),
        available,
      ) as unknown as ThumbnailSource[];
      for (const row of rows) {
        const controller = new AbortController();
        const promise = generate(row, row.avatar ? 128 : size, controller.signal).finally(() => {
          active.delete(sourceKey(row));
          schedule();
        });
        active.set(sourceKey(row), { controller, promise });
      }
    }
    if (active.size < CONCURRENCY) {
      const next = stmt(`SELECT MIN(thumbnail_retry_at) AS retry FROM (${pendingSources})
        WHERE task_key NOT IN (SELECT value FROM json_each(?))`).get(
        JSON.stringify([...active.keys()]),
      )!;
      if (typeof next.retry === 'number') schedule(Math.max(0, next.retry - Date.now()));
    }
  } catch (error) {
    console.error('[thumbnails] Could not process thumbnail queue:', error);
    schedule(RETRY_DELAY);
  }
}

/** Repair missing derivatives and wake on media, avatar, or settings changes. */
export function initMediaThumbnails(): void {
  if (running) return;
  size = getSettings().galleryThumbnailSize;
  synchronizeAvatars();
  for (const table of ['media_assets', 'avatar_thumbnails']) {
    const avatar = table === 'avatar_thumbnails';
    const directory = avatar ? AVATAR_DIR : IMAGES_DIR;
    const key = avatar ? 'source' : 'id';
    const files = new Set(readdirSync(directory));
    const rows = stmt(
      `SELECT ${key} AS id, thumbnail FROM ${table} WHERE thumbnail IS NOT NULL`,
    ).all();
    const referenced = new Set(rows.map((row) => basename(String(row.thumbnail))));
    for (const row of rows) {
      if (!files.has(basename(String(row.thumbnail)))) {
        stmt(`UPDATE ${table} SET thumbnail = NULL, thumbnail_size = NULL WHERE ${key} = ?`).run(
          row.id!,
        );
      }
    }
    if (avatar) {
      for (const file of files) {
        if (
          (file.startsWith('avatar-thumb-') || file.startsWith('thumb-')) &&
          !referenced.has(file)
        )
          removeTemporary(join(directory, file));
      }
    }
    stmt(`UPDATE ${table} SET thumbnail_size = NULL, thumbnail_retry_at = 0
      WHERE thumbnail_size IS NOT ?`).run(avatar ? 128 : size);
  }
  running = true;
  unsubscribeAssets = observeMediaAssets(() => schedule());
  unsubscribe = observeInvalidation((entity) => {
    if (entity === 'characters' || entity === 'personas') avatarsDirty = true;
    schedule();
  });
  schedule();
}

export async function stopMediaThumbnails(): Promise<void> {
  running = false;
  unsubscribe?.();
  unsubscribeAssets?.();
  unsubscribeAssets = undefined;
  unsubscribe = undefined;
  clearTimeout(timer);
  clearTimeout(notificationTimer);
  timer = undefined;
  notificationTimer = undefined;
  notifications.clear();
  avatarChanges.clear();
  for (const task of active.values()) task.controller.abort();
  await Promise.all([...active.values()].map((task) => task.promise));
}
