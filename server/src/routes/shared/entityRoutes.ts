import { defineEntityTransfer } from './entityTransfer.ts';
import { createEntityWriter } from './entityWriter.ts';
import type { InvalidateEntity } from '@tinytavern/shared';
import { stmt } from '../../db/db.ts';
import { invalidate } from '../../realtime/events.ts';
import { route, HttpError } from '../../http/router.ts';
import { clearSettingReference } from '../../settings/settingsStore.ts';
import type { SettingsReferenceKey } from '../../settings/settingsStore.ts';
import { discardSpeculativeSwipes } from '../../generation/speculation.ts';
import { bumpAllConversationRevisions } from '../../conversations/conversationRevision.ts';
import { subscribedConversationIds } from '../../realtime/events.ts';
import { broadcastTree } from '../../realtime/sync.ts';
import {
  objectBody,
  optionalBoolean,
  optionalNullableId,
  optionalNullableString,
  optionalString,
  positiveId,
  requiredString,
} from '../../http/validation.ts';
import type { JsonObject } from '../../http/validation.ts';
import { optionalName, requireReference, rowById, rows } from './entityUtils.ts';
import type { EntityTable } from './entityUtils.ts';

const entityColumn = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

export interface EntityField<T> {
  column: string;
  /** SQL value; `cur` is undefined on create. */
  value: (b: JsonObject, cur: T | undefined) => string | number | null;
}

export interface EntityConfig<T extends { id: number }> {
  /** Table name; also the /api/<table> route prefix and the invalidate entity. */
  table: EntityTable & InvalidateEntity;
  toDto: (row: Record<string, unknown>) => T;
  /** Applied to every DTO leaving the API (e.g. strip secrets). */
  toPublic?: (dto: T) => T;
  fields: EntityField<T>[];
  /** Protected seed rows remain selectable and duplicable. */
  readOnlyColumn?: string;
  /** Settings key cleared (with invalidate) when a row is deleted. */
  settingsRef?: SettingsReferenceKey;
  /** Entities that denormalize references to this one, re-fetched after a delete. */
  invalidateOnDelete?: InvalidateEntity[];
  onDelete?: (id: number) => void;
  /** Copies external state (e.g. avatar files) after row duplication. */
  onDuplicate?: (sourceId: number, newId: number) => void;
}

/** Resolve scalar validation and SQL names once; exceptional fields retain route validators. */
export function entityFields<T extends { name: string }>(
  defaults: T,
  overrides: Partial<Record<keyof T, EntityField<T>['value']>> = {},
): EntityField<T>[] {
  return Object.entries(defaults).map(([key, fallback]) => {
    const boolean = typeof fallback === 'boolean';
    const parse = boolean
      ? optionalBoolean
      : fallback === null
        ? optionalNullableString
        : optionalString;
    return {
      column: key === 'genParams' ? 'gen_params_json' : entityColumn(key),
      value:
        overrides[key as keyof T] ??
        ((body, current) => {
          if (key === 'name')
            return current === undefined
              ? requiredString(body, key)
              : optionalName(optionalString(body, key), current.name);
          const requested = parse(body, key);
          const value =
            requested === undefined ? (current?.[key as keyof T] ?? fallback) : requested;
          return boolean ? Number(value) : (value as string | null);
        }),
    };
  });
}

export function referenceValue<T>(
  key: keyof T & string,
  table: EntityTable,
): EntityField<T>['value'] {
  return (body, current) => {
    const value = optionalNullableId(body, key);
    requireReference(table, value, key);
    return value === undefined ? ((current?.[key] as number | null) ?? null) : value;
  };
}

/**
 * Patches merge fields; patch/delete discard speculative swipes because entities affect prompts.
 */
export function defineEntityRoutes<T extends { id: number }>(cfg: EntityConfig<T>): void {
  const writer = createEntityWriter(cfg);
  defineEntityTransfer(cfg, writer);
  const publish = (dto: T): T => (cfg.toPublic ? cfg.toPublic(dto) : dto);

  route.get(`/api/${cfg.table}`, () => rows(cfg.table).map(cfg.toDto).map(publish));

  route.post(`/api/${cfg.table}`, ({ body }) => {
    const b = objectBody(body);
    const id = writer.insert(writer.values(b));
    invalidate(cfg.table);
    return publish(cfg.toDto(rowById(cfg.table, id)));
  });

  // Include noneditable columns (api_key, card_json); the unreferenced copy cannot affect prompts.
  route.post(`/api/${cfg.table}/:id/duplicate`, ({ params }) => {
    const id = positiveId(params.id);
    const row = rowById(cfg.table, id);
    const copyColumns = Object.keys(row).filter(
      (c) => c !== 'id' && c !== 'created_at' && c !== cfg.readOnlyColumn,
    );
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
    const row = rowById(cfg.table, id);
    if (cfg.readOnlyColumn && row[cfg.readOnlyColumn] === 1) {
      throw new HttpError(403, 'This default is read-only. Duplicate it to make changes.');
    }
    const b = objectBody(body);
    writer.update(id, writer.values(b, row));
    invalidate(cfg.table);
    discardSpeculativeSwipes();
    bumpAllConversationRevisions();
    for (const conversationId of subscribedConversationIds()) broadcastTree(conversationId);
    return publish(cfg.toDto(rowById(cfg.table, id)));
  });

  route.del(`/api/${cfg.table}/:id`, ({ params }) => {
    const id = positiveId(params.id);
    const row = rowById(cfg.table, id);
    if (cfg.readOnlyColumn && row[cfg.readOnlyColumn] === 1) {
      throw new HttpError(403, 'This default is read-only and cannot be deleted.');
    }
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
