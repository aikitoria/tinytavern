import {
  MEDIA_SETTINGS_TABLES,
  copySettingsData,
  type MediaLibraryVersions,
  type MediaSettingsCollections,
  type MediaSettingsTable,
} from '@tinytavern/shared';
import { stmt } from '../db/db.ts';
import { mediaEntityRows, type MediaEntityTable } from './mediaEntities.ts';

export const settingsEpoch = crypto.randomUUID();
const cached = new Map<MediaSettingsTable, { revision: number; rows: unknown[] }>();

export function clearMediaLibraryCache(): void {
  cached.clear();
}

export function mediaLibraryVersions(): MediaLibraryVersions {
  return Object.fromEntries(
    stmt('SELECT table_name, revision FROM media_library_versions')
      .all()
      .map((row) => [String(row.table_name), Number(row.revision)]),
  ) as MediaLibraryVersions;
}

/** Only changed collections are queried, decoded and sent; versions come from the same synchronous snapshot. */
export function mediaLibraryCollections(
  versions: MediaLibraryVersions,
  known: Partial<MediaLibraryVersions> = {},
): Partial<MediaSettingsCollections> {
  const collections: Partial<MediaSettingsCollections> = {};
  for (const table of MEDIA_SETTINGS_TABLES) {
    const revision = versions[table];
    if (known[table] === revision) {
      continue;
    }
    let entry = cached.get(table);
    if (entry?.revision !== revision) {
      const rows = table.endsWith('_folders')
        ? stmt(`SELECT id, name FROM ${table} ORDER BY name COLLATE NOCASE, id`)
            .all()
            .map((row) => ({ id: String(row.id), name: String(row.name) }))
        : mediaEntityRows(table as MediaEntityTable);
      const projected =
        table === 'avatar_prompts'
          ? rows.map((row) => {
              const { folderId, ...preset } = row as Record<string, unknown>;
              return preset;
            })
          : rows;
      entry = { revision, rows: projected };
      cached.set(table, entry);
    }
    // Consumers can edit metadata; they must never mutate the cached native collection.
    Object.assign(collections, { [table]: copySettingsData(entry.rows) });
  }
  return collections;
}
