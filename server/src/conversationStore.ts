import type { Conversation } from '@tinytavern/shared';
import { stmt, toConversation } from './db.ts';
import { HttpError } from './router.ts';

export function getConversation(id: number): Conversation {
  const row = stmt('SELECT * FROM conversations WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, `conversation ${id} not found`);
  return toConversation(row);
}

export function touchConversation(id: number): void {
  stmt('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}
