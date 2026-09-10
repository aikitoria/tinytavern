import {
  messagePrefillEnabled,
  reasoningPrefillEnabled,
  type Endpoint,
  type GenParams,
} from '@tinytavern/shared';
import type { ChatMessage } from './prompt.ts';

export interface CompletionOptions {
  useEndpointParameters?: boolean;
  reasoningPrefill?: string | null;
  messagePrefill?: string | null;
}

/** Applied only at the wire boundary so snapshots and retries never accumulate additions. */
export function withEndpointSystemPrompt(endpoint: Endpoint, source: ChatMessage[]): ChatMessage[] {
  const prefix = endpoint.systemPromptPrefix;
  const suffix = endpoint.systemPromptSuffix;
  if (!prefix && !suffix) return source;
  const index = source.findIndex((message) => message.role === 'system');
  if (index === -1) return [{ role: 'system', content: prefix + suffix }, ...source];
  const messages = source.slice();
  messages[index] = { ...source[index]!, content: prefix + source[index]!.content + suffix };
  return messages;
}

export function endpointReasoningPrefill(
  endpoint: Endpoint,
  source: string | null | undefined,
  continuing = false,
): string {
  if (!reasoningPrefillEnabled(endpoint)) return '';
  const prefix = endpoint.reasoningPrefillPrefix;
  const text = source ?? '';
  if (!prefix) return text;
  if (continuing) {
    if (text.startsWith(prefix)) return text;
    // Finalized reasoning is trimmed before storage; restore the prefix's original whitespace.
    if (text === prefix.trim()) return prefix;
    const storedPrefix = prefix.trimStart();
    if (text.startsWith(storedPrefix)) return prefix + text.slice(storedPrefix.length);
  }
  return prefix + text;
}

/** Shared parameter mapping for foreground chat and standalone prompt tasks. */
export function generationParameters(
  params: GenParams,
  fallbackMaxTokens?: number,
): Record<string, unknown> {
  const maxTokens = params.maxTokens ?? fallbackMaxTokens;
  return {
    ...(params.temperature != null ? { temperature: params.temperature } : {}),
    ...(params.topP != null ? { top_p: params.topP } : {}),
    ...(params.minP != null ? { min_p: params.minP } : {}),
    ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
    ...(params.frequencyPenalty != null ? { frequency_penalty: params.frequencyPenalty } : {}),
    ...(params.presencePenalty != null ? { presence_penalty: params.presencePenalty } : {}),
    ...(params.reasoningEffort != null ? { reasoning_effort: params.reasoningEffort } : {}),
  };
}

export function prepareStandaloneCompletion(
  endpoint: Endpoint,
  source: ChatMessage[],
  maxTokens: number,
  options: CompletionOptions = {},
) {
  const messages: (ChatMessage & { prefix?: boolean })[] = source.map((message) => ({
    ...message,
  }));
  const parameters = options.useEndpointParameters
    ? generationParameters(endpoint.genParams, maxTokens)
    : { max_tokens: maxTokens };
  const messagePrefill = messagePrefillEnabled(endpoint) ? options.messagePrefill || '' : '';
  const reasoningPrefill = endpointReasoningPrefill(endpoint, options.reasoningPrefill);
  if (messagePrefill || reasoningPrefill) {
    messages.push({
      role: 'assistant',
      content: messagePrefill,
      ...(reasoningPrefill ? { reasoning_content: reasoningPrefill } : {}),
      ...(endpoint.prefillMode === 'deepseek' ? { prefix: true } : {}),
    });
    if (endpoint.prefillMode === 'vllm') {
      parameters.continue_final_message = true;
      parameters.add_generation_prompt = false;
    }
  }
  return { messages, parameters, messagePrefill, reasoningPrefill };
}
