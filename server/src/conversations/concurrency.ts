import { stmt } from '../db/db.ts';
import { HttpError } from '../http/router.ts';
import { broadcastTree } from '../realtime/sync.ts';

export function requireExpectedActiveLeaf(
  conversationId: number,
  expectedActiveLeafId: number | null | undefined,
  expectedMutationRevision: number | undefined,
): void {
  if (expectedActiveLeafId === undefined) {
    throw new HttpError(400, 'expectedActiveLeafId is required');
  }
  if (!Number.isSafeInteger(expectedMutationRevision) || expectedMutationRevision! < 0) {
    throw new HttpError(400, 'expectedMutationRevision is required');
  }
  const row = stmt('SELECT active_leaf_id, mutation_revision FROM conversations WHERE id = ?').get(conversationId) as
    { active_leaf_id: number | null; mutation_revision: number } | undefined;
  if (!row) throw new HttpError(404, `conversation ${conversationId} not found`);
  if (row.active_leaf_id !== expectedActiveLeafId || row.mutation_revision !== expectedMutationRevision) {
    broadcastTree(conversationId);
    throw new HttpError(409, 'conversation branch changed; please try again');
  }
}
