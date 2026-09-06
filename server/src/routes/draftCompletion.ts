import { route, HttpError } from '../router.ts';
import type { Ctx } from '../router.ts';
import { getActivePath } from '../tree.ts';
import { buildChatMessages } from '../prompt.ts';
import { buildDraftCompletionMessages, DraftSuffixFilter } from '../draftCompletionPrompt.ts';
import { hasForegroundGeneration, streamChatCompletion } from '../generation.ts';
import { requireExpectedActiveLeaf } from '../concurrency.ts';
import { objectBody, optionalNullableId, optionalNumber, positiveId } from '../validation.ts';
import { streamResponse } from './streamResponse.ts';
import { getConversation } from './conversations.ts';

const DRAFT_COMPLETION_MAX_TOKENS = 1024;
const streaming = new Set<number>();

async function completeDraft(ctx: Ctx): Promise<void> {
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
  const messages = buildDraftCompletionMessages(built.messages, draft);
  streaming.add(conversationId);
  try {
    await streamResponse(ctx.res, async (send, signal) => {
      const suffix = new DraftSuffixFilter(draft);
      await streamChatCompletion(
        conversation,
        messages,
        DRAFT_COMPLETION_MAX_TOKENS,
        (delta) => {
          const output = suffix.push(delta);
          if (output) send({ d: output });
        },
        signal,
      );
      // Reject stale snapshots so the client discards suffix text after concurrent path edits.
      requireExpectedActiveLeaf(conversationId, expectedActiveLeafId, expectedMutationRevision);
      const tail = suffix.finish();
      if (tail) send({ d: tail });
    });
  } finally {
    streaming.delete(conversationId);
  }
}

route.post('/api/conversations/:id/complete-draft', completeDraft);
