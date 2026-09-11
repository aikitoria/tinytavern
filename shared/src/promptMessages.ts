import { systemNote } from './index.ts';
import type { Endpoint } from './entityFields.ts';

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning_content?: string;
  prefix?: boolean;
}

export interface ChatPrompt {
  messages: PromptMessage[];
  reasoningPrefill: string | null;
  messagePrefill: string | null;
  namePrefill: string | null;
  speakerHandoff: string | null;
}

interface PrefillCapabilities {
  prefillMode: Endpoint['prefillMode'];
  allowReasoningPrefill?: boolean;
  allowMessagePrefill?: boolean;
}

export function messagePrefillEnabled(options: PrefillCapabilities): boolean {
  return options.prefillMode !== 'disabled' && options.allowMessagePrefill !== false;
}

export function reasoningPrefillEnabled(options: PrefillCapabilities): boolean {
  return options.prefillMode !== 'disabled' && options.allowReasoningPrefill !== false;
}

/** Server-resolved history and seeds; the browser adds only its unsent composer text. */
export interface PromptTrace extends ChatPrompt, PrefillCapabilities {
  userMessagePrefix: string;
  /** Source assistant IDs per upstream turn; adjacent assistant messages may be merged. */
  messageIds?: number[][];
  /** The captured request history; reply buffers arrive through the existing tree stream. */
  stream?: { messageId: number; generationToken: number; namePrefix: string };
}

/** A fresh reply prefill belongs after a user turn, never inside a historical assistant turn. */
export function preparePromptTrace(trace: PromptTrace, pendingMessage: string) {
  if (trace.stream || (!pendingMessage.trim() && trace.messages.at(-1)?.role !== 'user')) {
    return {
      messages: trace.messages,
      prefilled: false,
      pendingMessageIndex: null,
      prefillMessageIndex: null,
    };
  }
  return prepareChatMessages(trace, {
    prefillMode: trace.prefillMode,
    allowReasoningPrefill: trace.allowReasoningPrefill,
    allowMessagePrefill: trace.allowMessagePrefill,
    userMessagePrefix: trace.userMessagePrefix,
    pendingMessage,
  });
}

/** Merge adjacent same-role turns from tree edits/prologues for strict upstream APIs. */
export function appendChatMessage(messages: PromptMessage[], message: PromptMessage): void {
  if (message.role === 'system' && messages.length > 0) {
    const leading = messages[0]?.role === 'system' ? messages[0] : null;
    if (leading) {
      if (message.content) {
        leading.content = leading.content
          ? `${leading.content}\n\n${message.content}`
          : message.content;
      }
      return;
    }
    messages.unshift(message);
    return;
  }
  const previous = messages.at(-1);
  if (previous && previous.role === message.role) {
    if (message.content) {
      previous.content = previous.content
        ? `${previous.content}\n\n${message.content}`
        : message.content;
    }
    if (message.reasoning_content) {
      previous.reasoning_content = previous.reasoning_content
        ? `${previous.reasoning_content}\n\n${message.reasoning_content}`
        : message.reasoning_content;
    }
    return;
  }
  messages.push(message);
}

/** Keep a handoff immediately before its reply, including consecutive assistant turns. */
export function appendSpeakerHandoff(messages: PromptMessage[], instruction: string): void {
  const note = systemNote(instruction);
  if (!note) return;
  const previous = messages.at(-1);
  if (previous?.role === 'user') {
    messages[messages.length - 1] = { ...previous, content: `${previous.content}\n${note}` };
  } else appendChatMessage(messages, { role: 'user', content: note });
}

/** Shared by live generations and the prompt trace, including strict role ordering. */
export function prepareChatMessages(
  prompt: ChatPrompt,
  options: PrefillCapabilities & {
    content?: string;
    reasoning?: string;
    pendingMessage?: string;
    userMessagePrefix?: string;
  },
) {
  // Preserve unchanged message identities so typing in trace only redraws the pending tail.
  const messages = prompt.messages.slice();
  const append = (message: PromptMessage) => {
    const last = messages.at(-1);
    if (last?.role === message.role) messages[messages.length - 1] = { ...last };
    appendChatMessage(messages, message);
  };
  const pending = options.pendingMessage?.trim();
  let pendingMessageIndex: number | null = null;
  if (pending) {
    append({
      role: 'user',
      content: (options.userMessagePrefix ?? '') + pending,
    });
    pendingMessageIndex = messages.length - 1;
  }
  let prefillMessageIndex: number | null = null;
  const allowMessage = messagePrefillEnabled(options);
  if (!allowMessage || !prompt.namePrefill)
    appendSpeakerHandoff(messages, prompt.speakerHandoff ?? '');
  const content = allowMessage ? (options.content ?? prompt.messagePrefill ?? '') : '';
  const reasoning = reasoningPrefillEnabled(options)
    ? (options.reasoning ?? prompt.reasoningPrefill ?? '')
    : '';
  const name = allowMessage ? prompt.namePrefill : null;
  if (content || reasoning || name) {
    append({
      role: 'assistant',
      content: name ? (content ? `${name} ${content}` : name) : content,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    });
    prefillMessageIndex = messages.length - 1;
    if (options.prefillMode === 'deepseek') messages[prefillMessageIndex]!.prefix = true;
  }
  return {
    messages,
    prefilled: prefillMessageIndex !== null,
    pendingMessageIndex,
    prefillMessageIndex,
  };
}
