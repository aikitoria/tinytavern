import type { CompletionUsage } from '@tinytavern/shared';

const IDLE_TIMEOUT_MS = 120_000;

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Observe activity without clearing and allocating a timer for every network chunk. */
export function startCompletionIdleWatchdog(onIdle: (error: Error) => void) {
  let lastActivity = Date.now();
  const check = () => {
    const remaining = IDLE_TIMEOUT_MS - (Date.now() - lastActivity);
    if (remaining > 0) {
      timer = setTimeout(check, remaining);
      return;
    }
    onIdle(new Error(`Upstream idle timeout — no data received for ${IDLE_TIMEOUT_MS / 1000}s`));
  };
  let timer = setTimeout(check, IDLE_TIMEOUT_MS);
  return {
    touch: () => {
      lastActivity = Date.now();
    },
    stop: () => clearTimeout(timer),
  };
}

/** Decode OpenAI data frames synchronously; callers own completion and cancellation policy.
 * A null finish reason denotes [DONE]. No additional per-token objects are allocated. */
export function completionDataReader(
  onDelta: (content: string, reasoning: string, refusal: string) => void,
  onFinish?: (reason: string | null) => void,
  onUsage?: (usage: CompletionUsage) => void,
): (data: string) => void {
  return (data) => {
    if (data === '[DONE]') {
      onFinish?.(null);
      return;
    }
    if (!data) return;
    let parsed: {
      error?: { message?: unknown };
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown };
        completion_tokens_details?: { reasoning_tokens?: unknown; text_tokens?: unknown };
      };
      choices?: {
        finish_reason?: unknown;
        delta?: {
          content?: unknown;
          reasoning_content?: unknown;
          reasoning?: unknown;
          refusal?: unknown;
        };
      }[];
    } | null;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // Ignore malformed upstream frames.
    }
    if (parsed?.error) {
      throw new Error(
        `Upstream stream error: ${
          typeof parsed.error.message === 'string'
            ? parsed.error.message.slice(0, 500)
            : 'Generation failed'
        }`,
      );
    }
    const usage = parsed?.usage;
    if (onUsage && usage) {
      const counts: CompletionUsage = {};
      const prompt = tokenCount(usage.prompt_tokens);
      const completion = tokenCount(usage.completion_tokens);
      const cached = tokenCount(usage.prompt_tokens_details?.cached_tokens);
      const reasoning = tokenCount(usage.completion_tokens_details?.reasoning_tokens);
      const text = tokenCount(usage.completion_tokens_details?.text_tokens);
      if (prompt != null) counts.promptTokens = prompt;
      if (completion != null) counts.completionTokens = completion;
      if (cached != null && (prompt == null || cached <= prompt)) counts.cachedTokens = cached;
      if (reasoning != null && (completion == null || reasoning <= completion))
        counts.reasoningTokens = reasoning;
      if (text != null && (completion == null || text <= completion)) counts.textTokens = text;
      onUsage(counts);
    }
    const choice = parsed?.choices?.[0];
    if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
      onFinish?.(choice.finish_reason);
    }
    const delta = choice?.delta;
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    onDelta(
      typeof delta?.content === 'string' ? delta.content : '',
      typeof reasoning === 'string' ? reasoning : '',
      typeof delta?.refusal === 'string' ? delta.refusal : '',
    );
  };
}
