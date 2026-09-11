export interface CompletionUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  textTokens?: number;
}

/** Durations use a monotonic server clock and exclude saved assistant prefills. */
export interface GenerationAttemptMetrics extends CompletionUsage {
  elapsedMs?: number;
  firstTokenMs?: number;
  firstReasoningMs?: number;
  firstContentMs?: number;
  lastTokenMs?: number;
  finishReason?: string;
  status?: 'done' | 'error' | 'stopped';
}

export interface GenerationMetrics {
  generationToken: number;
  model: string | null;
  continuation: boolean;
  /** Remains true if a speculative reply is subsequently promoted. */
  speculative: boolean;
  elapsedMs?: number;
  attempts: GenerationAttemptMetrics[];
}

/** First-to-last arrival rate; N tokens span N−1 token intervals. */
export function generationTokensPerSecond(attempt: GenerationAttemptMetrics): number | undefined {
  const tokens = attempt.completionTokens;
  const streamMs = (attempt.lastTokenMs ?? 0) - (attempt.firstTokenMs ?? 0);
  return tokens != null && tokens > 1 && attempt.firstTokenMs != null && streamMs > 0
    ? ((tokens - 1) * 1000) / streamMs
    : undefined;
}
