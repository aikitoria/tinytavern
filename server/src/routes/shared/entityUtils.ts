import { stmt } from '../../db/db.ts';
import { HttpError } from '../../http/router.ts';

export type EntityTable =
  'presets' | 'templates' | 'personas' | 'characters' | 'character_folders' | 'endpoints';

export function rows(table: EntityTable): Record<string, unknown>[] {
  return stmt(`SELECT * FROM ${table} ORDER BY name COLLATE NOCASE, id`).all() as Record<
    string,
    unknown
  >[];
}

export function rowById(table: EntityTable, id: number): Record<string, unknown> {
  const row = stmt(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
    Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, `${table.slice(0, -1)} ${id} not found`);
  return row;
}

export function requireReference(
  table: EntityTable,
  id: number | null | undefined,
  key: string,
): void {
  if (id != null && !stmt(`SELECT id FROM ${table} WHERE id = ?`).get(id)) {
    throw new HttpError(400, `${key} does not exist`);
  }
}

export function optionalName(value: string | undefined, current?: string): string {
  if (value === undefined) return current ?? '';
  if (!value.trim()) throw new HttpError(400, 'name is required');
  return value.trim();
}
