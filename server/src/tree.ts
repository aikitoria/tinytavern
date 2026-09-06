import type { GenerationKind, Message, MessageStatus, Role, TreeNode } from '@minitavern/shared';
import { stmt, toMessage, transaction } from './db.ts';
import { collectMessageImages, collectSubtreeImages, deleteImageFiles } from './images.ts';
import { bumpConversationRevision } from './conversationRevision.ts';

// Full bodies owed to the next coalesced tree broadcast, per conversation.
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

/** Active path in root-to-leaf order. */
export function getActivePath(conversationId: number): Message[] {
  return getPathToMessage(getActiveLeafId(conversationId));
}

/** Path from the root through a specific message, independent of the active branch. */
export function getPathToMessage(messageId: number | null): Message[] {
  if (messageId == null) return [];
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
 * Repoint active_child_id along the entire path so branch switches can restore
 * the previously active descendants of any node.
 */
export function setActiveLeaf(conversationId: number, leafId: number | null): void {
  // Only content-creating routes bump updated_at; branch switches must not reorder chats.
  stmt('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run(leafId, conversationId);
  bumpConversationRevision(conversationId);
  if (leafId == null) return;
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

/** Insert above all existing child branches, preserving their remembered path.
 * Keep an existing continuation active; otherwise activate the inserted message. */
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

    // Repair active-child pointers through the insertion without losing the continuation.
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
  // Collect before cascading deletes; unlink only after commit.
  const doomedImages = [
    ...collectMessageImages(messageId),
    ...siblingIds.flatMap((id) => collectSubtreeImages(id)),
  ];
  const leaf = getActiveLeafId(conversationId);
  // Delete siblings before reparenting children into their group.
  for (const id of siblingIds) stmt('DELETE FROM messages WHERE id = ?').run(id);
  stmt('UPDATE messages SET parent_id = ? WHERE parent_id = ?').run(parentId, messageId);
  stmt('DELETE FROM messages WHERE id = ?').run(messageId);
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
 * Delete selected blocks and their sibling subtrees, reattaching the visible
 * continuation above the range. Commit atomically before unlinking images.
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
 * Rotate with the active child: its sibling group rises above messageId
 * and its swipes; its former children move beneath messageId.
 * Return false when there is no block below.
 */
export function rotateDown(messageId: number): boolean {
  const row = getRow(messageId);
  if (!row) return false;
  const { conversation_id: conversationId, parent_id: parentId } = row;
  // A stale active_child_id may point to the parent after rotation; verify the relationship.
  const remembered =
    row.active_child_id != null && getRow(row.active_child_id)?.parent_id === messageId
      ? row.active_child_id
      : null;
  const childB = remembered ?? newestChildId(conversationId, messageId);
  if (childB == null) return false;
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
    // The old child is now the parent; inherit its remembered descent.
    stmt('UPDATE messages SET active_child_id = ? WHERE id = ?').run(bActiveChild, messageId);
    setActiveLeaf(conversationId, leaf === childB ? messageId : leaf);
  });
  return true;
}

/** Delete one swipe and its subtree, repairing the active path if affected. */
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
        // Deletion can reveal speculative swipes. Promote the replacement path
        // so later context invalidation cannot delete it and its descendants.
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
