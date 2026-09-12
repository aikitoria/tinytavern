import type { ConversationPromptContext } from '@tinytavern/shared';
import { stmt } from './db.ts';
import type { MediaPromptContext } from '../media/mediaJobStore.ts';

interface PromptSeed {
  jobId: number;
  draftId: number;
  workflowName: string;
  endpointId: number | null;
  captured: MediaPromptContext | null;
  instruction: string;
  prompt: string;
  interrupted?: boolean;
}

/** Caller owns the transaction. Saved prompts retain their own discussion branch and job link. */
export function seedMediaPromptConversation(seed: PromptSeed): void {
  const draft = stmt('SELECT conversation_id FROM media_drafts WHERE id = ?').get(seed.draftId);
  const job = stmt('SELECT prompt_message_id FROM media_jobs WHERE id = ?').get(seed.jobId);
  if (!draft || !job || job.prompt_message_id !== null) {
    return;
  }
  const last = seed.captured?.messages.at(-1);
  const hasUser = last?.role === 'user' && Boolean(last.content.trim());
  const capturedMessages = seed.captured?.messages ?? [];
  const context: ConversationPromptContext = {
    messages: hasUser ? capturedMessages.slice(0, -1) : capturedMessages,
    reasoningPrefill: seed.captured?.template.reasoningPrefill ?? '',
    messagePrefill: seed.captured?.template.messagePrefill ?? '',
  };
  const endpointExists = seed.endpointId != null && stmt('SELECT id FROM endpoints WHERE id = ?').get(seed.endpointId);
  const endpointId = endpointExists ? seed.endpointId! : null;
  const instruction = hasUser ? last!.content.trim() : seed.instruction.trim() || 'Refine this media prompt.';
  const status = seed.interrupted ? 'error' : 'done';
  const metadata = seed.interrupted ? JSON.stringify({ error: 'Server restarted during prompt generation' }) : null;
  const now = Date.now();
  const existingConversation = draft.conversation_id !== null;
  let conversationId = Number(draft.conversation_id);
  if (!existingConversation) {
    const conversation = stmt(`INSERT INTO conversations
      (title, endpoint_id, prompt_context_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(`${seed.workflowName} prompts`, endpointId, JSON.stringify(context), now, now);
    conversationId = Number(conversation.lastInsertRowid);
  }
  const user = stmt(`INSERT INTO messages (conversation_id, role, content, created_at)
    VALUES (?, 'user', ?, ?)`).run(conversationId, instruction, now);
  const userId = Number(user.lastInsertRowid);
  const assistant = stmt(`INSERT INTO messages
    (conversation_id, parent_id, role, content, status, gen_meta_json, created_at)
    VALUES (?, ?, 'assistant', ?, ?, ?, ?)`).run(conversationId, userId, seed.prompt.trim(), status, metadata, now);
  const assistantId = Number(assistant.lastInsertRowid);
  stmt('UPDATE messages SET active_child_id = ? WHERE id = ?').run(assistantId, userId);
  if (existingConversation) {
    // Upgrades recover missing history without moving the branch the user was working on.
    stmt('UPDATE conversations SET mutation_revision = mutation_revision + 1 WHERE id = ?').run(conversationId);
  } else {
    stmt('UPDATE conversations SET active_leaf_id = ?, mutation_revision = 1 WHERE id = ?').run(
      assistantId,
      conversationId,
    );
  }
  stmt('UPDATE media_drafts SET conversation_id = ?, revision = revision + 1 WHERE id = ?').run(
    conversationId,
    seed.draftId,
  );
  stmt('UPDATE media_jobs SET prompt_message_id = ?, revision = revision + 1 WHERE id = ?').run(
    assistantId,
    seed.jobId,
  );
}

/** Recover every saved review prompt once, including links missed by the version 87 upgrade. */
export function migrateReviewPrompts(): void {
  const rows = stmt(`SELECT j.*, COALESCE(w.name, 'Media') AS workflow_name FROM media_jobs j
    JOIN media_drafts d ON d.id = j.draft_id
    LEFT JOIN media_workflows w ON w.id = j.workflow_id
    WHERE j.prompt_message_id IS NULL AND d.state = 'open'
      AND (trim(j.prompt) <> '' OR j.state = 'preparing') ORDER BY j.id`).all();
  for (const row of rows) {
    seedMediaPromptConversation({
      jobId: Number(row.id),
      draftId: Number(row.draft_id),
      workflowName: String(row.workflow_name),
      endpointId: row.endpoint_json ? (JSON.parse(String(row.endpoint_json)).id ?? null) : null,
      captured: row.context_json ? JSON.parse(String(row.context_json)) : null,
      instruction: String(row.instruction),
      prompt: String(row.prompt),
      interrupted: row.state === 'preparing',
    });
    if (row.state === 'preparing') {
      stmt(`UPDATE media_jobs SET state = 'ready', auto_render = 0,
        error = 'Server restarted during prompt generation; review the conversation before rendering'
        WHERE id = ?`).run(Number(row.id));
    }
  }
}
