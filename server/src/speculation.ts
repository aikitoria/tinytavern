import type { Message } from '@minitavern/shared';
import { stmt } from './db.ts';
import { stopBackgroundGenerations } from './generation.ts';
import { broadcastTree } from './sync.ts';
import { deleteImageFiles } from './images.ts';
import { bumpConversationRevision } from './conversationRevision.ts';
import { getActiveLeafId, getPathToMessage, setActiveLeaf } from './tree.ts';

const retryTimers = new Map<number, NodeJS.Timeout>();
let refillHandler: ((conversationId?: number) => void) | null = null;

const RETRY_BACKOFF_MS = Number(
  process.env.SPECULATION_BACKOFF_MS ?? (process.env.E2E_BASE ? 50 : 500),
);

/** Installed at startup to lazily restore the one-ahead invariant for visible chats. */
export function setSpeculativeRefillHandler(handler: (conversationId?: number) => void): void {
  refillHandler = handler;
}

/** Cancels delayed refill attempts after the leaf or generation context changes. */
export function cancelSpeculativeRetries(conversationId?: number): void {
  if (conversationId != null) {
    const timer = retryTimers.get(conversationId);
    if (timer) clearTimeout(timer);
    retryTimers.delete(conversationId);
    return;
  }
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
}

/** Bound endpoint failures; explicit user actions reset the budget to attempt 0. */
const MAX_RETRY_ATTEMPTS = 8;

/** Keeps retrying failed background requests without creating concurrent refills. */
export function scheduleSpeculativeRetry(
  conversationId: number,
  attempt: number,
  retry: () => void,
): void {
  cancelSpeculativeRetries(conversationId);
  if (attempt > MAX_RETRY_ATTEMPTS) {
    console.warn(
      `[speculation] giving up on background swipe for conversation ${conversationId} after ${MAX_RETRY_ATTEMPTS} attempts`,
    );
    return;
  }
  const delay = Math.min(RETRY_BACKOFF_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 6), 30_000);
  retryTimers.set(
    conversationId,
    setTimeout(() => {
      retryTimers.delete(conversationId);
      retry();
    }, delay),
  );
}

/** Removes unread speculative siblings — one conversation's, or all when omitted. */
export function discardSpeculativeSwipes(conversationId?: number): void {
  cancelSpeculativeRetries(conversationId);
  stopBackgroundGenerations(conversationId);
  const cid = conversationId ?? null;
  const rows = stmt(
    `SELECT DISTINCT conversation_id FROM messages
       WHERE generation_kind = 'speculative' AND (? IS NULL OR conversation_id = ?)`,
  ).all(cid, cid) as { conversation_id: number }[];
  // Preserve paths to repair active_leaf_id if legacy bugs left an active speculative row.
  const activePaths = new Map(
    rows.map(({ conversation_id }) => [
      conversation_id,
      getPathToMessage(getActiveLeafId(conversation_id)).map((message) => message.id),
    ]),
  );
  // render-image is role-agnostic, so speculative rows may own images too.
  const doomedImages = (
    stmt(
      `WITH RECURSIVE doomed(id) AS (
         SELECT id FROM messages
         WHERE generation_kind = 'speculative' AND (? IS NULL OR conversation_id = ?)
         UNION
         SELECT m.id FROM messages m JOIN doomed d ON m.parent_id = d.id
       )
       SELECT DISTINCT j.value AS image FROM messages m, json_each(m.images_json) j
       WHERE m.id IN (SELECT id FROM doomed)`,
    ).all(cid, cid) as { image: string }[]
  ).map((r) => r.image);
  stmt(
    "DELETE FROM messages WHERE generation_kind = 'speculative' AND (? IS NULL OR conversation_id = ?)",
  ).run(cid, cid);
  for (const row of rows) bumpConversationRevision(row.conversation_id);
  deleteImageFiles(doomedImages);
  for (const row of rows) {
    const path = activePaths.get(row.conversation_id) ?? [];
    const survivor = path.findLast((messageId) =>
      stmt('SELECT id FROM messages WHERE id = ?').get(messageId),
    );
    if (getActiveLeafId(row.conversation_id) != null && survivor !== path.at(-1)) {
      setActiveLeaf(row.conversation_id, survivor ?? null);
    }
    broadcastTree(row.conversation_id);
  }
  queueMicrotask(() => refillHandler?.(conversationId));
}

export function markSwipeRead(messageId: number): void {
  stmt("UPDATE messages SET generation_kind = 'normal' WHERE id = ?").run(messageId);
}

/** Prunes failed speculative siblings before choosing the next sibling. */
export function nextUnreadSibling(message: Message): number | null {
  const doomedImages = (
    stmt(
      `SELECT j.value AS image FROM messages m, json_each(m.images_json) j
       WHERE m.conversation_id = ? AND m.parent_id IS ? AND m.id > ?
       AND m.generation_kind = 'speculative' AND m.status IN ('error', 'stopped')`,
    ).all(message.conversationId, message.parentId, message.id) as { image: string }[]
  ).map((r) => r.image);
  const removed = stmt(
    `DELETE FROM messages WHERE conversation_id = ? AND parent_id IS ? AND id > ?
     AND generation_kind = 'speculative' AND status IN ('error', 'stopped')`,
  ).run(message.conversationId, message.parentId, message.id);
  if (removed.changes) bumpConversationRevision(message.conversationId);
  deleteImageFiles(doomedImages);
  if (removed.changes) broadcastTree(message.conversationId);
  const next = stmt(
    `SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ? AND id > ?
     ORDER BY id LIMIT 1`,
  ).get(message.conversationId, message.parentId, message.id) as { id: number } | undefined;
  return next?.id ?? null;
}
