import type { ChatMessage } from './prompt.ts';
import { appendChatMessage } from './prompt.ts';

import { expandPromptSlots, systemNote } from '@tinytavern/shared';

/** Verify the verbatim draft prefix and stream only the new continuation. */
export class DraftSuffixFilter {
  private readonly draft: string;
  private matched = 0;

  constructor(draft: string) {
    this.draft = draft;
  }

  push(delta: string): string {
    const prefixLength = Math.min(delta.length, this.draft.length - this.matched);
    for (let index = 0; index < prefixLength; index++) {
      if (delta[index] !== this.draft[this.matched + index]) {
        throw new Error('The model changed the existing draft. Your original text has been kept.');
      }
    }
    this.matched += prefixLength;
    return delta.slice(prefixLength);
  }

  finish(): void {
    if (this.matched !== this.draft.length) {
      throw new Error(
        'The model stopped before repeating the complete draft. Your original text has been kept.',
      );
    }
  }
}

/**
 * Append the draft instruction to the fresh, normalized buildChatMessages result.
 */
export function buildDraftCompletionMessages(
  history: ChatMessage[],
  draft: string,
  template: string,
): ChatMessage[] {
  const request = expandPromptSlots(systemNote(template), { draft });
  appendChatMessage(history, { role: 'user', content: request });
  return history;
}
