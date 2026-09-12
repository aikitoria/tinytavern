import type { Message } from '@tinytavern/shared';
import { deleteMessageSubtrees, stmt } from '../db/db.ts';
import {
  activeGenerationToken,
  hasActiveGeneration,
  isBackgroundGeneration,
  startGeneration,
  stopBackgroundGenerations,
} from './generation.ts';
import { getConversation } from '../conversations/conversationStore.ts';
import { hasConversationSubscribers, subscribedConversationIds } from '../realtime/events.ts';
import { getSettingsPreferences } from '../settings/settingsStore.ts';
import { broadcastTree } from '../realtime/sync.ts';
import { collectSubtreeImages, deleteImageFiles } from '../media/images.ts';
import { bumpConversationRevision } from '../conversations/conversationRevision.ts';
import {
  appendMessage,
  deleteMessage,
  getActiveLeafId,
  getMessage,
  getPathToMessage,
  setActiveLeaf,
} from '../conversations/tree.ts';

const retryTimers = new Map<number, NodeJS.Timeout>();

const RETRY_BACKOFF_MS = Number(process.env.SPECULATION_BACKOFF_MS ?? (process.env.E2E_BASE ? 50 : 500));

/** Removes an in-flight speculative sibling before a foreground action takes over. */
export function cancelBackgroundSwipe(conversationId: number): boolean {
  cancelSpeculativeRetries(conversationId);
  const mid = stopBackgroundGenerations(conversationId);
  if (mid == null) return false;
  deleteMessage(mid);
  // Broadcast even if the caller later rejects; microtask coalescing avoids duplicate frames.
  broadcastTree(conversationId);
  return true;
}

/** Main chats keep one unread sibling ready; media prompt replies are generated on demand. */
export function prepareNextSwipe(messageId: number, retryAttempt = 0): void {
  const message = getMessage(messageId);
  if (!message || message.role !== 'assistant') return;
  if (!hasConversationSubscribers(message.conversationId)) return;
  const conversation = getConversation(message.conversationId);
  if (conversation.promptMode === 'media' || conversation.activeLeafId !== message.id) return;
  const settings = getSettingsPreferences();
  if (!settings.backgroundSwipeGeneration) return;
  const parallel =
    settings.parallelBackgroundSwipeGeneration &&
    message.status === 'streaming' &&
    activeGenerationToken(message.id) != null &&
    !isBackgroundGeneration(message.id);
  if (message.status !== 'done' && !parallel) return;
  // Only the visible reply may overlap its speculative sibling; another
  // assistant, tool or speculative stream still occupies the second slot.
  if (hasActiveGeneration(conversation.id, parallel ? message.id : undefined)) return;
  if (
    conversation.characterId != null &&
    stmt('SELECT 1 FROM characters WHERE id = ? AND disable_background_swipe_generation = 1').get(
      conversation.characterId,
    )
  )
    return;

  if (nextUnreadSibling(message) != null) return;

  cancelSpeculativeRetries(conversation.id);

  const speculative = appendMessage(
    conversation.id,
    'assistant',
    '',
    message.parentId,
    'streaming',
    null,
    message.name,
    false,
    'speculative',
  );
  startGeneration(getConversation(conversation.id), speculative.id, undefined, {
    background: true,
    onDone: () => {
      if (hasConversationSubscribers(conversation.id)) prepareNextSwipe(speculative.id);
    },
    onError: () => {
      const row = getMessage(speculative.id);
      if (row?.generationKind !== 'speculative') {
        if (getActiveLeafId(conversation.id) === speculative.id) cancelBackgroundSwipe(conversation.id);
        return;
      }
      deleteMessage(speculative.id);
      broadcastTree(conversation.id);
      if (!hasConversationSubscribers(conversation.id)) return;
      scheduleSpeculativeRetry(conversation.id, retryAttempt + 1, () => {
        // Re-check at fire time: the last client may have left during the backoff.
        if (hasConversationSubscribers(conversation.id)) prepareNextSwipe(message.id, retryAttempt + 1);
      });
    },
  });
  broadcastTree(conversation.id);
}

export function prepareActiveSwipe(conversationId: number): void {
  const leaf = getActiveLeafId(conversationId);
  if (leaf != null) prepareNextSwipe(leaf);
}

/** Restores the one-ahead invariant only for conversations that still have viewers. */
export function prepareSubscribedSwipes(conversationId?: number): void {
  if (conversationId != null) {
    if (hasConversationSubscribers(conversationId)) prepareActiveSwipe(conversationId);
    return;
  }
  for (const id of subscribedConversationIds()) prepareActiveSwipe(id);
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
function scheduleSpeculativeRetry(conversationId: number, attempt: number, retry: () => void): void {
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
       SELECT DISTINCT image FROM message_media_files WHERE message_id IN (SELECT id FROM doomed)`,
    ).all(cid, cid) as { image: string }[]
  ).map((r) => r.image);
  deleteMessageSubtrees(
    stmt("SELECT id FROM messages WHERE generation_kind = 'speculative' AND (? IS NULL OR conversation_id = ?)")
      .all(cid, cid)
      .map((row) => Number(row.id)),
  );
  for (const row of rows) bumpConversationRevision(row.conversation_id);
  deleteImageFiles(doomedImages);
  for (const row of rows) {
    const path = activePaths.get(row.conversation_id) ?? [];
    const survivor = path.findLast((messageId) => stmt('SELECT id FROM messages WHERE id = ?').get(messageId));
    if (getActiveLeafId(row.conversation_id) != null && survivor !== path.at(-1)) {
      setActiveLeaf(row.conversation_id, survivor ?? null);
    }
    broadcastTree(row.conversation_id);
  }
  queueMicrotask(() => prepareSubscribedSwipes(conversationId));
}

export function markSwipeRead(messageId: number): void {
  stmt("UPDATE messages SET generation_kind = 'normal' WHERE id = ?").run(messageId);
}

/** Prunes failed speculative siblings before choosing the next sibling. */
export function nextUnreadSibling(message: Message): number | null {
  const roots = stmt(`SELECT id FROM messages
    WHERE conversation_id = ? AND parent_id IS ? AND id > ?
      AND generation_kind = 'speculative' AND status IN ('error', 'stopped')`)
    .all(message.conversationId, message.parentId, message.id)
    .map((row) => Number(row.id));
  const doomedImages = roots.flatMap(collectSubtreeImages);
  const removed = deleteMessageSubtrees(roots);
  if (removed) bumpConversationRevision(message.conversationId);
  deleteImageFiles(doomedImages);
  if (removed) broadcastTree(message.conversationId);
  const next = stmt(
    `SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ? AND id > ?
     ORDER BY id LIMIT 1`,
  ).get(message.conversationId, message.parentId, message.id) as { id: number } | undefined;
  return next?.id ?? null;
}
