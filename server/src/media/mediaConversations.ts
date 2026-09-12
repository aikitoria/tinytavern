import {
  mediaJobActive,
  mediaPromptSettingsKey,
  type ConversationPromptContext,
} from '@tinytavern/shared';
import { deleteMessageSubtrees, stmt, transaction } from '../db/db.ts';
import { getSettings } from '../settings/settingsStore.ts';
import { HttpError } from '../http/router.ts';
import { getConversation } from '../conversations/conversationStore.ts';
import { appendMessage, setActiveLeaf } from '../conversations/tree.ts';
import { requireExpectedActiveLeaf } from '../conversations/concurrency.ts';
import { startGeneration, stopConversationGenerations } from '../generation/generation.ts';
import { cancelSpeculativeRetries } from '../generation/speculation.ts';
import { collectConversationImages, deleteImageFiles } from './images.ts';
import { broadcastTree } from '../realtime/sync.ts';
import { invalidate } from '../realtime/events.ts';
import { prepareContext, preparePromptContext, resolveJobConfiguration } from './mediaJobs.ts';
import {
  mediaDraft,
  mediaJobDto,
  requireMediaJob,
  mediaLive,
  publishMediaJob,
  updateMediaJob,
  type MediaJobRow,
  type MediaPromptContext,
} from './mediaJobStore.ts';

/** Allocate once per draft. Render attempts and prompt branches share the same durable discussion. */
export function startMediaConversation(
  row: MediaJobRow,
  body: Record<string, unknown>,
  restart = false,
) {
  if (!row.draft_id) throw new HttpError(400, 'A prompt conversation requires a media draft');
  const draft = mediaDraft(row.draft_id);
  if (draft.state !== 'open') throw new HttpError(409, 'This media draft is closed');
  if (draft.conversationId != null && !restart) return getConversation(draft.conversationId);
  if (body.expectedDraftRevision !== draft.revision)
    throw new HttpError(409, 'The media draft changed; refresh and retry');
  if (row.state !== 'draft' && row.state !== 'ready')
    throw new HttpError(409, 'Create a new variation before starting its prompt conversation');
  if (restart) {
    if (draft.conversationId == null)
      throw new HttpError(409, 'There is no prompt conversation to restart');
    requireExpectedActiveLeaf(
      draft.conversationId,
      body.expectedPromptLeafId as number | null | undefined,
      body.expectedPromptRevision as number | undefined,
    );
    // Restart always generates a fresh reply; the previous prompt must not seed it or its macros.
    row = { ...row, prompt: '' };
  }
  const resolved = resolveJobConfiguration(row.workflow_id, row.configuration_json);
  if (!resolved) throw new HttpError(400, 'Choose a saved workflow');
  if (row.context_conversation_id !== null)
    requireExpectedActiveLeaf(
      row.context_conversation_id,
      body.expectedActiveLeafId as number | null | undefined,
      body.expectedMutationRevision as number | undefined,
    );
  const prepared = prepareContext(row, resolved.configuration, resolved.workflow);
  const captured = JSON.parse(prepared.context_json) as MediaPromptContext;
  const firstUser = captured.messages.at(-1);
  if (!firstUser || firstUser.role !== 'user' || !firstUser.content.trim())
    throw new HttpError(400, 'The media template must produce a nonempty first user message');
  const context: ConversationPromptContext = {
    messages: captured.messages.slice(0, -1),
    reasoningPrefill: captured.template.reasoningPrefill,
    messagePrefill: captured.template.messagePrefill,
  };
  const endpoint = JSON.parse(prepared.endpoint_json) as { id: number };
  const oldConversationId = restart ? draft.conversationId : null;
  const oldImages = oldConversationId == null ? [] : collectConversationImages(oldConversationId);
  if (oldConversationId != null) {
    cancelSpeculativeRetries(oldConversationId);
    stopConversationGenerations(oldConversationId);
  }
  let assistantId: number | null = null;
  const conversationId = transaction(() => {
    const now = Date.now();
    const id =
      oldConversationId ??
      Number(
        stmt(`INSERT INTO conversations
      (title, endpoint_id, prompt_context_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(
          `${resolved.workflow.name} prompts`,
          endpoint.id,
          JSON.stringify(context),
          now,
          now,
        ).lastInsertRowid,
      );
    if (oldConversationId != null) {
      const roots = stmt('SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS NULL')
        .all(id)
        .map((message) => Number(message.id));
      deleteMessageSubtrees(roots);
      setActiveLeaf(id, null);
      stmt(
        `UPDATE conversations SET title = ?, endpoint_id = ?, prompt_context_json = ?, updated_at = ? WHERE id = ?`,
      ).run(`${resolved.workflow.name} prompts`, endpoint.id, JSON.stringify(context), now, id);
    }
    const user = appendMessage(id, 'user', firstUser.content, null);
    if (row.prompt.trim()) appendMessage(id, 'assistant', row.prompt, user.id);
    else assistantId = appendMessage(id, 'assistant', '', user.id, 'streaming').id;
    stmt('UPDATE media_drafts SET conversation_id = ?, revision = revision + 1 WHERE id = ?').run(
      id,
      draft.id,
    );
    updateMediaJob(row.id, {
      started_at: row.started_at ?? now,
      state: 'ready',
      ...(restart ? { prompt: '' } : {}),
    });
    return id;
  });
  if (restart) mediaLive.delete(row.id);
  deleteImageFiles(oldImages);
  if (assistantId !== null) {
    startGeneration(getConversation(conversationId), assistantId);
  }
  broadcastTree(conversationId);
  publishMediaJob(row.id);
  invalidate('conversations');
  return getConversation(conversationId);
}

export function restartMediaConversation(row: MediaJobRow, body: Record<string, unknown>) {
  return startMediaConversation(row, body, true);
}

/** Lazily import a saved prompt without generating text or changing the render snapshot. */
export function migrateMediaConversation(row: MediaJobRow, body: Record<string, unknown>) {
  const draft = row.draft_id == null ? null : mediaDraft(row.draft_id);
  if (draft?.conversationId != null || !row.prompt.trim() || mediaJobActive(row.state))
    return mediaJobDto(row);
  if (draft?.state === 'discarding')
    throw new HttpError(409, 'This media draft is being discarded');
  if (draft && body.expectedDraftRevision !== draft.revision)
    throw new HttpError(409, 'The media draft changed; refresh and retry');

  const resolved = resolveJobConfiguration(row.workflow_id, row.configuration_json);
  const settings = getSettings();
  let captured: MediaPromptContext | null = row.context_json ? JSON.parse(row.context_json) : null;
  if (!captured && resolved) {
    if (row.context_conversation_id !== null)
      requireExpectedActiveLeaf(
        row.context_conversation_id,
        body.expectedActiveLeafId as number | null | undefined,
        body.expectedMutationRevision as number | undefined,
      );
    // Deleted presets must not prevent recovering the saved reply. Use the current default.
    const presets = settings[mediaPromptSettingsKey(row.context_conversation_id !== null)].presets;
    const available = (id: string | null | undefined) =>
      id != null && presets.some((preset) => preset.id === id) ? id : null;
    const prepared = preparePromptContext(
      { ...row, preset_id: available(row.preset_id) ?? null },
      resolved.configuration,
      {
        ...resolved.workflow,
        standalonePromptPresetId: available(resolved.workflow.standalonePromptPresetId),
        chatPromptPresetId: available(resolved.workflow.chatPromptPresetId),
      },
    );
    captured = JSON.parse(prepared.context_json);
  }
  const last = captured?.messages.at(-1);
  const hasUser = last?.role === 'user' && Boolean(last.content.trim());
  const context: ConversationPromptContext = {
    messages: captured ? (hasUser ? captured.messages.slice(0, -1) : captured.messages) : [],
    reasoningPrefill: captured?.template.reasoningPrefill ?? '',
    messagePrefill: captured?.template.messagePrefill ?? '',
  };
  const capturedEndpoint = row.endpoint_json ? JSON.parse(row.endpoint_json).id : null;
  const endpointId = capturedEndpoint ?? settings.activeEndpointId;
  const conversationId = transaction(() => {
    const now = Date.now();
    const id = Number(
      stmt(`INSERT INTO conversations
      (title, endpoint_id, prompt_context_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(
        `${resolved?.workflow.name ?? 'Media'} prompts`,
        endpointId != null && stmt('SELECT id FROM endpoints WHERE id = ?').get(endpointId)
          ? endpointId
          : null,
        JSON.stringify(context),
        now,
        now,
      ).lastInsertRowid,
    );
    const user = appendMessage(
      id,
      'user',
      hasUser ? last!.content : row.instruction.trim() || 'Refine this media prompt.',
      null,
    );
    const assistant = appendMessage(id, 'assistant', row.prompt, user.id);
    const draftId =
      draft?.id ?? Number(stmt('INSERT INTO media_drafts DEFAULT VALUES').run().lastInsertRowid);
    stmt('UPDATE media_drafts SET conversation_id = ?, revision = revision + 1 WHERE id = ?').run(
      id,
      draftId,
    );
    stmt(`UPDATE media_jobs SET draft_id = ?, prompt_message_id = ?, revision = revision + 1,
      updated_at = ? WHERE id = ?`).run(draftId, assistant.id, now, row.id);
    return id;
  });
  broadcastTree(conversationId);
  publishMediaJob(row.id);
  invalidate('conversations');
  return mediaJobDto(requireMediaJob(row.id));
}
