import type { GenerationKind, Message, MessageStatus, Role, TreeNode } from '@minitavern/shared';
import { stmt, toMessage, transaction } from './db.ts';
import { collectMessageImages, collectSubtreeImages, deleteImageFiles } from './images.ts';
import { bumpConversationRevision } from './conversationRevision.ts';

// Messages created or edited since the last tree broadcast, per conversation.
// The coalesced broadcast drains this to know which full bodies to include.
const dirtyMessages = new Map<number, Set<number>>();

export function markMessageDirty(conversationId: number, messageId: number): void {
  let set = dirtyMessages.get(conversationId);
  if (!set) {
    set = new Set();
    dirtyMessages.set(conversationId, set);
  }
  set.add(messageId);
}

export function takeDirtyMessageIds(conversationId: number): Set<number> {
  const set = dirtyMessages.get(conversationId) ?? new Set<number>();
  dirtyMessages.delete(conversationId);
  return set;
}

interface MsgRow {
  id: number;
  conversation_id: number;
  parent_id: number | null;
  active_child_id: number | null;
}

function getRow(id: number): MsgRow | undefined {
  return stmt(
    'SELECT id, conversation_id, parent_id, active_child_id FROM messages WHERE id = ?',
  ).get(id) as MsgRow | undefined;
}

export function getMessage(id: number): Message | undefined {
  const row = stmt('SELECT * FROM messages WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? toMessage(row) : undefined;
}

export function getTreeMessages(conversationId: number): Message[] {
  const rows = stmt('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(
    conversationId,
  ) as Record<string, unknown>[];
  return rows.map(toMessage);
}

/** Structure-only view of the tree (no bodies) for incremental patches. */
export function getTreeNodes(conversationId: number): TreeNode[] {
  const rows = stmt(
    `SELECT id, parent_id, active_child_id, status, generation_kind, generation_token
     FROM messages WHERE conversation_id = ? ORDER BY id`,
  ).all(conversationId) as {
    id: number;
    parent_id: number | null;
    active_child_id: number | null;
    status: MessageStatus;
    generation_kind: GenerationKind;
    generation_token: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    activeChildId: r.active_child_id,
    status: r.status,
    generationKind: r.generation_kind,
    generationToken: r.generation_token,
  }));
}

export function getActiveLeafId(conversationId: number): number | null {
  const row = stmt('SELECT active_leaf_id FROM conversations WHERE id = ?').get(conversationId) as
    { active_leaf_id: number | null } | undefined;
  return row?.active_leaf_id ?? null;
}

/** Active path, root -> leaf, computed by walking parent pointers up from the leaf. */
export function getActivePath(conversationId: number): Message[] {
  return getPathToMessage(getActiveLeafId(conversationId));
}

/** Path from the root through a specific message, independent of the active branch. */
export function getPathToMessage(messageId: number | null): Message[] {
  if (messageId == null) return [];
  // Single recursive query, leaf -> root; reversed in JS.
  const rows = stmt(
    `WITH RECURSIVE path AS (
       SELECT * FROM messages WHERE id = ?
       UNION ALL
       SELECT m.* FROM messages m JOIN path p ON m.id = p.parent_id
     )
     SELECT * FROM path`,
  ).all(messageId) as Record<string, unknown>[];
  return rows.map(toMessage).reverse();
}

/**
 * Sets the conversation's active leaf and repoints active_child_id along the
 * whole new path. That invariant is what lets a later branch switch restore
 * the deep chain that was active beneath any node.
 */
export function setActiveLeaf(conversationId: number, leafId: number | null): void {
  // Deliberately does NOT touch updated_at: branch switching is reading, not
  // writing — content-creating routes bump the timestamp themselves.
  stmt('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run(leafId, conversationId);
  bumpConversationRevision(conversationId);
  if (leafId == null) return;
  // One statement: each ancestor's active_child_id points at its child on the leaf's path.
  stmt(
    `WITH RECURSIVE path(id, parent_id) AS (
       SELECT id, parent_id FROM messages WHERE id = ?
       UNION ALL
       SELECT m.id, m.parent_id FROM messages m JOIN path p ON m.id = p.parent_id
     )
     UPDATE messages
     SET active_child_id = (SELECT p.id FROM path p WHERE p.parent_id = messages.id)
     WHERE id IN (SELECT parent_id FROM path WHERE parent_id IS NOT NULL)`,
  ).run(leafId);
}

/** Follows active_child_id pointers down from a node to the deepest remembered descendant. */
export function descendToLeaf(fromId: number): number {
  // The parent check guards against a stale active_child_id pointing outside the subtree.
  const row = stmt(
    `WITH RECURSIVE down(id, active_child_id, depth) AS (
       SELECT id, active_child_id, 0 FROM messages WHERE id = ?
       UNION ALL
       SELECT m.id, m.active_child_id, d.depth + 1
       FROM messages m JOIN down d ON m.id = d.active_child_id AND m.parent_id = d.id
     )
     SELECT id FROM down ORDER BY depth DESC LIMIT 1`,
  ).get(fromId) as { id: number } | undefined;
  return row?.id ?? fromId;
}

/** Branch switch: make `messageId` the active sibling, restoring its remembered subtree path. */
export function activateMessage(messageId: number): number {
  const row = getRow(messageId);
  if (!row) throw new Error(`message ${messageId} not found`);
  return transaction(() => {
    const leaf = descendToLeaf(messageId);
    setActiveLeaf(row.conversation_id, leaf);
    return leaf;
  });
}

export function appendMessage(
  conversationId: number,
  role: Role,
  content: string,
  parentId: number | null,
  status: MessageStatus = 'done',
  model: string | null = null,
  name: string | null = null,
  activate = true,
  generationKind: GenerationKind = 'normal',
): Message {
  return transaction(() => {
    const result = stmt(
      `INSERT INTO messages
         (conversation_id, parent_id, role, content, status, model, name, generation_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      conversationId,
      parentId,
      role,
      content ? content.trim() : '',
      status,
      model,
      name,
      generationKind,
      Date.now(),
    );
    const id = Number(result.lastInsertRowid);
    markMessageDirty(conversationId, id);
    if (activate) setActiveLeaf(conversationId, id);
    else bumpConversationRevision(conversationId);
    return getMessage(id)!;
  });
}

/** Inserts a message as the sole child immediately after an existing node.
 * Every former child branch moves below the inserted message, and the source's
 * remembered active child moves with them. If the source already had a visible
 * continuation, its deep active leaf stays active; otherwise the insertion
 * becomes the new leaf. */
export function insertMessageAfter(
  conversationId: number,
  role: Role,
  content: string,
  afterId: number,
  status: MessageStatus = 'done',
  model: string | null = null,
  name: string | null = null,
  generationKind: GenerationKind = 'normal',
): Message {
  return transaction(() => {
    const after = getRow(afterId);
    if (!after || after.conversation_id !== conversationId) {
      throw new Error(`message ${afterId} not found in conversation ${conversationId}`);
    }
    const formerChildren = (
      stmt('SELECT id FROM messages WHERE conversation_id = ? AND parent_id = ?').all(
        conversationId,
        afterId,
      ) as { id: number }[]
    ).map((row) => row.id);
    const rememberedChild = formerChildren.includes(after.active_child_id ?? -1)
      ? after.active_child_id
      : (formerChildren.at(-1) ?? null);
    const leaf = getActiveLeafId(conversationId);

    const result = stmt(
      `INSERT INTO messages
         (conversation_id, parent_id, role, content, status, model, name,
          active_child_id, generation_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      conversationId,
      afterId,
      role,
      content ? content.trim() : '',
      status,
      model,
      name,
      rememberedChild,
      generationKind,
      Date.now(),
    );
    const id = Number(result.lastInsertRowid);
    markMessageDirty(conversationId, id);

    stmt(
      `UPDATE messages SET parent_id = ?
       WHERE conversation_id = ? AND parent_id = ? AND id != ?`,
    ).run(id, conversationId, afterId, id);
    stmt('UPDATE messages SET active_child_id = ? WHERE id = ?').run(id, afterId);

    // Re-running setActiveLeaf repairs active-child pointers through the new
    // link while preserving an existing deep continuation.
    setActiveLeaf(conversationId, leaf == null || leaf === afterId ? id : leaf);
    return getMessage(id)!;
  });
}

function newestChildId(conversationId: number, parentId: number | null): number | null {
  const row = stmt(
    'SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ? ORDER BY id DESC LIMIT 1',
  ).get(conversationId, parentId) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Splices one visible block while already inside the caller's transaction. */
function spliceMessageInTransaction(messageId: number): string[] {
  const row = getRow(messageId);
  if (!row) return [];
  const {
    conversation_id: conversationId,
    parent_id: parentId,
    active_child_id: activeChildId,
  } = row;
  const siblingIds = (
    stmt('SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ? AND id != ?').all(
      conversationId,
      parentId,
      messageId,
    ) as { id: number }[]
  ).map((r) => r.id);
  // The message's own images plus every doomed sibling subtree's, collected
  // before the deletes cascade; unlinked only after the commit succeeds.
  const doomedImages = [
    ...collectMessageImages(messageId),
    ...siblingIds.flatMap((id) => collectSubtreeImages(id)),
  ];
  const leaf = getActiveLeafId(conversationId);
  // Order matters: drop the sibling group first (their subtrees cascade),
  // THEN reparent this message's children — reparenting first would put
  // them into the very group being deleted.
  for (const id of siblingIds) stmt('DELETE FROM messages WHERE id = ?').run(id);
  stmt('UPDATE messages SET parent_id = ? WHERE parent_id = ?').run(parentId, messageId);
  stmt('DELETE FROM messages WHERE id = ?').run(messageId);
  // Re-derive the leaf: descend through the removed node's remembered child
  // when it was the leaf itself; keep it if it survived (the visible chain);
  // otherwise it died inside a sibling subtree — fall back near the parent.
  let newLeaf: number | null;
  if (leaf === messageId) {
    newLeaf = activeChildId != null ? descendToLeaf(activeChildId) : parentId;
  } else if (leaf != null && getRow(leaf)) {
    newLeaf = leaf;
  } else {
    const fallback = parentId ?? newestChildId(conversationId, null);
    newLeaf = fallback != null ? descendToLeaf(fallback) : null;
  }
  setActiveLeaf(conversationId, newLeaf);
  return doomedImages;
}

/**
 * "Remove this block from the screen" — the delete button's semantics. Each
 * selected message AND its sibling swipes are deleted (an alternative's
 * subtree dies with it), while the visible continuation below the range
 * reattaches above it. A contiguous range is committed atomically, and image
 * files are unlinked only after that commit succeeds.
 */
export function spliceMessages(messageIds: readonly number[]): void {
  const doomedImages: string[] = [];
  transaction(() => {
    for (const messageId of messageIds) {
      doomedImages.push(...spliceMessageInTransaction(messageId));
    }
  });
  deleteImageFiles(doomedImages);
}

export function spliceMessage(messageId: number): void {
  spliceMessages([messageId]);
}

/**
 * Moves a message's block one step down the visible chain by rotating it with
 * its active child's block: the child group rises to the parent, the whole
 * sibling group of `messageId` (its swipes included) reattaches under the
 * risen child, and the child's former children reattach under `messageId`.
 * Returns false when there is no block below.
 */
export function rotateDown(messageId: number): boolean {
  const row = getRow(messageId);
  if (!row) return false;
  const { conversation_id: conversationId, parent_id: parentId } = row;
  // active_child_id can be stale (rotations leave the moved message pointing
  // at its former child, now its parent) — trusting it here would corrupt the
  // tree, so verify it is a real child before use.
  const remembered =
    row.active_child_id != null && getRow(row.active_child_id)?.parent_id === messageId
      ? row.active_child_id
      : null;
  const childB = remembered ?? newestChildId(conversationId, messageId);
  if (childB == null) return false;
  // The risen child's remembered descent becomes the moved message's: those
  // grandchildren are about to become its children.
  const bActiveChild = getRow(childB)!.active_child_id;

  const groupIds = (sql: string, ...binds: (number | null)[]) =>
    (stmt(sql).all(...binds) as { id: number }[]).map((r) => r.id);
  const reparent = (newParent: number | null, ids: number[]) =>
    stmt('UPDATE messages SET parent_id = ? WHERE id IN (SELECT value FROM json_each(?))').run(
      newParent,
      JSON.stringify(ids),
    );

  transaction(() => {
    const leaf = getActiveLeafId(conversationId);
    // Captured up front — the three reparents would otherwise see each other's writes.
    const groupA = groupIds(
      'SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ?',
      conversationId,
      parentId,
    );
    const groupB = groupIds('SELECT id FROM messages WHERE parent_id = ?', messageId);
    const groupC = groupIds('SELECT id FROM messages WHERE parent_id = ?', childB);
    reparent(messageId, groupC);
    reparent(parentId, groupB);
    reparent(childB, groupA);
    // Repair the moved message's remembered child (its old one is now its
    // parent): continue through the risen child's former descent.
    stmt('UPDATE messages SET active_child_id = ? WHERE id = ?').run(bActiveChild, messageId);
    // The old leaf stays the leaf unless it was the risen child itself (then
    // the moved message, now the bottom block, becomes the leaf).
    setActiveLeaf(conversationId, leaf === childB ? messageId : leaf);
  });
  return true;
}

/** Deletes one message swipe and its whole subtree (FK cascade), repairing the
 * active path if it contained that subtree. Used both by the explicit
 * Delete-swipe action and by speculative-swipe cleanup. */
export function deleteMessage(messageId: number): void {
  const row = getRow(messageId);
  if (!row) return;
  const { conversation_id: conversationId, parent_id: parentId } = row;
  // Collect before the delete cascades; unlink only after the commit succeeds.
  const doomedImages = collectSubtreeImages(messageId);
  transaction(() => {
    stmt('DELETE FROM messages WHERE id = ?').run(messageId);
    const leaf = getActiveLeafId(conversationId);
    if (leaf != null && !getRow(leaf)) {
      const sibling = newestChildId(conversationId, parentId);
      const replacementLeaf = sibling != null ? descendToLeaf(sibling) : parentId;
      if (replacementLeaf != null) {
        // A completed prepared swipe is still tagged speculative until it is
        // explicitly revealed. Delete-swipe can reveal it indirectly, so
        // normalize every speculative node on the replacement path before a
        // later context invalidation bulk-deletes it and its descendants.
        stmt(
          `WITH RECURSIVE path(id, parent_id) AS (
             SELECT id, parent_id FROM messages WHERE id = ?
             UNION ALL
             SELECT m.id, m.parent_id FROM messages m JOIN path p ON m.id = p.parent_id
           )
           UPDATE messages SET generation_kind = 'normal'
           WHERE generation_kind = 'speculative' AND id IN (SELECT id FROM path)`,
        ).run(replacementLeaf);
      }
      setActiveLeaf(conversationId, replacementLeaf);
    } else bumpConversationRevision(conversationId);
  });
  deleteImageFiles(doomedImages);
}
