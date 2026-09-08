import type { ChatMessage } from './prompt.ts';

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
 * Add the upstream-only draft instruction with nonempty, alternating turns
 * for strict chat APIs; merge consecutive same-role messages.
 */
export function buildDraftCompletionMessages(
  history: ChatMessage[],
  draft: string,
  template: string,
): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  for (const source of history) {
    const content = source.content.trim();
    // Strict APIs need visible content even for reasoning-only responses.
    if (!content && !source.reasoning_content?.trim()) continue;
    const message: ChatMessage = {
      ...source,
      content: content || '(No visible response)',
    };
    const previous = normalized[normalized.length - 1];
    if (previous && previous.role === message.role) {
      previous.content = `${previous.content}\n\n${message.content}`;
      if (message.reasoning_content) {
        previous.reasoning_content = previous.reasoning_content
          ? `${previous.reasoning_content}\n\n${message.reasoning_content}`
          : message.reasoning_content;
      }
    } else {
      normalized.push(message);
    }
  }

  const request = expandPromptSlots(systemNote(template), { draft });
  const previous = normalized[normalized.length - 1];
  if (previous?.role === 'user') previous.content += `\n\n${request}`;
  else normalized.push({ role: 'user', content: request });
  return normalized;
}
