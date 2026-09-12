import { type ConversationPromptContext } from '@tinytavern/shared';
import { deleteMessageSubtrees, stmt, transaction } from '../db/db.ts';
import { HttpError } from '../http/router.ts';
import { getConversation } from '../conversations/conversationStore.ts';
import { appendMessage, getMessage, setActiveLeaf } from '../conversations/tree.ts';
import { requireExpectedActiveLeaf } from '../conversations/concurrency.ts';
import { startGeneration, stopConversationGenerations } from '../generation/generation.ts';
import { cancelSpeculativeRetries } from '../generation/speculation.ts';
import { collectConversationImages, deleteImageFiles } from './images.ts';
import { broadcastTree } from '../realtime/sync.ts';
import { invalidate } from '../realtime/events.ts';
import { prepareContext, resolveJobConfiguration, startMediaJob } from './mediaJobs.ts';
import {
  mediaDraft,
  mediaJobRow,
  requireMediaJob,
  mediaLive,
  publishMediaJob,
  updateMediaJob,
  type MediaJobRow,
  type MediaPromptContext,
} from './mediaJobStore.ts';

/** Allocate once per draft. Render attempts and prompt branches share the same durable discussion. */
export function startMediaConversation(row: MediaJobRow, body: Record<string, unknown>, restart = false) {
  if (!row.draft_id) throw new HttpError(400, 'A prompt conversation requires a media draft');
  const draft = mediaDraft(row.draft_id);
  if (draft.state !== 'open') throw new HttpError(409, 'This media draft is closed');
  const requiresGuard = restart || draft.conversationId === null || body.expectedDraftRevision !== undefined;
  if (requiresGuard && body.expectedDraftRevision !== draft.revision) {
    throw new HttpError(409, 'The media draft changed; refresh and retry');
  }
  if (draft.conversationId != null && !restart) {
    if (body.autoRender === true) {
      throw new HttpError(409, 'Choose a reply to render or restart the prompt conversation');
    }
    return getConversation(draft.conversationId);
  }
  if (row.state !== 'draft' && row.state !== 'ready')
    throw new HttpError(409, 'Create a new variation before starting its prompt conversation');
  if (restart) {
    if (draft.conversationId == null) throw new HttpError(409, 'There is no prompt conversation to restart');
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
  const autoRender = body.autoRender === true;
  if (autoRender) row = { ...row, prompt: '' };
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
      VALUES (?, ?, ?, ?, ?)`).run(`${resolved.workflow.name} prompts`, endpoint.id, JSON.stringify(context), now, now)
          .lastInsertRowid,
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
    stmt('UPDATE media_drafts SET conversation_id = ?, revision = revision + 1 WHERE id = ?').run(id, draft.id);
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
    const messageId = assistantId;
    const expectedRevision = requireMediaJob(row.id).revision;
    const expectedDraftRevision = mediaDraft(draft.id).revision;
    const currentAttempt = () => {
      const current = mediaJobRow(row.id);
      if (!current || current.revision !== expectedRevision || current.draft_id !== draft.id) return;
      const latestDraft = mediaDraft(draft.id);
      if (latestDraft.state !== 'open' || latestDraft.revision !== expectedDraftRevision) return;
      return current;
    };
    const preparationFailed = (error: string) => {
      if (!currentAttempt()) return;
      updateMediaJob(row.id, { error });
      publishMediaJob(row.id);
    };
    startGeneration(getConversation(conversationId), messageId, undefined, {
      requireComplete: autoRender,
      onError: autoRender
        ? () => preparationFailed('Prompt generation failed; review the reply before rendering')
        : undefined,
      onDone: autoRender
        ? () => {
            const current = currentAttempt();
            if (!current) return;
            const conversation = getConversation(conversationId);
            const reply = getMessage(messageId);
            if (conversation.activeLeafId !== messageId || reply?.status !== 'done') return;
            try {
              startMediaJob(
                current,
                {
                  expectedActiveLeafId: body.expectedActiveLeafId,
                  expectedMutationRevision: body.expectedMutationRevision,
                  promptMessageId: messageId,
                  expectedPromptLeafId: conversation.activeLeafId,
                  expectedPromptRevision: conversation.mutationRevision,
                },
                false,
              );
              void import('./mediaWorker.ts').then(({ tickMediaWorker }) => tickMediaWorker());
            } catch (error) {
              preparationFailed(error instanceof Error ? error.message : String(error));
            }
          }
        : undefined,
    });
  }
  broadcastTree(conversationId);
  publishMediaJob(row.id);
  invalidate('conversations');
  return getConversation(conversationId);
}

export function restartMediaConversation(row: MediaJobRow, body: Record<string, unknown>) {
  return startMediaConversation(row, body, true);
}
