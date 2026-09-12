import { stmt } from '../../db/db.ts';
import type { JsonObject } from '../../http/validation.ts';
import type { EntityConfig } from './entityRoutes.ts';

type Values = (string | number | null)[];

export interface EntityWriter {
  values(body: JsonObject, current?: Record<string, unknown>): Values;
  insert(values: Values): number;
  update(id: number, values: Values): void;
}

/** CRUD and bulk transfer share field validation and precomputed write SQL. */
export function createEntityWriter<T extends { id: number }>(cfg: EntityConfig<T>): EntityWriter {
  const columns = cfg.fields.map((field) => field.column);
  const insertSql = `INSERT INTO ${cfg.table} (${columns.join(', ')}, created_at)
    VALUES (${columns.map(() => '?').join(', ')}, ?)`;
  const updateSql = `UPDATE ${cfg.table} SET ${columns.map((column) => `${column} = ?`).join(', ')}${cfg.revisionColumn ? `, ${cfg.revisionColumn} = ${cfg.revisionColumn} + 1` : ''} WHERE id = ?`;
  return {
    values(body, current) {
      const dto = current ? cfg.toDto(current) : undefined;
      body = cfg.prepare?.(body, dto) ?? body;
      return cfg.fields.map((field) => field.value(body, dto));
    },
    insert(values) {
      return Number(stmt(insertSql).run(...values, Date.now()).lastInsertRowid);
    },
    update(id, values) {
      stmt(updateSql).run(...values, id);
    },
  };
}
