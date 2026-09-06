import { publicMessage } from '../mediaUrls.ts';
// Keep check-and-act synchronous: an await lets handlers and generation callbacks
// interleave, reopening double-generation and active-leaf races.
import { copyMessageImages } from './conversationCopies.ts';
import { stmt, transaction } from '../db.ts';
import { route, HttpError } from '../router.ts';
import {
  activateMessage,
  appendMessage,
  deleteMessage,
  getActiveLeafId,
  getActivePath,
  getMessage,
  getPathToMessage,
  insertMessageAfter,
  markMessageDirty,
  rotateDown,
  spliceMessage,
  spliceMessages,
} from '../tree.ts';
import {
  activeGenerationMessageIds,
  hasActiveGeneration,
  hasActiveNonToolGeneration,
  hasForegroundGeneration,
  isBackgroundGeneration,
  promoteBackgroundGeneration,
  activeGenerationToken,
  supportsAssistantContinuation,
  startGeneration,
  stopGeneration,
} from '../generation.ts';
import { broadcastTree } from '../sync.ts';
import { invalidate, hasConversationSubscribers } from '../events.ts';
import {
  cancelBackgroundSwipe,
  getConversation,
  prepareNextSwipe,
  spawnAssistantReply,
  touchConversation,
} from './conversations.ts';
import { objectBody, optionalNumber, positiveId, requiredString } from '../validation.ts';
import { requireBodyPrecondition, requireQueryPrecondition } from './mutationGuard.ts';
import { discardSpeculativeSwipes, markSwipeRead, nextUnreadSibling } from '../speculation.ts';
import { parseImageConfig, startImageRender } from '../comfy.ts';
import { buildSteeredPrompt, buildSteeredToolPrompt, resolveSteerTemplate } from '../prompt.ts';
import { bumpConversationRevision } from '../conversationRevision.ts';
import { deleteImageFiles } from '../images.ts';

function requireMessage(id: number) {
  const msg = getMessage(id);
  if (!msg) throw new HttpError(404, `message ${id} not found`);
  return msg;
}

function requireIdle(conversationId: number): void {
  cancelBackgroundSwipe(conversationId);
  if (hasActiveGeneration(conversationId)) {
    throw new HttpError(409, 'a generation is already running in this conversation');
  }
}

/** Deleting completed messages may overlap route-time-snapshotted tool
 * prompts. Normal assistant generations still require a stable tree. */
function requireDeleteCompatible(conversationId: number): void {
  cancelBackgroundSwipe(conversationId);
  if (hasActiveNonToolGeneration(conversationId)) {
    throw new HttpError(409, 'a generation is already running in this conversation');
  }
}

/** Splicing deletes this row and sibling subtrees; its own descendants survive.
 * Stop only streams in the deletion set. */
function stopGenerationsDeletedBySplice(message: ReturnType<typeof requireMessage>): void {
  for (const mid of activeGenerationMessageIds(message.conversationId)) {
    if (mid === message.id) {
      stopGeneration(mid);
      continue;
    }
    const path = getPathToMessage(mid);
    if (path.some((node) => node.id === message.id)) continue;
    if (path.some((node) => node.parentId === message.parentId && node.id !== message.id)) {
      stopGeneration(mid);
    }
  }
}

function stopGenerationsInSubtree(message: ReturnType<typeof requireMessage>): void {
  for (const mid of activeGenerationMessageIds(message.conversationId)) {
    if (getPathToMessage(mid).some((node) => node.id === message.id)) stopGeneration(mid);
  }
}

function messageIdsFromBody(body: Record<string, unknown>): number[] {
  const value = body.messageIds;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 1000 ||
    value.some((id) => !Number.isSafeInteger(id) || (id as number) <= 0)
  ) {
    throw new HttpError(400, 'messageIds must be 1–1000 positive integers');
  }
  const ids = value as number[];
  if (new Set(ids).size !== ids.length) {
    throw new HttpError(400, 'messageIds must not contain duplicates');
  }
  return ids;
}

function requireActiveMessageRange(messageIds: readonly number[]): {
  conversationId: number;
  pathLength: number;
  start: number;
} {
  const messages = messageIds.map((id) => requireMessage(id));
  const conversationId = messages[0]!.conversationId;
  if (messages.some((message) => message.conversationId !== conversationId)) {
    throw new HttpError(400, 'all selected messages must belong to one conversation');
  }
  const path = getActivePath(conversationId);
  const start = path.findIndex((message) => message.id === messageIds[0]);
  if (start < 0 || messageIds.some((id, index) => path[start + index]?.id !== id)) {
    throw new HttpError(400, 'selected messages must be contiguous on the active branch');
  }
  return { conversationId, pathLength: path.length, start };
}

/** Resume in place with an assistant prefill. */
route.post('/api/messages/:id/continue', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  if (msg.role !== 'assistant') throw new HttpError(400, 'only assistant messages can be resumed');
  if (msg.status === 'streaming') throw new HttpError(409, 'message is still streaming');
  // finalize() clears image_pending on non-done endings, which would disown a
  // render started via render-image — keep the two exclusive.
  if (msg.imagePending) {
    throw new HttpError(409, 'an image render is running for this message');
  }
  const conv = getConversation(msg.conversationId);
  requireBodyPrecondition(msg.conversationId, body);
  if (conv.activeLeafId !== msg.id)
    throw new HttpError(400, 'only the last message on the branch can be resumed');
  if (!supportsAssistantContinuation(conv)) {
    throw new HttpError(400, 'the active endpoint disables assistant prefills and continuation');
  }
  requireIdle(msg.conversationId);
  stmt("UPDATE messages SET status = 'streaming' WHERE id = ?").run(msg.id);
  touchConversation(msg.conversationId);
  startGeneration(
    conv,
    msg.id,
    { content: msg.content, reasoning: msg.reasoning ?? '' },
    {
      onDone: () => {
        if (hasConversationSubscribers(msg.conversationId)) prepareNextSwipe(msg.id);
      },
      onError: () => {
        if (getActiveLeafId(msg.conversationId) === msg.id)
          cancelBackgroundSwipe(msg.conversationId);
      },
    },
  );
  prepareNextSwipe(msg.id);
  broadcastTree(msg.conversationId);
  invalidate('conversations');
  return { assistantMessageId: msg.id };
});

/** Atomically move to the next assistant sibling, creating it when needed. */
route.post('/api/messages/:id/advance', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  if (msg.role !== 'assistant') throw new HttpError(400, 'only assistant messages can advance');
  requireBodyPrecondition(msg.conversationId, body);

  const nextId = nextUnreadSibling(msg);

  if (nextId != null) {
    // Revealing an unread swipe counts as new content for sidebar ordering.
    const wasUnread = getMessage(nextId)?.generationKind === 'speculative';
    if (hasActiveGeneration(msg.conversationId)) {
      stopGeneration(msg.id);
      if (isBackgroundGeneration(nextId)) {
        if (hasForegroundGeneration(msg.conversationId)) {
          throw new HttpError(409, 'a different generation is already running');
        }
        promoteBackgroundGeneration(nextId);
      } else {
        // Cancel a parallel sibling as well as the outgoing foreground reply.
        cancelBackgroundSwipe(msg.conversationId);
        if (hasActiveGeneration(msg.conversationId)) {
          throw new HttpError(409, 'a different generation is already running');
        }
      }
    }
    markSwipeRead(nextId);
    if (wasUnread) touchConversation(msg.conversationId);
    const leaf = activateMessage(nextId);
    broadcastTree(msg.conversationId);
    prepareNextSwipe(leaf);
    invalidate('conversations');
    return { activeLeafId: leaf, assistantMessageId: null };
  }

  stopGeneration(msg.id);
  cancelBackgroundSwipe(msg.conversationId);
  if (hasActiveGeneration(msg.conversationId)) {
    throw new HttpError(409, 'a different generation is already running');
  }
  const mid = spawnAssistantReply(getConversation(msg.conversationId), msg.parentId, msg.name);
  invalidate('conversations');
  return { activeLeafId: mid, assistantMessageId: mid };
});

/** Assistant revisions become sibling swipes; tool revisions become children
 * retaining their render config. The instruction never enters history. */
route.post('/api/messages/:id/regenerate', ({ params, body }) => {
  let msg = requireMessage(positiveId(params.id));
  if (msg.role !== 'assistant' && msg.role !== 'tool') {
    throw new HttpError(400, 'only assistant and tool messages can be regenerated');
  }
  const b = objectBody(body);
  const instruction = requiredString(b, 'instruction');
  requireBodyPrecondition(msg.conversationId, body);
  requireIdle(msg.conversationId);
  // requireIdle may delete this message if it is an in-flight speculative sibling.
  msg = requireMessage(msg.id);
  const conv = getConversation(msg.conversationId);
  // Snapshot the prompt now so retries reuse it even if context changes.
  if (msg.role === 'tool') {
    if (!msg.content.trim()) throw new HttpError(400, 'tool message has no output to revise');
    if (msg.imagePending) throw new HttpError(409, 'an image render is running for this message');
    const row = stmt('SELECT image_render_json FROM messages WHERE id = ?').get(msg.id) as {
      image_render_json: string | null;
    };
    let image = row.image_render_json
      ? (JSON.parse(row.image_render_json) as { workflow: string; comfyUrl: string })
      : null;
    if (b.image !== undefined) {
      try {
        image = parseImageConfig(b.image);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }
    const prompt = buildSteeredToolPrompt(
      conv,
      getPathToMessage(msg.parentId),
      msg.content,
      msg.reasoning,
      instruction,
    );
    const next = insertMessageAfter(
      msg.conversationId,
      'tool',
      '',
      msg.id,
      'streaming',
      null,
      msg.name,
    );
    if (image) {
      stmt('UPDATE messages SET image_pending = 1, image_render_json = ? WHERE id = ?').run(
        JSON.stringify(image),
        next.id,
      );
    }
    touchConversation(msg.conversationId);
    const renderImage = image;
    startGeneration(getConversation(msg.conversationId), next.id, undefined, {
      prompt,
      onDone: renderImage
        ? () =>
            startImageRender({
              conversationId: msg.conversationId,
              mid: next.id,
              comfyUrl: renderImage.comfyUrl,
              workflow: renderImage.workflow,
              description: getMessage(next.id)?.content ?? '',
            })
        : undefined,
    });
    broadcastTree(msg.conversationId);
    invalidate('conversations');
    return {
      activeLeafId: getActiveLeafId(msg.conversationId),
      assistantMessageId: next.id,
    };
  }
  // A function replacer keeps '$' sequences in the instruction literal.
  const steer = resolveSteerTemplate(conv).replaceAll(/\{\{instruction\}\}/gi, () => instruction);
  // Include the original in upstream context, but store the revision as a sibling.
  const prompt = buildSteeredPrompt(conv, getPathToMessage(msg.id), steer, msg.name);
  const mid = spawnAssistantReply(conv, msg.parentId, msg.name, prompt);
  invalidate('conversations');
  return { activeLeafId: mid, assistantMessageId: mid };
});

route.patch('/api/messages/:id', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = objectBody(body);
  if (typeof b.content !== 'string') throw new HttpError(400, 'content is required');
  const content = b.content.trim();
  if (!content) throw new HttpError(400, 'content is required');
  requireBodyPrecondition(msg.conversationId, b);
  if (msg.status === 'streaming') throw new HttpError(409, 'message is still streaming');
  // Pending renders use a prompt snapshot; editing would mismatch image and description.
  if (msg.imagePending) {
    throw new HttpError(409, 'an image render is running for this message');
  }
  if (hasForegroundGeneration(msg.conversationId)) {
    throw new HttpError(409, 'a generation is already running in this conversation');
  }
  discardSpeculativeSwipes(msg.conversationId);
  stmt('UPDATE messages SET content = ? WHERE id = ?').run(content, msg.id);
  bumpConversationRevision(msg.conversationId);
  markMessageDirty(msg.conversationId, msg.id);
  touchConversation(msg.conversationId);
  broadcastTree(msg.conversationId);
  invalidate('conversations');
  return publicMessage(getMessage(msg.id));
});

/** Edit-as-branch: new sibling with the edited content; for user messages a reply is generated. */
route.post('/api/messages/:id/edit-branch', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = objectBody(body);
  const content = (typeof b.content === 'string' ? b.content : '').trim();
  if (!content) throw new HttpError(400, 'content is required');
  requireBodyPrecondition(msg.conversationId, b);
  requireIdle(msg.conversationId);
  const sibling = appendMessage(
    msg.conversationId,
    msg.role,
    content,
    msg.parentId,
    'done',
    null,
    msg.role === 'assistant' ? msg.name : null,
  );
  let assistantMessageId: number | null = null;
  if (msg.role === 'user') {
    assistantMessageId = spawnAssistantReply(getConversation(msg.conversationId), sibling.id);
  } else {
    touchConversation(msg.conversationId);
    broadcastTree(msg.conversationId);
  }
  invalidate('conversations');
  return { messageId: sibling.id, assistantMessageId };
});

/** Branch switch: activate this sibling and restore its remembered descendant chain. */
route.post('/api/messages/:id/activate', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  requireBodyPrecondition(msg.conversationId, body);
  const wasUnread = msg.generationKind === 'speculative';
  if (hasActiveGeneration(msg.conversationId)) {
    // The prepared swipe may finish before its primary reply does.
    if (wasUnread) {
      const leafId = getActiveLeafId(msg.conversationId);
      const leaf = leafId == null ? null : getMessage(leafId);
      if (leaf?.parentId === msg.parentId) stopGeneration(leaf.id);
    }
    if (isBackgroundGeneration(msg.id)) {
      if (hasForegroundGeneration(msg.conversationId)) {
        throw new HttpError(409, 'a different generation is already running');
      }
      promoteBackgroundGeneration(msg.id);
    } else requireIdle(msg.conversationId);
  }
  markSwipeRead(msg.id);
  if (wasUnread) touchConversation(msg.conversationId);
  const leaf = activateMessage(msg.id);
  broadcastTree(msg.conversationId);
  prepareNextSwipe(leaf);
  invalidate('conversations');
  return { activeLeafId: leaf };
});

route.del('/api/messages/:id', ({ params, req }) => {
  const msg = requireMessage(positiveId(params.id));
  requireQueryPrecondition(msg.conversationId, req.url);
  requireDeleteCompatible(msg.conversationId);
  stopGenerationsDeletedBySplice(msg);
  // Removing a block changes the context every prepared swipe was generated for.
  discardSpeculativeSwipes(msg.conversationId);
  // Preserve the continuation; /del (delete-tail) removes the whole branch.
  spliceMessage(msg.id);
  touchConversation(msg.conversationId);
  broadcastTree(msg.conversationId);
  invalidate('conversations');
});

/** Delete this swipe's subtree, preserving other sibling alternatives. */
route.del('/api/messages/:id/swipe', ({ params, req }) => {
  let msg = requireMessage(positiveId(params.id));
  requireQueryPrecondition(msg.conversationId, req.url);
  const findAlternative = () =>
    stmt(
      'SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ? AND id != ? LIMIT 1',
    ).get(msg.conversationId, msg.parentId, msg.id);
  // Reject a sole child before cleanup can cancel unrelated background work.
  if (!findAlternative()) throw new HttpError(400, 'message has no other swipe to activate');
  requireDeleteCompatible(msg.conversationId);
  // Cleanup may delete a speculative sibling or this message; revalidate both.
  msg = requireMessage(msg.id);
  if (!findAlternative()) throw new HttpError(400, 'message has no other swipe to activate');
  stopGenerationsInSubtree(msg);
  deleteMessage(msg.id);
  touchConversation(msg.conversationId);
  broadcastTree(msg.conversationId);
  invalidate('conversations');
  return { activeLeafId: getActiveLeafId(msg.conversationId) };
});

/** Move an active-path range with its sibling swipes.
 * `steps` counts unselected slots crossed. */
route.post('/api/message-ranges/move', ({ body }) => {
  const b = objectBody(body);
  const messageIds = messageIdsFromBody(b);
  const first = requireMessage(messageIds[0]!);
  const direction = b.direction;
  if (direction !== 'up' && direction !== 'down') {
    throw new HttpError(400, "direction must be 'up' or 'down'");
  }
  const steps = b.steps;
  if (!Number.isSafeInteger(steps) || (steps as number) <= 0) {
    throw new HttpError(400, 'steps must be a positive integer');
  }
  requireBodyPrecondition(first.conversationId, body);
  const initialRange = requireActiveMessageRange(messageIds);
  const initialAvailableSteps =
    direction === 'up'
      ? initialRange.start
      : initialRange.pathLength - initialRange.start - messageIds.length;
  if ((steps as number) > initialAvailableSteps) {
    throw new HttpError(400, `selected range can only move ${initialAvailableSteps} more slots`);
  }
  requireIdle(first.conversationId);
  const range = requireActiveMessageRange(messageIds);
  const availableSteps =
    direction === 'up' ? range.start : range.pathLength - range.start - messageIds.length;
  if ((steps as number) > availableSteps) {
    throw new HttpError(400, `selected range can only move ${availableSteps} more slots`);
  }

  // Reordering changes the context every prepared swipe was generated for.
  discardSpeculativeSwipes(range.conversationId);
  transaction(() => {
    for (let step = 0; step < (steps as number); step++) {
      const ordered = direction === 'up' ? messageIds : [...messageIds].reverse();
      for (const messageId of ordered) {
        const target = direction === 'up' ? requireMessage(messageId).parentId : messageId;
        if (target == null || !rotateDown(target)) {
          throw new HttpError(400, `selected range cannot move ${direction}`);
        }
      }
    }
  });
  broadcastTree(range.conversationId);
  return {
    activeLeafId: getActiveLeafId(range.conversationId),
    movedSteps: steps,
  };
});

/** Delete a visible range and its swipe alternatives, preserving the continuation. */
route.post('/api/message-ranges/delete', ({ body }) => {
  const b = objectBody(body);
  const messageIds = messageIdsFromBody(b);
  const first = requireMessage(messageIds[0]!);
  requireBodyPrecondition(first.conversationId, body);
  requireActiveMessageRange(messageIds);
  requireDeleteCompatible(first.conversationId);
  const range = requireActiveMessageRange(messageIds);
  for (const messageId of messageIds) {
    stopGenerationsDeletedBySplice(requireMessage(messageId));
  }
  discardSpeculativeSwipes(range.conversationId);
  spliceMessages(messageIds);
  touchConversation(range.conversationId);
  broadcastTree(range.conversationId);
  invalidate('conversations');
  return { activeLeafId: getActiveLeafId(range.conversationId) };
});

/** Down rotates with the active child's block; up rotates the parent. */
route.post('/api/messages/:id/move', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = objectBody(body);
  const direction = b.direction;
  if (direction !== 'up' && direction !== 'down') {
    throw new HttpError(400, "direction must be 'up' or 'down'");
  }
  requireBodyPrecondition(msg.conversationId, body);
  requireIdle(msg.conversationId);
  if (!getActivePath(msg.conversationId).some((m) => m.id === msg.id)) {
    throw new HttpError(400, 'message is not on the active branch');
  }
  const target = direction === 'down' ? msg.id : msg.parentId;
  if (target == null) throw new HttpError(400, 'message is already at the top');
  // Reordering changes the context every prepared swipe was generated for.
  discardSpeculativeSwipes(msg.conversationId);
  if (!rotateDown(target)) throw new HttpError(400, 'message is already at the bottom');
  broadcastTree(msg.conversationId);
  return { activeLeafId: getActiveLeafId(msg.conversationId) };
});

/** Insert a copy before existing children, preserving the continuation and active leaf.
 * Image files are independent so either copy can be hard-deleted safely. */
route.post('/api/messages/:id/duplicate', ({ params, body }) => {
  let msg = requireMessage(positiveId(params.id));
  requireBodyPrecondition(msg.conversationId, body);
  requireIdle(msg.conversationId);
  // requireIdle may delete this message if it is an in-flight speculative sibling.
  msg = requireMessage(msg.id);
  if (msg.status !== 'done') {
    throw new HttpError(400, 'only completed messages can be duplicated');
  }
  discardSpeculativeSwipes(msg.conversationId);
  const copiedImages: string[] = [];
  try {
    const { images, activeImage } = copyMessageImages(msg, copiedImages);
    const copy = transaction(() => {
      const inserted = insertMessageAfter(
        msg.conversationId,
        msg.role,
        msg.content,
        msg.id,
        'done',
        msg.model,
        msg.name,
      );
      const renderRow = stmt('SELECT image_render_json FROM messages WHERE id = ?').get(msg.id) as {
        image_render_json: string | null;
      };
      stmt(
        `UPDATE messages
         SET reasoning = ?, image_render_json = ?, images_json = ?, active_image = ?
         WHERE id = ?`,
      ).run(
        msg.reasoning,
        renderRow.image_render_json,
        JSON.stringify(images),
        activeImage,
        inserted.id,
      );
      touchConversation(msg.conversationId);
      return inserted;
    });
    broadcastTree(msg.conversationId);
    invalidate('conversations');
    return { messageId: copy.id, activeLeafId: getActiveLeafId(msg.conversationId) };
  } catch (err) {
    deleteImageFiles(copiedImages);
    throw err;
  }
});

/** Render a fresh image alternative; a supplied workflow replaces the saved config. */
route.post('/api/messages/:id/render-image', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = body == null ? {} : objectBody(body);
  requireBodyPrecondition(msg.conversationId, b);
  if (!getActivePath(msg.conversationId).some((active) => active.id === msg.id)) {
    throw new HttpError(400, 'message is not on the active branch');
  }
  const row = stmt('SELECT image_render_json FROM messages WHERE id = ?').get(msg.id) as {
    image_render_json: string | null;
  };
  if (msg.imagePending) {
    throw new HttpError(409, 'an image render is already running for this message');
  }
  if (msg.status === 'streaming') throw new HttpError(409, 'message is still streaming');
  if (!msg.content.trim()) throw new HttpError(400, 'message has no description to render');
  let config: { workflow: string; comfyUrl: string };
  const suppliedConfig = 'workflow' in b || 'comfyUrl' in b;
  if (suppliedConfig) {
    try {
      config = parseImageConfig(b);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    stmt('UPDATE messages SET image_render_json = ? WHERE id = ?').run(
      JSON.stringify(config),
      msg.id,
    );
  } else if (row.image_render_json) {
    config = JSON.parse(row.image_render_json) as { workflow: string; comfyUrl: string };
  } else {
    throw new HttpError(400, 'message has no image render configuration');
  }
  stmt('UPDATE messages SET image_pending = 1 WHERE id = ?').run(msg.id);
  bumpConversationRevision(msg.conversationId);
  markMessageDirty(msg.conversationId, msg.id);
  broadcastTree(msg.conversationId);
  startImageRender({
    conversationId: msg.conversationId,
    mid: msg.id,
    comfyUrl: config.comfyUrl,
    workflow: config.workflow,
    description: msg.content,
  });
  return { rendering: true };
});

route.post('/api/messages/:id/active-image', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = objectBody(body);
  requireBodyPrecondition(msg.conversationId, b);
  if (!getActivePath(msg.conversationId).some((active) => active.id === msg.id)) {
    throw new HttpError(400, 'message is not on the active branch');
  }
  const index = b.index;
  if (
    typeof index !== 'number' ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= msg.images.length
  ) {
    throw new HttpError(400, 'index out of range');
  }
  stmt('UPDATE messages SET active_image = ? WHERE id = ?').run(index, msg.id);
  bumpConversationRevision(msg.conversationId);
  markMessageDirty(msg.conversationId, msg.id);
  broadcastTree(msg.conversationId);
});

/** Remove one image alternative, preserving the prompt and selecting the nearest survivor. */
route.post('/api/messages/:id/delete-image', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = objectBody(body);
  requireBodyPrecondition(msg.conversationId, b);
  if (!getActivePath(msg.conversationId).some((active) => active.id === msg.id)) {
    throw new HttpError(400, 'message is not on the active branch');
  }
  if (msg.imagePending) {
    throw new HttpError(409, 'an image render is running for this message');
  }
  const index = b.index;
  if (
    typeof index !== 'number' ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= msg.images.length
  ) {
    throw new HttpError(400, 'index out of range');
  }
  const images = [...msg.images];
  const [removed] = images.splice(index, 1);
  const activeImage = images.length > 0 ? Math.min(index, images.length - 1) : 0;
  transaction(() => {
    stmt('UPDATE messages SET images_json = ?, active_image = ? WHERE id = ?').run(
      JSON.stringify(images),
      activeImage,
      msg.id,
    );
    bumpConversationRevision(msg.conversationId);
    touchConversation(msg.conversationId);
  });
  markMessageDirty(msg.conversationId, msg.id);
  deleteImageFiles([removed!]);
  broadcastTree(msg.conversationId);
  invalidate('conversations');
  return publicMessage(getMessage(msg.id));
});

route.post('/api/generations/:id/stop', ({ params, body }) => {
  const mid = positiveId(params.id);
  const b = objectBody(body);
  const expectedGenerationToken = optionalNumber(b, 'expectedGenerationToken');
  if (!Number.isSafeInteger(expectedGenerationToken) || expectedGenerationToken! <= 0) {
    throw new HttpError(400, 'expectedGenerationToken is required');
  }
  if (isBackgroundGeneration(mid)) {
    throw new HttpError(409, 'inactive background swipes cannot be stopped directly');
  }
  const currentToken = activeGenerationToken(mid);
  if (currentToken != null && currentToken !== expectedGenerationToken) {
    throw new HttpError(409, 'generation changed; the stop request is stale');
  }
  const stopped = stopGeneration(mid);
  if (!stopped) throw new HttpError(404, 'no active generation for this message');
  const message = getMessage(mid);
  if (message?.role === 'assistant' && getActiveLeafId(message.conversationId) === mid) {
    cancelBackgroundSwipe(message.conversationId);
  }
  return { stopped: true };
});
