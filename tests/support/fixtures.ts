import type { SQLQueryBindings } from 'bun:sqlite';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { stmt } = await import('../../server/src/db.ts');

/** Insert fixture rows directly, independently of the operation being tested. */
export function insertFixture(table: string, values: Record<string, SQLQueryBindings>): number {
  const columns = Object.keys(values);
  return Number(
    stmt(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    ).run(...Object.values(values)).lastInsertRowid,
  );
}

export const conversationFixture = (values: Record<string, SQLQueryBindings> = {}) =>
  insertFixture('conversations', { title: 'Test', created_at: 1, updated_at: 1, ...values });

export const messageFixture = (
  conversationId: number,
  values: Record<string, SQLQueryBindings> = {},
) =>
  insertFixture('messages', {
    conversation_id: conversationId,
    role: 'assistant',
    created_at: 1,
    ...values,
  });
