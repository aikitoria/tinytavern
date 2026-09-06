import type { ChatMessage } from './prompt.ts';

const DRAFT_INSTRUCTION = `Complete the unfinished user input below at its exact cursor position.
Return only the missing continuation. Do not repeat any of the existing input. Do not add a speaker name, quotation marks, commentary, or an answer to the input.`;

/** Holds back a possible echo of the original draft until it can be ruled out. */
export class DraftSuffixFilter {
  private readonly draft: string;
  private held = '';
  private decided = false;

  constructor(draft: string) {
    this.draft = draft;
  }

  push(delta: string): string {
    if (this.decided) return delta;
    this.held += delta;
    if (this.draft.startsWith(this.held)) return '';
    this.decided = true;
    const output = this.held.startsWith(this.draft)
      ? this.held.slice(this.draft.length)
      : this.held;
    this.held = '';
    return output;
  }

  finish(): string {
    if (this.decided || this.held === this.draft) return '';
    const output = this.held;
    this.held = '';
    this.decided = true;
    return output;
  }
}

/**
 * Add the upstream-only draft instruction with nonempty, alternating turns
 * for strict chat APIs; merge consecutive same-role messages.
 */
export function buildDraftCompletionMessages(history: ChatMessage[], draft: string): ChatMessage[] {
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

  const request = `${DRAFT_INSTRUCTION}\n\n<unfinished_user_input>\n${draft}\n</unfinished_user_input>`;
  const previous = normalized[normalized.length - 1];
  if (previous?.role === 'user') previous.content += `\n\n${request}`;
  else normalized.push({ role: 'user', content: request });
  return normalized;
}
