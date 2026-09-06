// Keep route handlers synchronous between check and act: an `await` lets other
// handlers or generation callbacks invalidate generation and active-leaf guards.
import { copyConversation, insertCopiedMessage } from './conversationCopies.ts';
import type { MessageRow } from './conversationCopies.ts';
import type { Conversation } from '@minitavern/shared';
import { stmt, toConversation, toMessage, transaction } from '../db.ts';
import { route, HttpError } from '../router.ts';
import {
  appendMessage,
  deleteMessage,
  getActiveLeafId,
  getActivePath,
  getMessage,
  getPathToMessage,
  setActiveLeaf,
  takeDirtyMessageIds,
} from '../tree.ts';
import { requireReference } from './entityUtils.ts';
import {
  buildChatMessages,
  buildToolPrompt,
  getCharacter,
  getPersona,
  substituteMacros,
  withDisabledPrefillSpeakerNote,
} from '../prompt.ts';
import type { BuiltPrompt } from '../prompt.ts';
import { clearSettingReference, getSettings } from '../settingsStore.ts';
import {
  activeGenerationToken,
  chatCompletionOnce,
  hasActiveGeneration,
  hasActiveNonToolGeneration,
  hasForegroundGeneration,
  isBackgroundGeneration,
  mergeLiveBuffers,
  startGeneration,
  stopBackgroundGenerations,
  stopConversationGenerations,
} from '../generation.ts';
import { broadcastTree, treeSnapshot } from '../sync.ts';
import { invalidate, hasConversationSubscribers } from '../events.ts';
import {
  cancelSpeculativeRetries,
  discardSpeculativeSwipes,
  nextUnreadSibling,
  scheduleSpeculativeRetry,
} from '../speculation.ts';
import { requireBodyPrecondition, requireQueryPrecondition } from './mutationGuard.ts';
import {
  collectConversationImages,
  collectSiblingSubtreeImages,
  deleteImageFiles,
} from '../images.ts';
import { parseImageConfig, startImageRender } from '../comfy.ts';
import { bumpConversationRevision } from '../conversationRevision.ts';
import {
  objectBody,
  optionalNullableId,
  optionalNullableString,
  optionalString,
  positiveId,
  requiredString,
} from '../validation.ts';

export function getConversation(id: number): Conversation {
  const row = stmt('SELECT * FROM conversations WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, `conversation ${id} not found`);
  return toConversation(row);
}

export function touchConversation(id: number): void {
  stmt('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}

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

/** Ensures the active assistant reply has one unread sibling ready or in progress. */
export function prepareNextSwipe(messageId: number, retryAttempt = 0): void {
  const message = getMessage(messageId);
  if (!message || message.role !== 'assistant') return;
  if (!hasConversationSubscribers(message.conversationId)) return;
  const conversation = getConversation(message.conversationId);
  if (conversation.activeLeafId !== message.id) return;
  const settings = getSettings();
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
        if (getActiveLeafId(conversation.id) === speculative.id)
          cancelBackgroundSwipe(conversation.id);
        return;
      }
      deleteMessage(speculative.id);
      broadcastTree(conversation.id);
      if (!hasConversationSubscribers(conversation.id)) return;
      scheduleSpeculativeRetry(conversation.id, retryAttempt + 1, () => {
        // Re-check at fire time: the last client may have left during the backoff.
        if (hasConversationSubscribers(conversation.id))
          prepareNextSwipe(message.id, retryAttempt + 1);
      });
    },
  });
  broadcastTree(conversation.id);
}

export function prepareActiveSwipe(conversationId: number): void {
  const leaf = getActiveLeafId(conversationId);
  if (leaf != null) prepareNextSwipe(leaf);
}

/** Regeneration preserves sibling speaker names; promptOverride keeps retries consistent. */
export function spawnAssistantReply(
  conversation: Conversation,
  parentId: number | null,
  speakerName: string | null = conversation.speakerName,
  promptOverride?: BuiltPrompt,
): number {
  const msg = appendMessage(
    conversation.id,
    'assistant',
    '',
    parentId,
    'streaming',
    null,
    speakerName,
  );
  touchConversation(conversation.id);
  startGeneration(getConversation(conversation.id), msg.id, undefined, {
    prompt: promptOverride,
    onDone: () => {
      if (hasConversationSubscribers(conversation.id)) prepareNextSwipe(msg.id);
      maybeAutoTitle(conversation.id, msg.id);
    },
    onError: () => {
      if (getActiveLeafId(conversation.id) === msg.id) cancelBackgroundSwipe(conversation.id);
    },
  });
  prepareNextSwipe(msg.id);
  broadcastTree(conversation.id);
  return msg.id;
}

/** The placeholder title a greeting-less conversation gets from its first message. */
function derivedTitle(content: string): string {
  return content.length > 60 ? `${content.slice(0, 57)}…` : content;
}

const TITLE_INSTRUCTION =
  'Summarize this conversation in 3-6 words for a sidebar title. Reply with only the title, no quotes.';

async function requestTitle(
  conv: Conversation,
  userText: string,
  assistantText: string,
): Promise<string | null> {
  const clip = (s: string) => (s.length > 1000 ? `${s.slice(0, 1000)}…` : s);
  try {
    const raw = await chatCompletionOnce(
      conv,
      [
        {
          role: 'user',
          content: `${TITLE_INSTRUCTION}\n\nUser: ${clip(userText)}\n\nAssistant: ${clip(assistantText)}`,
        },
      ],
      30,
    );
    const title = raw
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
      .trim();
    if (!title) return null;
    return title.length > 60 ? `${title.slice(0, 57)}…` : title;
  } catch (err) {
    console.warn(
      `[conversations] auto-title failed for conversation ${conv.id}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Auto-title the first exchange even without subscribers; failures retain the existing title. */
function maybeAutoTitle(conversationId: number, assistantMessageId: number): void {
  const conv = getConversation(conversationId);
  const history = getPathToMessage(getMessage(assistantMessageId)?.parentId ?? null);
  const first = history.length === 1 && history[0]!.role === 'user' ? history[0]! : null;
  if (!first) return;
  // Preserve titles chosen by the user or an earlier auto-title run.
  const fallback = derivedTitle(first.content);
  if (conv.title !== 'New chat' && conv.title !== fallback) return;
  const reply = getMessage(assistantMessageId)?.content ?? '';
  void requestTitle(conv, first.content, reply).then((title) => {
    if (!title) return;
    // The call is async: re-check that nobody renamed (or deleted) meanwhile.
    const latest = stmt('SELECT title FROM conversations WHERE id = ?').get(conversationId) as
      { title: string } | undefined;
    if (!latest || (latest.title !== 'New chat' && latest.title !== fallback)) return;
    // Title changes must not reorder the sidebar.
    stmt('UPDATE conversations SET title = ? WHERE id = ?').run(title, conversationId);
    invalidate('conversations');
  });
}

function getAlternateGreetings(characterId: number): string[] {
  const row = stmt('SELECT card_json FROM characters WHERE id = ?').get(characterId) as
    { card_json: string | null } | undefined;
  if (!row?.card_json) return [];
  try {
    const card = JSON.parse(row.card_json) as { data?: { alternate_greetings?: unknown } };
    const alts = card.data?.alternate_greetings;
    return Array.isArray(alts) ? alts.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

route.get('/api/conversations', () => {
  const rows = stmt('SELECT * FROM conversations ORDER BY updated_at DESC').all() as Record<
    string,
    unknown
  >[];
  return rows.map(toConversation);
});

route.del('/api/conversations', () => {
  const ids = (stmt('SELECT id FROM conversations').all() as unknown as { id: number }[]).map(
    (row) => row.id,
  );
  cancelSpeculativeRetries();
  for (const id of ids) stopConversationGenerations(id);
  const doomedImages = ids.flatMap(collectConversationImages);
  const result = stmt('DELETE FROM conversations').run();
  for (const id of ids) takeDirtyMessageIds(id);
  deleteImageFiles(doomedImages);
  invalidate('conversations');
  return { deleted: Number(result.changes) };
});

route.post('/api/conversations', ({ body }) => {
  const b = objectBody(body);
  const characterId = optionalNullableId(b, 'characterId') ?? null;
  const settings = getSettings();
  const character = getCharacter(characterId);
  if (characterId != null && !character) throw new HttpError(400, 'characterId does not exist');
  // Settings are JSON rather than foreign-keyed rows, so tolerate and repair a stale default.
  const persona = getPersona(settings.defaultPersonaId);
  if (settings.defaultPersonaId != null && !persona) {
    clearSettingReference('defaultPersonaId', settings.defaultPersonaId);
    invalidate('settings');
  }
  const now = Date.now();
  const id = transaction(() => {
    const result = stmt(
      `INSERT INTO conversations (title, character_id, persona_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(
      // The placeholder enables auto-titling for greeting-less chats.
      character?.firstMessage.trim() ? character.name : 'New chat',
      character?.id ?? null,
      persona?.id ?? null,
      now,
      now,
    );
    const convId = Number(result.lastInsertRowid);
    if (character?.firstMessage.trim()) {
      const sub = (text: string) => substituteMacros(text, character.name, persona?.name ?? 'User');
      appendMessage(convId, 'assistant', sub(character.firstMessage), null);
      // Make alternate greetings swipeable while keeping the primary active.
      for (const alt of getAlternateGreetings(character.id)) {
        if (alt.trim())
          appendMessage(convId, 'assistant', sub(alt), null, 'done', null, null, false);
      }
    }
    return convId;
  });
  invalidate('conversations');
  return getConversation(id);
});

route.patch('/api/conversations/:id', ({ params, body }) => {
  const id = positiveId(params.id);
  const conv = getConversation(id);
  const b = objectBody(body);
  requireBodyPrecondition(id, b);
  const title = optionalString(b, 'title');
  if (title !== undefined && !title.trim()) throw new HttpError(400, 'title is required');
  const characterId = optionalNullableId(b, 'characterId');
  const personaId = optionalNullableId(b, 'personaId');
  const endpointId = optionalNullableId(b, 'endpointId');
  const speakerName = optionalNullableString(b, 'speakerName');
  const scenarioOverride = optionalNullableString(b, 'scenarioOverride');
  if (characterId !== undefined && characterId !== conv.characterId) {
    throw new HttpError(400, 'a conversation character cannot be changed after creation');
  }
  if (personaId != null && !getPersona(personaId)) {
    throw new HttpError(400, 'personaId does not exist');
  }
  requireReference('endpoints', endpointId, 'endpointId');
  const contextChanged =
    (personaId !== undefined && personaId !== conv.personaId) ||
    (endpointId !== undefined && endpointId !== conv.endpointId) ||
    (speakerName !== undefined && (speakerName?.trim() || null) !== conv.speakerName) ||
    (scenarioOverride !== undefined && scenarioOverride !== conv.scenarioOverride);
  // Renaming is safe during generation; context changes are not.
  if (contextChanged && hasForegroundGeneration(id))
    throw new HttpError(409, 'a generation is already running in this conversation');
  if (contextChanged) discardSpeculativeSwipes(id);
  // Metadata edits must not reorder the sidebar.
  stmt(
    `UPDATE conversations SET title = ?, character_id = ?, persona_id = ?, endpoint_id = ?, speaker_name = ?,
      scenario_override = ?
     WHERE id = ?`,
  ).run(
    title !== undefined ? title.trim() : conv.title,
    characterId !== undefined ? characterId : conv.characterId,
    personaId !== undefined ? personaId : conv.personaId,
    endpointId !== undefined ? endpointId : conv.endpointId,
    speakerName !== undefined ? speakerName?.trim() || null : conv.speakerName,
    scenarioOverride !== undefined ? scenarioOverride : conv.scenarioOverride,
    id,
  );
  bumpConversationRevision(id);
  broadcastTree(id);
  invalidate('conversations');
  return getConversation(id);
});

route.del('/api/conversations/:id', ({ params, req }) => {
  const id = positiveId(params.id);
  getConversation(id);
  requireQueryPrecondition(id, req.url);
  stopConversationGenerations(id);
  const doomedImages = collectConversationImages(id);
  stmt('DELETE FROM conversations WHERE id = ?').run(id);
  deleteImageFiles(doomedImages);
  takeDirtyMessageIds(id);
  invalidate('conversations');
});

/**
 * Copy images independently so deleting either conversation cannot break the other.
 * Clear live generation state in copies because no process owns it.
 */
route.post('/api/conversations/:id/duplicate', ({ params }) => {
  const id = positiveId(params.id);
  const conv = getConversation(id);
  const rows = stmt('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(
    id,
  ) as unknown as MessageRow[];
  const liveMessages = new Map(
    mergeLiveBuffers(rows.map((row) => toMessage(row as unknown as Record<string, unknown>))).map(
      (message) => [message.id, message],
    ),
  );
  const sourceActivePath = getActivePath(id).map((message) => message.id);
  const newId = copyConversation(conv, ' (copy)', (newConvId, writtenImages) => {
    const idMap = new Map<number, number>();
    for (const row of rows) {
      const live = liveMessages.get(row.id)!;
      idMap.set(row.id, insertCopiedMessage(newConvId, null, row, live, writtenImages));
    }
    // Remap links after all rows exist: moves and insertions can put older rows under newer ones.
    for (const row of rows) {
      const mappedParent = row.parent_id != null ? (idMap.get(row.parent_id) ?? null) : null;
      const mappedChild =
        row.active_child_id != null ? (idMap.get(row.active_child_id) ?? null) : null;
      stmt('UPDATE messages SET parent_id = ?, active_child_id = ? WHERE id = ?').run(
        mappedParent,
        mappedChild,
        idMap.get(row.id)!,
      );
    }
    if (conv.activeLeafId != null) {
      const mappedLeaf = idMap.get(conv.activeLeafId);
      if (mappedLeaf != null) {
        stmt('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run(mappedLeaf, newConvId);
        const copiedPath = getPathToMessage(mappedLeaf).map((message) => message.id);
        const expectedPath = sourceActivePath.map((sourceId) => idMap.get(sourceId)!);
        if (
          copiedPath.length !== expectedPath.length ||
          copiedPath.some((messageId, index) => messageId !== expectedPath[index])
        ) {
          throw new Error('duplicated conversation active path failed validation');
        }
      }
    }
  });
  invalidate('conversations');
  return getConversation(newId);
});

/**
 * Copy only the selected ancestry, excluding siblings and descendants.
 * Independent image copies preserve hard-delete ownership.
 */
route.post('/api/messages/:id/branch-conversation', ({ params }) => {
  const messageId = positiveId(params.id);
  const target = getMessage(messageId);
  if (!target) throw new HttpError(404, `message ${messageId} not found`);
  const conv = getConversation(target.conversationId);
  const path = getPathToMessage(messageId);
  const rows = path.map(
    (message) =>
      stmt('SELECT * FROM messages WHERE id = ?').get(message.id) as unknown as MessageRow,
  );
  const liveMessages = new Map(mergeLiveBuffers(path).map((message) => [message.id, message]));
  const newId = copyConversation(conv, ' (branch)', (newConvId, writtenImages) => {
    let parentId: number | null = null;

    for (const row of rows) {
      const live = liveMessages.get(row.id)!;
      const copiedId = insertCopiedMessage(newConvId, parentId, row, live, writtenImages, 'normal');
      if (parentId != null) {
        stmt('UPDATE messages SET active_child_id = ? WHERE id = ?').run(copiedId, parentId);
      }
      parentId = copiedId;
    }

    stmt('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run(parentId, newConvId);
  });
  invalidate('conversations');
  return getConversation(newId);
});

route.get('/api/conversations/:id/tree', ({ params }) => {
  const id = positiveId(params.id);
  getConversation(id);
  return treeSnapshot(id);
});

route.post('/api/conversations/:id/tool', ({ params, body }) => {
  const id = positiveId(params.id);
  const conv = getConversation(id);
  const b = objectBody(body);
  const prompt = requiredString(b, 'prompt');
  const label = optionalNullableString(b, 'label');
  let image: { workflow: string; comfyUrl: string } | null = null;
  if (b.image != null) {
    try {
      image = parseImageConfig(b.image);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  }
  requireBodyPrecondition(id, b);
  // Don't refill speculation: swiping the previous reply requires a branch switch, which refills.
  cancelBackgroundSwipe(id);
  // Tool streams can overlap: each snapshots history, which excludes tool output.
  // Assistant streams conflict because their incomplete replies enter that history.
  if (hasActiveNonToolGeneration(id))
    throw new HttpError(409, 'a generation is already running in this conversation');

  // Snapshot pre-tool history so retries use the same context.
  const built = buildToolPrompt(conv, getActivePath(id), prompt);
  const msg = appendMessage(
    id,
    'tool',
    '',
    conv.activeLeafId,
    'streaming',
    null,
    label?.trim() || null,
  );
  // Retain config for later alternatives; finalize() clears pending on non-done completion.
  if (image) {
    stmt('UPDATE messages SET image_pending = 1, image_render_json = ? WHERE id = ?').run(
      JSON.stringify(image),
      msg.id,
    );
  }
  touchConversation(id);
  const renderImage = image;
  startGeneration(getConversation(id), msg.id, undefined, {
    prompt: built,
    onDone: renderImage
      ? () =>
          startImageRender({
            conversationId: id,
            mid: msg.id,
            comfyUrl: renderImage.comfyUrl,
            workflow: renderImage.workflow,
            description: getMessage(msg.id)?.content ?? '',
          })
      : undefined,
  });
  broadcastTree(id);
  invalidate('conversations');
  return { toolMessageId: msg.id, activeLeafId: msg.id };
});

/** The exact upstream request messages a generation on the current branch would send. */
route.get('/api/conversations/:id/trace', ({ params }) => {
  const conv = getConversation(positiveId(params.id));
  const history = getActivePath(conv.id);
  const built = buildChatMessages(conv, history);
  const endpointId = conv.endpointId ?? getSettings().activeEndpointId;
  const endpointRow = endpointId
    ? (stmt('SELECT prefill_mode FROM endpoints WHERE id = ?').get(endpointId) as
        { prefill_mode: string } | undefined)
    : undefined;
  const prefillDisabled = endpointRow?.prefill_mode === 'disabled';
  return {
    messages: prefillDisabled ? withDisabledPrefillSpeakerNote(built) : built.messages,
    reasoningPrefill: prefillDisabled ? null : built.reasoningPrefill,
    messagePrefill: prefillDisabled ? null : built.messagePrefill,
    namePrefill: prefillDisabled ? null : built.namePrefill,
  };
});

route.get('/api/search', ({ req }) => {
  const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q')?.trim() ?? '';
  if (!q) return [];
  if (/[\u0000-\u001f\u007f]/.test(q)) {
    throw new HttpError(400, 'search query must not contain control characters');
  }

  // Titles: the query is a literal, not a pattern — escape LIKE wildcards.
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const titleRows = stmt("SELECT * FROM conversations WHERE title LIKE ? ESCAPE '\\'").all(
    like,
  ) as Record<string, unknown>[];

  // Treat tokens as literal phrases; prefix-match the last for search-as-you-type.
  const tokens = q.split(/\s+/).filter(Boolean);
  const ftsQuery = tokens
    .map((token, i) => `"${token.replaceAll('"', '""')}"${i === tokens.length - 1 ? '*' : ''}`)
    .join(' ');
  // Dedupe before limiting so one chat's matching messages cannot crowd out other chats.
  const contentRows = ftsQuery
    ? (stmt(
        `SELECT DISTINCT c.*
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ?`,
      ).all(ftsQuery) as Record<string, unknown>[])
    : [];
  const contentIds = new Set(contentRows.map((row) => row.id as number));

  const byId = new Map(titleRows.map((row) => [row.id as number, row]));
  for (const row of contentRows) byId.set(row.id as number, row);
  const conversations = [...byId.values()]
    .map(toConversation)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50);

  // snippet() requires a plain FTS select; query only the conversations being returned.
  const bestSnippet = stmt(
    `SELECT snippet(messages_fts, 0, '', '', '…', 24) AS snip
     FROM messages_fts
     JOIN messages m ON m.id = messages_fts.rowid
     WHERE messages_fts MATCH ? AND m.conversation_id = ?
     ORDER BY rank
     LIMIT 1`,
  );
  return conversations.map((conversation) => ({
    conversation,
    snippet: contentIds.has(conversation.id)
      ? ((bestSnippet.get(ftsQuery, conversation.id) as { snip: string }).snip ?? null)
      : null,
  }));
});

route.post('/api/conversations/:id/messages', ({ params, body }) => {
  const id = positiveId(params.id);
  const conv = getConversation(id);
  const b = objectBody(body);
  const content = requiredString(b, 'content');
  requireBodyPrecondition(id, b);
  cancelBackgroundSwipe(id);
  if (hasActiveGeneration(id))
    throw new HttpError(409, 'a generation is already running in this conversation');

  const userMsg = appendMessage(id, 'user', content, conv.activeLeafId);
  if (conv.title === 'New chat') {
    stmt('UPDATE conversations SET title = ? WHERE id = ?').run(derivedTitle(content), id);
  }
  const mid = spawnAssistantReply(conv, userMsg.id);
  invalidate('conversations');
  return { userMessageId: userMsg.id, assistantMessageId: mid };
});

/** Delete the active-path tail, including sibling alternatives and every descendant tree. */
route.post('/api/conversations/:id/delete-tail', ({ params, body }) => {
  const id = positiveId(params.id);
  getConversation(id);
  const b = objectBody(body);
  const count = b.count;
  if (!Number.isSafeInteger(count) || (count as number) <= 0) {
    throw new HttpError(400, 'count must be a positive integer');
  }
  requireBodyPrecondition(id, b);
  const path = getActivePath(id);
  if (path.length === 0) throw new HttpError(400, 'conversation has no messages to delete');
  const cutoff = path[Math.max(0, path.length - (count as number))]!;

  cancelSpeculativeRetries(id);
  stopConversationGenerations(id);
  const doomedImages = collectSiblingSubtreeImages(id, cutoff.parentId);
  const deleted = transaction(() => {
    const result = stmt('DELETE FROM messages WHERE conversation_id = ? AND parent_id IS ?').run(
      id,
      cutoff.parentId,
    );
    setActiveLeaf(id, cutoff.parentId);
    return result.changes;
  });
  deleteImageFiles(doomedImages);
  touchConversation(id);
  broadcastTree(id);
  prepareActiveSwipe(id);
  invalidate('conversations');
  return { activeLeafId: cutoff.parentId, deletedSiblingRoots: deleted };
});
