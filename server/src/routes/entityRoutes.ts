import type { InvalidateEntity } from '@minitavern/shared';
import { stmt } from '../db.ts';
import { invalidate } from '../events.ts';
import { route } from '../router.ts';
import { clearSettingReference } from '../settingsStore.ts';
import type { SettingsReferenceKey } from '../settingsStore.ts';
import { discardSpeculativeSwipes } from '../speculation.ts';
import { bumpAllConversationRevisions } from '../conversationRevision.ts';
import { subscribedConversationIds } from '../events.ts';
import { broadcastTree } from '../sync.ts';
import {
  objectBody,
  optionalNullableId,
  optionalNullableString,
  optionalString,
  positiveId,
  requiredString,
} from '../validation.ts';
import type { JsonObject } from '../validation.ts';
import { optionalName, requireReference, rowById, rows } from './entityUtils.ts';
import type { EntityTable } from './entityUtils.ts';

export interface EntityField<T> {
  column: string;
  /** Returns the SQL value for this column; `cur` is undefined on create. */
  value: (b: JsonObject, cur: T | undefined) => string | number | null;
}

export interface EntityConfig<T extends { id: number }> {
  /** Table name; also the /api/<table> route prefix and the invalidate entity. */
  table: EntityTable & InvalidateEntity;
  toDto: (row: Record<string, unknown>) => T;
  /** Applied to every DTO leaving the API (e.g. strip secrets). */
  toPublic?: (dto: T) => T;
  fields: EntityField<T>[];
  /** Settings key cleared (with invalidate) when a row is deleted. */
  settingsRef?: SettingsReferenceKey;
  /** Entities that denormalize references to this one, re-fetched after a delete. */
  invalidateOnDelete?: InvalidateEntity[];
  onDelete?: (id: number) => void;
  /** Copies side-band state (e.g. avatar files) after a row was duplicated. */
  onDuplicate?: (sourceId: number, newId: number) => void;
}

export function nameField<T>(get: (cur: T) => string): EntityField<T> {
  return {
    column: 'name',
    value: (b, cur) =>
      cur === undefined
        ? requiredString(b, 'name')
        : optionalName(optionalString(b, 'name'), get(cur)),
  };
}

export function textField<T>(key: string, column: string, get: (cur: T) => string): EntityField<T> {
  return { column, value: (b, cur) => optionalString(b, key) ?? (cur ? get(cur) : '') };
}

export function nullableTextField<T>(
  key: string,
  column: string,
  get: (cur: T) => string | null,
): EntityField<T> {
  return {
    column,
    value: (b, cur) => {
      const value = optionalNullableString(b, key);
      return value === undefined ? (cur ? get(cur) : null) : value;
    },
  };
}

/** Foreign-key field: validates that a non-null id exists in `refTable`. */
export function refIdField<T>(
  key: string,
  column: string,
  refTable: EntityTable,
  get: (cur: T) => number | null,
): EntityField<T> {
  return {
    column,
    value: (b, cur) => {
      const value = optionalNullableId(b, key);
      requireReference(refTable, value, key);
      return value === undefined ? (cur ? get(cur) : null) : value;
    },
  };
}

/**
 * Registers the standard list/create/patch/delete routes for a simple entity
 * table. Patches merge field-by-field against the current row; patch and
 * delete discard speculative swipes since any entity can affect prompts.
 */
export function defineEntityRoutes<T extends { id: number }>(cfg: EntityConfig<T>): void {
  const publish = (dto: T): T => (cfg.toPublic ? cfg.toPublic(dto) : dto);
  const columns = cfg.fields.map((field) => field.column);
  const insertSql = `INSERT INTO ${cfg.table} (${columns.join(', ')}, created_at)
     VALUES (${columns.map(() => '?').join(', ')}, ?)`;
  const updateSql = `UPDATE ${cfg.table} SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;

  route.get(`/api/${cfg.table}`, () => rows(cfg.table).map(cfg.toDto).map(publish));

  route.post(`/api/${cfg.table}`, ({ body }) => {
    const b = objectBody(body);
    const values = cfg.fields.map((field) => field.value(b, undefined));
    const result = stmt(insertSql).run(...values, Date.now());
    invalidate(cfg.table);
    return publish(cfg.toDto(rowById(cfg.table, Number(result.lastInsertRowid))));
  });

  // Duplicates the full row (not just the field spec), so columns outside the
  // editable surface (secrets like api_key, import blobs like card_json) carry
  // over. The copy is referenced by nothing, so prompts are unaffected.
  route.post(`/api/${cfg.table}/:id/duplicate`, ({ params }) => {
    const id = positiveId(params.id);
    const row = rowById(cfg.table, id);
    const copyColumns = Object.keys(row).filter((c) => c !== 'id' && c !== 'created_at');
    const values = copyColumns.map((c) =>
      c === 'name' ? `${String(row.name)} (copy)` : (row[c] as string | number | null),
    );
    const result = stmt(
      `INSERT INTO ${cfg.table} (${copyColumns.join(', ')}, created_at)
       VALUES (${copyColumns.map(() => '?').join(', ')}, ?)`,
    ).run(...values, Date.now());
    const newId = Number(result.lastInsertRowid);
    cfg.onDuplicate?.(id, newId);
    invalidate(cfg.table);
    return publish(cfg.toDto(rowById(cfg.table, newId)));
  });

  route.patch(`/api/${cfg.table}/:id`, ({ params, body }) => {
    const id = positiveId(params.id);
    const cur = cfg.toDto(rowById(cfg.table, id));
    const b = objectBody(body);
    const values = cfg.fields.map((field) => field.value(b, cur));
    stmt(updateSql).run(...values, id);
    invalidate(cfg.table);
    discardSpeculativeSwipes();
    bumpAllConversationRevisions();
    for (const conversationId of subscribedConversationIds()) broadcastTree(conversationId);
    return publish(cfg.toDto(rowById(cfg.table, id)));
  });

  route.del(`/api/${cfg.table}/:id`, ({ params }) => {
    const id = positiveId(params.id);
    rowById(cfg.table, id);
    stmt(`DELETE FROM ${cfg.table} WHERE id = ?`).run(id);
    discardSpeculativeSwipes();
    bumpAllConversationRevisions();
    for (const conversationId of subscribedConversationIds()) broadcastTree(conversationId);
    cfg.onDelete?.(id);
    invalidate(cfg.table);
    for (const entity of cfg.invalidateOnDelete ?? []) invalidate(entity);
    if (cfg.settingsRef && clearSettingReference(cfg.settingsRef, id)) invalidate('settings');
  });
}
