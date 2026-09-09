import { route, HttpError } from '../http/router.ts';
import type { Ctx } from '../http/router.ts';
import { getActivePath } from '../conversations/tree.ts';
import { buildChatMessages } from '../generation/prompt.ts';
import {
  buildDraftCompletionMessages,
  DraftSuffixFilter,
} from '../generation/draftCompletionPrompt.ts';
import { hasForegroundGeneration, streamChatCompletion } from '../generation/generation.ts';
import { requireExpectedActiveLeaf } from '../conversations/concurrency.ts';
import { objectBody, optionalNullableId, optionalNumber, positiveId } from '../http/validation.ts';
import { streamResponse } from '../http/streamResponse.ts';
import { getSettings } from '../settings/settingsStore.ts';
import { getConversation } from '../conversations/conversationStore.ts';

const DRAFT_COMPLETION_MAX_TOKENS = 1024;
const streaming = new Set<number>();

function completeDraft(ctx: Ctx): Response {
  const conversationId = positiveId(ctx.params.id);
  const body = objectBody(ctx.body);
  const draft = body.draft;
  if (typeof draft !== 'string' || !draft.trim()) throw new HttpError(400, 'draft is required');
  const expectedActiveLeafId = optionalNullableId(body, 'expectedActiveLeafId');
  const expectedMutationRevision = optionalNumber(body, 'expectedMutationRevision');
  requireExpectedActiveLeaf(conversationId, expectedActiveLeafId, expectedMutationRevision);
  if (hasForegroundGeneration(conversationId)) {
    throw new HttpError(409, 'a generation is already running in this conversation');
  }
  if (streaming.has(conversationId)) {
    throw new HttpError(409, 'a draft completion is already running in this conversation');
  }

  const conversation = getConversation(conversationId);
  const built = buildChatMessages(conversation, getActivePath(conversationId));
  const messages = buildDraftCompletionMessages(
    built.messages,
    draft,
    getSettings().draftCompletionPrompt,
  );
  streaming.add(conversationId);
  try {
    return streamResponse(
      ctx.req,
      async (send, signal) => {
        const suffix = new DraftSuffixFilter(draft);
        await streamChatCompletion(
          conversation,
          messages,
          // Reserve room for the verbatim prefix as well as the continuation.
          DRAFT_COMPLETION_MAX_TOKENS + Buffer.byteLength(draft, 'utf8'),
          (delta) => {
            const output = suffix.push(delta);
            if (output) send({ d: output });
          },
          signal,
          { reasoningPrefill: built.reasoningPrefill },
        );
        // Reject stale snapshots so the client discards suffix text after concurrent path edits.
        requireExpectedActiveLeaf(conversationId, expectedActiveLeafId, expectedMutationRevision);
        suffix.finish();
      },
      () => streaming.delete(conversationId),
    );
  } catch (err) {
    streaming.delete(conversationId);
    throw err;
  }
}

route.post('/api/conversations/:id/complete-draft', completeDraft);
