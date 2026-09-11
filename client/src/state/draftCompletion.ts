import { createSignal } from 'solid-js';
import { streamTextCompletion } from './api.ts';

export function createDraftCompletion() {
  const [draftCompletionActive, setDraftCompletionActive] = createSignal(false);

  let activeAbort: AbortController | null = null;

  async function completeComposerDraft(options: {
    conversationId: number;
    draft: string;
    expectedActiveLeafId: number | null;
    expectedMutationRevision: number;
    onText: (text: string) => void;
  }): Promise<boolean> {
    if (activeAbort) return false;
    const abort = new AbortController();
    activeAbort = abort;
    setDraftCompletionActive(true);
    try {
      await streamTextCompletion(
        `/api/conversations/${options.conversationId}/complete-draft`,
        {
          draft: options.draft,
          expectedActiveLeafId: options.expectedActiveLeafId,
          expectedMutationRevision: options.expectedMutationRevision,
        },
        (_, text) => options.onText(options.draft + text),
        'draft completion',
        abort.signal,
      );
      return true;
    } catch (err) {
      options.onText(options.draft);
      if (abort.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return false;
      }
      throw err;
    } finally {
      if (activeAbort === abort) activeAbort = null;
      setDraftCompletionActive(false);
    }
  }

  function stopDraftCompletion(): void {
    activeAbort?.abort();
  }

  return { draftCompletionActive, completeComposerDraft, stopDraftCompletion };
}

export const mainDraftCompletion = createDraftCompletion();
export const { completeComposerDraft, draftCompletionActive, stopDraftCompletion } =
  mainDraftCompletion;
