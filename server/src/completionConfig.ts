import type { Endpoint, GenParams } from '@tinytavern/shared';
import type { ChatMessage } from './prompt.ts';

export interface CompletionOptions {
  useEndpointParameters?: boolean;
  reasoningPrefill?: string | null;
  messagePrefill?: string | null;
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
  const enabled = endpoint.prefillMode !== 'disabled';
  const messagePrefill = enabled ? options.messagePrefill || '' : '';
  const reasoningPrefill = enabled ? options.reasoningPrefill || '' : '';
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
  return { messages, parameters, messagePrefill };
}
