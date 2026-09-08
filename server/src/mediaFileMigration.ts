import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, openSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { StatementSync } from 'node:sqlite';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const originalName = new RegExp(`^media-${UUID}\\.(png|jpe?g|webp|webm)$`);
const thumbnailName = new RegExp(`^thumb-${UUID}\\.(png|jpe?g|webp)$`);

/** Run inside the schema transaction, before any asset cache or worker is initialized.
 * Link first, sync the directory, then commit references. Old names stay readable on
 * rollback/crash; startup's orphan sweep removes unused names after the commit.
 * Hard links avoid copying large videos and never overwrite an existing file. */
export function migrateMediaFileNames(
  directory: string,
  stmt: (sql: string) => StatementSync,
): void {
  const assets = stmt('SELECT id, path, thumbnail FROM media_assets').all() as {
    id: number;
    path: string;
    thumbnail: string | null;
  }[];
  const gallery = stmt('SELECT id, image, source_image FROM gallery_items').all() as {
    id: number;
    image: string | null;
    source_image: string | null;
  }[];
  const reserved = new Set<string>();
  for (const asset of assets) {
    reserved.add(asset.path);
    if (asset.thumbnail) reserved.add(asset.thumbnail);
  }
  for (const row of gallery) {
    if (row.image) reserved.add(row.image);
    if (row.source_image) reserved.add(row.source_image);
  }
  const paths = new Map<string, string>();
  const migratePath = (path: string | null, thumbnail: boolean) => {
    if (!path || paths.has(path) || !/^\/images\/[^/]+\.(png|jpe?g|webp|webm)$/i.test(path)) return;
    const name = basename(path);
    if ((thumbnail ? thumbnailName : originalName).test(name)) return;
    const source = join(directory, name);
    try {
      if (!lstatSync(source).isFile()) throw new Error(`Media migration expected a file: ${path}`);
    } catch (error) {
      // Preserve missing-file references. Thumbnail startup repair handles absent derivatives.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (;;) {
      const stem = thumbnail ? `thumb-${randomUUID()}` : `media-${randomUUID()}`;
      const target = `/images/${stem}${extname(name).toLowerCase()}`;
      if (reserved.has(target)) continue;
      try {
        linkSync(source, join(directory, basename(target)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      reserved.add(target);
      paths.set(path, target);
      return;
    }
  };
  // A derivative can also have an asset record; use one name for every reference to it.
  const thumbnails = new Set(assets.flatMap((asset) => (asset.thumbnail ? [asset.thumbnail] : [])));
  for (const path of thumbnails) migratePath(path, true);
  for (const asset of assets) migratePath(asset.path, thumbnails.has(asset.path));
  for (const row of gallery) {
    migratePath(row.image, row.image !== null && thumbnails.has(row.image));
    migratePath(row.source_image, row.source_image !== null && thumbnails.has(row.source_image));
  }
  if (!paths.size) return;

  const directoryFd = openSync(directory, 'r');
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }

  // A path-only rewrite must not rebuild owners or re-add removed character associations.
  // Transactional DDL restores the exact triggers on rollback as well as on success.
  const triggers = stmt(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND name IN ('media_message_update', 'media_gallery_update')`).all();
  for (const trigger of triggers) stmt(`DROP TRIGGER ${trigger.name}`).run();
  const rewrite = (path: string | null) => (path === null ? null : (paths.get(path) ?? path));
  for (const asset of assets) {
    const path = rewrite(asset.path);
    const thumbnail = rewrite(asset.thumbnail);
    if (path === asset.path && thumbnail === asset.thumbnail) continue;
    stmt(`UPDATE media_assets SET path = ?, thumbnail = ?,
      thumbnail_revision = thumbnail_revision + ? WHERE id = ?`).run(
      path,
      thumbnail,
      Number(thumbnail !== asset.thumbnail),
      asset.id,
    );
  }
  for (const row of stmt("SELECT id, images_json FROM messages WHERE images_json != '[]'").all()) {
    const images = JSON.parse(String(row.images_json)) as string[];
    if (!images.some((path) => paths.has(path))) continue;
    stmt('UPDATE messages SET images_json = ? WHERE id = ?').run(
      JSON.stringify(images.map(rewrite)),
      row.id!,
    );
  }
  for (const row of gallery) {
    const image = rewrite(row.image);
    const source = rewrite(row.source_image);
    if (image === row.image && source === row.source_image) continue;
    stmt('UPDATE gallery_items SET image = ?, source_image = ? WHERE id = ?').run(
      image,
      source,
      row.id,
    );
  }
  for (const trigger of triggers) stmt(String(trigger.sql)).run();
}

/** Reuse a hard link left by an interrupted migration, never replace unrelated bytes. */
export function linkExistingMediaFile(directory: string, path: string, target: string): boolean {
  const sourceFile = join(directory, basename(path));
  const targetFile = join(directory, basename(target));
  let source;
  try {
    source = lstatSync(sourceFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!source.isFile()) throw new Error(`Media migration expected a file: ${path}`);
  try {
    linkSync(sourceFile, targetFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = lstatSync(targetFile);
    if (!existing.isFile() || existing.dev !== source.dev || existing.ino !== source.ino) {
      throw new Error(`Media migration target belongs to another file: ${target}`);
    }
  }
  return true;
}

export function syncMediaDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Migration 64: use durable asset identities, independently of their current owners.
 * The caller holds the schema transaction. Old links remain until the post-commit sweep. */
export function migrateNumericMediaFileNames(
  directory: string,
  stmt: (sql: string) => StatementSync,
): void {
  const assets = stmt('SELECT id, path, thumbnail, thumbnail_revision FROM media_assets').all() as {
    id: number;
    path: string;
    thumbnail: string | null;
    thumbnail_revision: number;
  }[];
  const paths = new Map<string, string>();
  const thumbnails = new Map<number, string>();
  for (const asset of assets) {
    if (/^\/images\/[^/]+\.(png|jpe?g|webp|webm)$/i.test(asset.path)) {
      const target = `/images/media-${asset.id}${extname(asset.path).toLowerCase()}`;
      if (target !== asset.path && linkExistingMediaFile(directory, asset.path, target)) {
        paths.set(asset.path, target);
      }
    }
    if (asset.thumbnail && /^\/images\/[^/]+\.(png|jpe?g|webp)$/i.test(asset.thumbnail)) {
      // Legacy derivatives are JPEG, but preserve the encoding of any imported derivative.
      const ext = extname(asset.thumbnail).toLowerCase();
      const stem = `/images/thumb-${asset.id}-`;
      if (asset.thumbnail === `${stem}${asset.thumbnail_revision}${ext}`) continue;
      const target = `${stem}${asset.thumbnail_revision + 1}${ext}`;
      if (linkExistingMediaFile(directory, asset.thumbnail, target))
        thumbnails.set(asset.id, target);
    }
  }
  if (!paths.size && !thumbnails.size) return;
  syncMediaDirectory(directory);

  const triggers = stmt(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND name IN ('media_message_update', 'media_gallery_update')`).all();
  for (const trigger of triggers) stmt(`DROP TRIGGER ${trigger.name}`).run();
  for (const asset of assets) {
    const path = paths.get(asset.path);
    const thumbnail = thumbnails.get(asset.id);
    if (!path && !thumbnail) continue;
    stmt(`UPDATE media_assets SET path = ?, thumbnail = ?,
      thumbnail_revision = thumbnail_revision + ? WHERE id = ?`).run(
      path ?? asset.path,
      thumbnail ?? asset.thumbnail,
      Number(thumbnail !== undefined),
      asset.id,
    );
  }
  const rewrite = (path: string | null) => (path === null ? null : (paths.get(path) ?? path));
  for (const row of stmt("SELECT id, images_json FROM messages WHERE images_json != '[]'").all()) {
    const images = JSON.parse(String(row.images_json)) as string[];
    if (images.some((path) => paths.has(path))) {
      stmt('UPDATE messages SET images_json = ? WHERE id = ?').run(
        JSON.stringify(images.map(rewrite)),
        row.id!,
      );
    }
  }
  for (const row of stmt('SELECT id, image, source_image FROM gallery_items').all()) {
    const image = rewrite(row.image as string);
    const source = rewrite(row.source_image as string | null);
    if (image !== row.image || source !== row.source_image) {
      stmt('UPDATE gallery_items SET image = ?, source_image = ? WHERE id = ?').run(
        image,
        source,
        row.id!,
      );
    }
  }
  for (const trigger of triggers) stmt(String(trigger.sql)).run();
}
