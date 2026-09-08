import type { StatementSync } from 'node:sqlite';
import { linkExistingMediaFile, syncMediaDirectory } from './mediaFileMigration.ts';

// Migration 64 retains its historical naming independently of the runtime format.
function avatarThumbnailName(source: string, revision: number): string {
  const match = source.match(/^\/avatars\/((?:character|persona)-\d+)\.(?:png|jpg|webp)\?v=(\d+)$/);
  if (!match) throw new Error(`Avatar has no numeric file version: ${source}`);
  return `avatar-thumb-${match[1]}-${match[2]}-${revision}.jpg`;
}

/** Called in the startup schema transaction; originals already use entity IDs. */
export function migrateAvatarFileNames(
  directory: string,
  stmt: (sql: string) => StatementSync,
): void {
  const entities =
    stmt(`SELECT 'characters' AS entity, id, avatar FROM characters WHERE avatar IS NOT NULL
    UNION ALL SELECT 'personas' AS entity, id, avatar FROM personas WHERE avatar IS NOT NULL`).all();
  const thumbnails = stmt('SELECT * FROM avatar_thumbnails').all();
  const reserved = new Set([
    ...entities.map((row) => String(row.avatar)),
    ...thumbnails.map((row) => String(row.source)),
  ]);
  const sources = new Map<string, string>();
  for (const row of entities) {
    const source = String(row.avatar);
    if (sources.has(source)) continue;
    const match = source.match(
      /^(\/avatars\/(?:character|persona)-\d+\.(?:png|jpg|webp))(?:\?v=(.*))?$/,
    );
    if (!match || /^\d+$/.test(match[2] ?? '')) continue;
    let version = 1;
    while (reserved.has(`${match[1]}?v=${version}`)) version++;
    const target = `${match[1]}?v=${version}`;
    sources.set(source, target);
    reserved.add(target);
  }
  let linked = false;
  const changed = new Map<string, { path: string; revision: number }>();
  const current = new Set(entities.map((row) => String(row.avatar)));
  for (const row of thumbnails) {
    const source = String(row.source);
    if (!current.has(source) || typeof row.thumbnail !== 'string') continue;
    const nextSource = sources.get(source) ?? source;
    const revision = Number(row.thumbnail_revision);
    if (row.thumbnail === `/avatars/${avatarThumbnailName(nextSource, revision)}`) continue;
    const target = `/avatars/${avatarThumbnailName(nextSource, revision + 1)}`;
    if (linkExistingMediaFile(directory, row.thumbnail, target)) {
      linked = true;
      changed.set(source, { path: target, revision: revision + 1 });
    }
  }
  if (linked) syncMediaDirectory(directory);
  for (const row of entities) {
    const target = sources.get(String(row.avatar));
    if (target) stmt(`UPDATE ${row.entity} SET avatar = ? WHERE id = ?`).run(target, row.id!);
  }
  for (const row of thumbnails) {
    const source = String(row.source);
    const targetSource = sources.get(source) ?? source;
    const thumbnail = changed.get(source);
    if (targetSource === source && !thumbnail) continue;
    stmt(`UPDATE avatar_thumbnails SET source = ?, thumbnail = ?, thumbnail_revision = ?
      WHERE source = ?`).run(
      targetSource,
      thumbnail?.path ?? row.thumbnail!,
      thumbnail?.revision ?? row.thumbnail_revision!,
      source,
    );
  }
}

/** Migration 65 only shortens the thumbnail prefix, preserving source and revision. */
export function migrateAvatarThumbnailPrefix(
  directory: string,
  stmt: (sql: string) => StatementSync,
): void {
  const changed = new Map<string, string>();
  for (const row of stmt(
    'SELECT source, thumbnail FROM avatar_thumbnails WHERE thumbnail IS NOT NULL',
  ).all()) {
    const path = String(row.thumbnail);
    if (!/^\/avatars\/avatar-thumb-(?:character|persona)-\d+-\d+-\d+\.jpg$/.test(path)) continue;
    const target = path.replace('/avatars/avatar-thumb-', '/avatars/thumb-');
    if (linkExistingMediaFile(directory, path, target)) changed.set(String(row.source), target);
  }
  if (!changed.size) return;
  syncMediaDirectory(directory);
  for (const [source, target] of changed) {
    stmt('UPDATE avatar_thumbnails SET thumbnail = ? WHERE source = ?').run(target, source);
  }
}
