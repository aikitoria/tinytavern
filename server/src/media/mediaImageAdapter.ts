import { getMessage, markMessageDirty } from '../conversations/tree.ts';
import { broadcastTree } from '../realtime/sync.ts';
import { bumpConversationRevision } from '../conversations/conversationRevision.ts';
import { newRequestId } from '@tinytavern/shared';
import type { Message } from '@tinytavern/shared';
import { stmt, transaction } from '../db/db.ts';
import { createMediaJobFromRecipe, startMediaJob } from './mediaJobs.ts';
import { requireMediaJob, updateMediaJob, type MediaJobConfiguration, type MediaJobRow } from './mediaJobStore.ts';
import { tickMediaWorker } from './mediaWorker.ts';
import { messageRecipeId } from './mediaRecipes.ts';
import { HttpError } from '../http/router.ts';

/** A chat swipe reuses the full recipe, including image-edit inputs and output selection. */
export function startMessageImageRender(message: Message, recipeId = messageRecipeId(message)): MediaJobRow {
  if (!recipeId) {
    throw new HttpError(400, 'The message has no rendering recipe');
  }
  const result = transaction(() => {
    const draft = createMediaJobFromRecipe(recipeId, {
      requestKey: newRequestId(),
      prompt: message.content,
      contextConversationId: message.conversationId,
      destination: 'chat',
    });
    const job = requireMediaJob(draft.id);
    const configuration = JSON.parse(job.configuration_json!) as MediaJobConfiguration;
    updateMediaJob(job.id, {
      message_id: message.id,
      configuration_json: JSON.stringify({ ...configuration, messageRenderOnly: true }),
    });
    startMediaJob(requireMediaJob(job.id), {}, false);
    return requireMediaJob(job.id);
  });
  queueMicrotask(tickMediaWorker);
  return result;
}

/** Fire-and-forget; failures surface as genMeta.imageError. */
export function startImageRender(mid: number): void {
  const message = getMessage(mid);
  if (!message) return;
  try {
    startMessageImageRender(message);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[comfy] render failed for message ${mid}: ${error}`);
    const row = getMessage(mid);
    if (!row) return;
    const meta = JSON.stringify({ ...(row.genMeta ?? {}), imageError: error });
    stmt('UPDATE messages SET image_pending = 0, gen_meta_json = ? WHERE id = ? AND image_pending = 1').run(meta, mid);
    bumpConversationRevision(message.conversationId);
    markMessageDirty(message.conversationId, mid);
    broadcastTree(message.conversationId);
  }
}
