import { requireExpectedActiveLeaf } from '../concurrency.ts';
import { objectBody, optionalNullableId, optionalNumber } from '../validation.ts';

export function requireBodyPrecondition(conversationId: number, body: unknown): void {
  const b = objectBody(body);
  requireExpectedActiveLeaf(
    conversationId,
    optionalNullableId(b, 'expectedActiveLeafId'),
    optionalNumber(b, 'expectedMutationRevision'),
  );
}

export function requireQueryPrecondition(conversationId: number, url: string | undefined): void {
  const query = new URL(url ?? '/', 'http://x').searchParams;
  const leaf = query.get('expectedActiveLeafId');
  const revision = query.get('expectedMutationRevision');
  requireExpectedActiveLeaf(
    conversationId,
    leaf === 'null' ? null : leaf == null ? undefined : Number(leaf),
    revision == null ? undefined : Number(revision),
  );
}
