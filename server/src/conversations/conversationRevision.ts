import { stmt } from '../db/db.ts';

export function getConversationRevision(conversationId: number): number {
  const row = stmt('SELECT mutation_revision FROM conversations WHERE id = ?').get(conversationId) as
    { mutation_revision: number } | undefined;
  return row?.mutation_revision ?? 0;
}

export function bumpConversationRevision(conversationId: number): number {
  const row = stmt(
    `UPDATE conversations SET mutation_revision = mutation_revision + 1
     WHERE id = ? RETURNING mutation_revision`,
  ).get(conversationId) as { mutation_revision: number } | undefined;
  return row?.mutation_revision ?? 0;
}

/** Invalidates every conversation after a shared prompt entity/default changes. */
export function bumpAllConversationRevisions(): void {
  stmt('UPDATE conversations SET mutation_revision = mutation_revision + 1').run();
}
