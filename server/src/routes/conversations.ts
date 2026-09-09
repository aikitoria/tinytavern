// Keep route handlers synchronous between check and act: an `await` lets other
// handlers or generation callbacks invalidate generation and active-leaf guards.
import { copyConversation, insertCopiedMessage } from '../conversations/conversationCopies.ts';
import type { MessageRow } from '../conversations/conversationCopies.ts';
import { characterChatName, type Conversation, type Message } from '@tinytavern/shared';
import {
  deleteConversationRows,
  deleteMessageSubtrees,
  stmt,
  toConversation,
  toMessage,
  transaction,
} from '../db/db.ts';
import { getConversation, touchConversation } from '../conversations/conversationStore.ts';
import { route, HttpError } from '../http/router.ts';
import {
  appendMessage,
  insertMessageAfter,
  getActiveLeafId,
  getActivePath,
  getMessage,
  getPathToMessage,
  setActiveLeaf,
  takeDirtyMessageIds,
} from '../conversations/tree.ts';
import { requireReference } from './shared/entityUtils.ts';
import {
  buildChatMessages,
  buildToolPrompt,
  getCharacter,
  getPersona,
  substituteMacros,
  withDisabledPrefillSpeakerNote,
} from '../generation/prompt.ts';
import type { BuiltPrompt } from '../generation/prompt.ts';
import { clearSettingReference, getSettings } from '../settings/settingsStore.ts';
import {
  chatCompletionOnce,
  hasActiveGeneration,
  hasActiveNonToolGeneration,
  hasForegroundGeneration,
  mergeLiveBuffers,
  startGeneration,
  stopConversationGenerations,
} from '../generation/generation.ts';
import { broadcastTree, treeSnapshot } from '../realtime/sync.ts';
import { invalidate, hasConversationSubscribers } from '../realtime/events.ts';
import {
  cancelBackgroundSwipe,
  cancelSpeculativeRetries,
  prepareActiveSwipe,
  prepareNextSwipe,
  discardSpeculativeSwipes,
} from '../generation/speculation.ts';
import { requireBodyPrecondition, requireQueryPrecondition } from './shared/mutationGuard.ts';
import {
  collectConversationImages,
  collectSiblingSubtreeImages,
  deleteImageFiles,
} from '../media/images.ts';
import { parseImageConfig } from '../media/mediaSettings.ts';
import { startImageRender } from '../media/mediaImageAdapter.ts';
import { createImageRecipe } from '../media/mediaRecipes.ts';
import { bumpConversationRevision } from '../conversations/conversationRevision.ts';
import {
  objectBody,
  optionalNullableId,
  optionalNullableString,
  optionalString,
  positiveId,
  requiredString,
} from '../http/validation.ts';

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

/** Commands and revisions share prompt finalization and the handoff to the media worker. */
export function spawnToolReply(
  conversation: Conversation,
  prompt: BuiltPrompt,
  label: string | null,
  recipeId: number | null,
  afterId?: number,
): number {
  const { id } =
    afterId === undefined
      ? appendMessage(
          conversation.id,
          'tool',
          '',
          conversation.activeLeafId,
          'streaming',
          null,
          label,
        )
      : insertMessageAfter(conversation.id, 'tool', '', afterId, 'streaming', null, label);
  if (recipeId)
    stmt('UPDATE messages SET image_pending = 1, render_recipe_id = ? WHERE id = ?').run(
      recipeId,
      id,
    );
  touchConversation(conversation.id);
  startGeneration(getConversation(conversation.id), id, undefined, {
    prompt,
    onDone: recipeId ? () => startImageRender(id) : undefined,
  });
  broadcastTree(conversation.id);
  invalidate('conversations');
  return id;
}

/** The placeholder title a greeting-less conversation gets from its first message. */
function derivedTitle(content: string): string {
  return content.length > 60 ? `${content.slice(0, 57)}…` : content;
}

async function requestTitle(conv: Conversation, history: Message[]): Promise<string | null> {
  try {
    const built = buildToolPrompt(conv, history, getSettings().titlePrompt);
    const raw = await chatCompletionOnce(
      conv,
      built.messages,
      // Leave room for reasoning before the short visible title.
      1024,
      { reasoningPrefill: built.reasoningPrefill },
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

const activeTitles = new Set<number>();

/** Name the chat after its first user turn and completed reply, including character greetings. */
function maybeAutoTitle(conversationId: number, assistantMessageId: number): void {
  if (activeTitles.has(conversationId)) return;
  const pending = stmt('SELECT auto_title_pending FROM conversations WHERE id = ?').get(
    conversationId,
  );
  if (!pending?.auto_title_pending) return;
  const history = getPathToMessage(assistantMessageId);
  if (history.filter((message) => message.role === 'user').length !== 1) return;
  const conv = getConversation(conversationId);
  activeTitles.add(conversationId);
  void requestTitle(conv, history).then((title) => {
    activeTitles.delete(conversationId);
    // A manual rename clears pending, including a rename to the same placeholder text.
    if (title) {
      const result = stmt(
        'UPDATE conversations SET title = ?, auto_title_pending = 0 WHERE id = ? AND auto_title_pending = 1',
      ).run(title, conversationId);
      if (result.changes) invalidate('conversations');
    } else {
      stmt('UPDATE conversations SET auto_title_pending = 0 WHERE id = ?').run(conversationId);
    }
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
  const deleted = deleteConversationRows(ids);
  for (const id of ids) takeDirtyMessageIds(id);
  deleteImageFiles(doomedImages);
  invalidate('conversations');
  return { deleted };
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
      `INSERT INTO conversations (title, character_id, persona_id, created_at, updated_at, auto_title_pending)
         VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(
      // Keep a useful initial label until the first user exchange is summarized.
      character?.firstMessage.trim() ? character.name : 'New chat',
      character?.id ?? null,
      persona?.id ?? null,
      now,
      now,
    );
    const convId = Number(result.lastInsertRowid);
    if (character?.firstMessage.trim()) {
      const sub = (text: string) =>
        substituteMacros(text, characterChatName(character), persona?.name ?? 'User');
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
      scenario_override = ?, auto_title_pending = CASE WHEN ? THEN 0 ELSE auto_title_pending END
     WHERE id = ?`,
  ).run(
    title !== undefined ? title.trim() : conv.title,
    characterId !== undefined ? characterId : conv.characterId,
    personaId !== undefined ? personaId : conv.personaId,
    endpointId !== undefined ? endpointId : conv.endpointId,
    speakerName !== undefined ? speakerName?.trim() || null : conv.speakerName,
    scenarioOverride !== undefined ? scenarioOverride : conv.scenarioOverride,
    title !== undefined ? 1 : 0,
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
  deleteConversationRows([id]);
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
  const liveMessages = mergeLiveBuffers(
    rows.map((row) => toMessage(row as unknown as Record<string, unknown>)),
  );
  const sourceActivePath = getActivePath(id).map((message) => message.id);
  const newId = copyConversation(conv, ' (copy)', (newConvId, writtenImages) => {
    const idMap = new Map<number, number>();
    for (const [index, live] of liveMessages.entries()) {
      const row = rows[index]!;
      idMap.set(live.id, insertCopiedMessage(newConvId, null, row, live, writtenImages));
    }
    // Remap links after all rows exist: moves and insertions can put older rows under newer ones.
    for (const message of liveMessages) {
      const mappedParent = message.parentId != null ? (idMap.get(message.parentId) ?? null) : null;
      const mappedChild =
        message.activeChildId != null ? (idMap.get(message.activeChildId) ?? null) : null;
      stmt('UPDATE messages SET parent_id = ?, active_child_id = ? WHERE id = ?').run(
        mappedParent,
        mappedChild,
        idMap.get(message.id)!,
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
  const liveMessages = mergeLiveBuffers(path);
  const newId = copyConversation(conv, ' (branch)', (newConvId, writtenImages) => {
    let parentId: number | null = null;

    for (const [index, live] of liveMessages.entries()) {
      const row = rows[index]!;
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
  const image = b.image == null ? null : parseImageConfig(b.image);
  requireBodyPrecondition(id, b);
  // Don't refill speculation: swiping the previous reply requires a branch switch, which refills.
  cancelBackgroundSwipe(id);
  // Tool streams can overlap: each snapshots history, which excludes tool output.
  // Assistant streams conflict because their incomplete replies enter that history.
  if (hasActiveNonToolGeneration(id))
    throw new HttpError(409, 'a generation is already running in this conversation');

  // Snapshot pre-tool history so retries use the same context.
  const built = buildToolPrompt(conv, getActivePath(id), prompt);
  const mid = spawnToolReply(
    conv,
    built,
    label?.trim() || null,
    image ? createImageRecipe(image, '') : null,
  );
  return { toolMessageId: mid, activeLeafId: mid };
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
    stmt('UPDATE conversations SET title = ? WHERE id = ? AND auto_title_pending = 1').run(
      derivedTitle(content),
      id,
    );
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
    const roots = stmt('SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ?')
      .all(id, cutoff.parentId)
      .map((row) => Number(row.id));
    deleteMessageSubtrees(roots);
    setActiveLeaf(id, cutoff.parentId);
    return roots.length;
  });
  deleteImageFiles(doomedImages);
  touchConversation(id);
  broadcastTree(id);
  prepareActiveSwipe(id);
  invalidate('conversations');
  return { activeLeafId: cutoff.parentId, deletedSiblingRoots: deleted };
});
