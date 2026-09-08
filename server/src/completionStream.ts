const IDLE_TIMEOUT_MS = 120_000;

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
): (data: string) => void {
  return (data) => {
    if (data === '[DONE]') {
      onFinish?.(null);
      return;
    }
    if (!data) return;
    let parsed: {
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
