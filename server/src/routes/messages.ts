// RACE-FREE-BY-SYNCHRONY: every route handler in this file is race-free only
// because it runs fully synchronously between check and act (no `await`
// mid-handler) — Node's single thread then serializes handlers against each
// other and against generation/streaming callbacks. A single future `await`
// mid-handler reopens the double-generation and active-leaf races the guards
// below protect against.
import { randomUUID } from 'node:crypto';
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
import { invalidate } from '../events.ts';
import {
  cancelBackgroundSwipe,
  getConversation,
  isConversationWatched,
  prepareNextSwipe,
  spawnAssistantReply,
  touchConversation,
} from './conversations.ts';
import { objectBody, positiveId, requiredString } from '../validation.ts';
import { optionalNullableId, optionalNumber } from '../validation.ts';
import { requireExpectedActiveLeaf } from '../concurrency.ts';
import { discardSpeculativeSwipes, markSwipeRead, nextUnreadSibling } from '../speculation.ts';
import { parseImageConfig, startImageRender } from '../comfy.ts';
import { buildSteeredPrompt, buildSteeredToolPrompt, resolveSteerTemplate } from '../prompt.ts';
import { bumpConversationRevision } from '../conversationRevision.ts';
import { copyImage, deleteImageFiles } from '../images.ts';

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

/** A block splice deletes the selected row and every sibling subtree, but its
 * own descendants survive and move up one level. Stop only active tool streams
 * that fall inside that exact deletion set. */
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

/** Delete-swipe removes the selected row and its entire subtree. */
function stopGenerationsInSubtree(message: ReturnType<typeof requireMessage>): void {
  for (const mid of activeGenerationMessageIds(message.conversationId)) {
    if (getPathToMessage(mid).some((node) => node.id === message.id)) stopGeneration(mid);
  }
}

function requireExpectedLeaf(message: ReturnType<typeof requireMessage>, body: unknown): void {
  const b = objectBody(body);
  requireExpectedActiveLeaf(
    message.conversationId,
    optionalNullableId(b, 'expectedActiveLeafId'),
    optionalNumber(b, 'expectedMutationRevision'),
  );
}

/** Resume: continue the last assistant reply in place via prefill-style trailing assistant message. */
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
  requireExpectedLeaf(msg, body);
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
        if (isConversationWatched(msg.conversationId)) prepareNextSwipe(msg.id);
      },
    },
  );
  broadcastTree(msg.conversationId);
  invalidate('conversations');
  return { assistantMessageId: msg.id };
});

/** Atomically move to the next assistant sibling, creating it when needed. */
route.post('/api/messages/:id/advance', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  if (msg.role !== 'assistant') throw new HttpError(400, 'only assistant messages can advance');
  requireExpectedLeaf(msg, body);

  const nextId = nextUnreadSibling(msg);

  if (nextId != null) {
    // Revealing a not-yet-seen speculative reply is "new content" for the
    // sidebar, exactly like generating it in the foreground would have been.
    const wasUnread = getMessage(nextId)?.generationKind === 'speculative';
    if (hasActiveGeneration(msg.conversationId)) {
      if (isBackgroundGeneration(nextId)) promoteBackgroundGeneration(nextId);
      // A speculative stream in another sibling group loses its context on
      // this branch switch anyway — cancel it rather than refusing the swipe.
      else if (!stopGeneration(msg.id) && !cancelBackgroundSwipe(msg.conversationId)) {
        throw new HttpError(409, 'a different generation is already running');
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

  if (
    hasActiveGeneration(msg.conversationId) &&
    !stopGeneration(msg.id) &&
    !cancelBackgroundSwipe(msg.conversationId)
  ) {
    throw new HttpError(409, 'a different generation is already running');
  }
  const mid = spawnAssistantReply(getConversation(msg.conversationId), msg.parentId, msg.name);
  invalidate('conversations');
  return { activeLeafId: mid, assistantMessageId: mid };
});

/**
 * Steered regeneration: assistant output becomes a sibling swipe; revised
 * image-tool output becomes a new child message immediately after the source.
 * The instruction is rendered into the conversation's resolved steer template
 * and injected into this generation's prompt only — it never enters history.
 * Tool revisions retain their image render configuration.
 */
route.post('/api/messages/:id/regenerate', ({ params, body }) => {
  let msg = requireMessage(positiveId(params.id));
  if (msg.role !== 'assistant' && msg.role !== 'tool') {
    throw new HttpError(400, 'only assistant and tool messages can be regenerated');
  }
  const b = objectBody(body);
  const instruction = requiredString(b, 'instruction');
  requireExpectedLeaf(msg, body);
  requireIdle(msg.conversationId);
  // requireIdle may have deleted the message itself (in-flight speculative
  // sibling); re-fetch before building on it (same as duplicate).
  msg = requireMessage(msg.id);
  const conv = getConversation(msg.conversationId);
  // Snapshot the steered prompt at route time (the tool-generation pattern):
  // retries must resend exactly this prompt, whatever changes later. Simple
  // macro substitution, not the template engine. Function replacer so '$'
  // sequences in the instruction stay literal.
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
  const steer = resolveSteerTemplate(conv).replaceAll(/\{\{instruction\}\}/gi, () => instruction);
  // The temporary upstream context includes the target reply so the model can
  // actually revise it. The new stored message still uses msg.parentId below,
  // making it a sibling; the original never becomes part of the new branch.
  const prompt = buildSteeredPrompt(conv, getPathToMessage(msg.id), steer, msg.name);
  const mid = spawnAssistantReply(conv, msg.parentId, msg.name, prompt);
  invalidate('conversations');
  return { activeLeafId: mid, assistantMessageId: mid };
});

/** In-place edit (typo fixes, tweaking an AI reply) — no branch created. */
route.patch('/api/messages/:id', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = objectBody(body);
  if (typeof b.content !== 'string') throw new HttpError(400, 'content is required');
  const content = b.content.trim();
  if (!content) throw new HttpError(400, 'content is required');
  requireExpectedActiveLeaf(
    msg.conversationId,
    optionalNullableId(b, 'expectedActiveLeafId'),
    optionalNumber(b, 'expectedMutationRevision'),
  );
  if (msg.status === 'streaming') throw new HttpError(409, 'message is still streaming');
  // The renderer snapshots content when it starts. Editing that content while
  // the job is pending would attach an image generated from the old prompt to
  // the newly edited description.
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
  return getMessage(msg.id);
});

/** Edit-as-branch: new sibling with the edited content; for user messages a reply is generated. */
route.post('/api/messages/:id/edit-branch', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = objectBody(body);
  const content = (typeof b.content === 'string' ? b.content : '').trim();
  if (!content) throw new HttpError(400, 'content is required');
  requireExpectedActiveLeaf(
    msg.conversationId,
    optionalNullableId(b, 'expectedActiveLeafId'),
    optionalNumber(b, 'expectedMutationRevision'),
  );
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
  requireExpectedLeaf(msg, body);
  const wasUnread = msg.generationKind === 'speculative';
  if (hasActiveGeneration(msg.conversationId)) {
    if (isBackgroundGeneration(msg.id)) promoteBackgroundGeneration(msg.id);
    else requireIdle(msg.conversationId);
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
  const rawExpected = new URL(req.url ?? '/', 'http://x').searchParams.get('expectedActiveLeafId');
  const rawRevision = new URL(req.url ?? '/', 'http://x').searchParams.get(
    'expectedMutationRevision',
  );
  const expected =
    rawExpected === 'null' ? null : rawExpected == null ? undefined : Number(rawExpected);
  requireExpectedActiveLeaf(
    msg.conversationId,
    expected,
    rawRevision == null ? undefined : Number(rawRevision),
  );
  requireDeleteCompatible(msg.conversationId);
  stopGenerationsDeletedBySplice(msg);
  // Removing a block changes the context every prepared swipe was generated for.
  discardSpeculativeSwipes(msg.conversationId);
  // Splice, not subtree-delete: the tree below reattaches to the parent.
  // Whole-branch removal is what /del (delete-tail) is for.
  spliceMessage(msg.id);
  touchConversation(msg.conversationId);
  broadcastTree(msg.conversationId);
  invalidate('conversations');
});

/** Deletes only this sibling alternative and its descendants. Unlike the
 * regular block delete above, sibling swipes survive and no descendants are
 * spliced upward into the remaining branch. */
route.del('/api/messages/:id/swipe', ({ params, req }) => {
  let msg = requireMessage(positiveId(params.id));
  const rawExpected = new URL(req.url ?? '/', 'http://x').searchParams.get('expectedActiveLeafId');
  const rawRevision = new URL(req.url ?? '/', 'http://x').searchParams.get(
    'expectedMutationRevision',
  );
  const expected =
    rawExpected === 'null' ? null : rawExpected == null ? undefined : Number(rawExpected);
  requireExpectedActiveLeaf(
    msg.conversationId,
    expected,
    rawRevision == null ? undefined : Number(rawRevision),
  );
  const findAlternative = () =>
    stmt(
      'SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ? AND id != ? LIMIT 1',
    ).get(msg.conversationId, msg.parentId, msg.id);
  // A true sole-child rejection must be side-effect free: in particular, do
  // not cancel an unrelated background generation before returning 400.
  if (!findAlternative()) throw new HttpError(400, 'message has no other swipe to activate');
  requireDeleteCompatible(msg.conversationId);
  // Compatibility cleanup may remove an in-flight prepared sibling (or the
  // requested speculative message itself), so validate the post-cleanup group.
  msg = requireMessage(msg.id);
  if (!findAlternative()) throw new HttpError(400, 'message has no other swipe to activate');
  stopGenerationsInSubtree(msg);
  deleteMessage(msg.id);
  touchConversation(msg.conversationId);
  broadcastTree(msg.conversationId);
  invalidate('conversations');
  return { activeLeafId: getActiveLeafId(msg.conversationId) };
});

/** Moves a message's block one step up or down the visible chain. Down rotates
 * it with its active child's block; up is the same rotation on the parent. */
route.post('/api/messages/:id/move', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = objectBody(body);
  const direction = b.direction;
  if (direction !== 'up' && direction !== 'down') {
    throw new HttpError(400, "direction must be 'up' or 'down'");
  }
  requireExpectedLeaf(msg, body);
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

/** Inserts a duplicate immediately after the selected message. Existing
 * children move beneath the copy so the visible continuation and active leaf
 * survive. Generated images use independent files for safe hard deletion. */
route.post('/api/messages/:id/duplicate', ({ params, body }) => {
  let msg = requireMessage(positiveId(params.id));
  requireExpectedLeaf(msg, body);
  requireIdle(msg.conversationId);
  // requireIdle may have deleted the message itself (in-flight speculative
  // sibling); re-fetch, and only completed content is worth copying.
  msg = requireMessage(msg.id);
  if (msg.status !== 'done') {
    throw new HttpError(400, 'only completed messages can be duplicated');
  }
  discardSpeculativeSwipes(msg.conversationId);
  const copiedImages: string[] = [];
  let copiedActiveImage = 0;
  try {
    for (const [sourceIndex, imagePath] of msg.images.entries()) {
      const ext = imagePath.includes('.') ? imagePath.slice(imagePath.lastIndexOf('.')) : '.png';
      const copied = copyImage(imagePath, `msg-copy-${randomUUID()}${ext}`);
      if (copied == null) {
        console.warn(`[messages] duplicate: source image ${imagePath} is missing`);
        continue;
      }
      if (sourceIndex === msg.activeImage) copiedActiveImage = copiedImages.length;
      copiedImages.push(copied);
    }
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
        JSON.stringify(copiedImages),
        copiedActiveImage,
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

/** Renders another image alternative with the message's current content and a
 * fresh seed. A caller-supplied current workflow replaces the stored snapshot;
 * without one, the stored configuration remains the fallback. */
route.post('/api/messages/:id/render-image', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = body == null ? {} : objectBody(body);
  requireExpectedLeaf(msg, b);
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

/** Selects which image alternative a message displays (persisted, synced). */
route.post('/api/messages/:id/active-image', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = objectBody(body);
  requireExpectedLeaf(msg, b);
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

/** Removes one generated image alternative while preserving the prompt and
 * message row. The selected index moves to the next image at the same slot,
 * or the previous image when the deleted one was last. */
route.post('/api/messages/:id/delete-image', ({ params, body }) => {
  const msg = requireMessage(positiveId(params.id));
  const b = objectBody(body);
  requireExpectedLeaf(msg, b);
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
  return getMessage(msg.id);
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
  return { stopped: true };
});
