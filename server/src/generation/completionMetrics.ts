import type { GenerationAttemptMetrics } from '@tinytavern/shared';

/** One allocation per request; only output chunks read the clock. */
export class CompletionMetrics {
  readonly data: GenerationAttemptMetrics = {};
  private readonly started: number;
  private readonly now: () => number;

  constructor(now = () => performance.now()) {
    this.now = now;
    this.started = now();
  }

  output(content: string, reasoning: string, refusal: string, visibleContent = content): boolean {
    if (this.data.elapsedMs != null || (!content && !reasoning && !refusal)) return false;
    const elapsed = this.now() - this.started;
    const first = this.data.firstTokenMs == null;
    const firstReasoning = this.data.firstReasoningMs == null && !!reasoning.trim();
    const firstContent = this.data.firstContentMs == null && !!visibleContent.trim();
    this.data.firstTokenMs ??= elapsed;
    this.data.lastTokenMs = elapsed;
    if (firstReasoning) this.data.firstReasoningMs = elapsed;
    if (firstContent) this.data.firstContentMs = elapsed;
    return first || firstReasoning || firstContent;
  }

  visible(): void {
    this.data.firstContentMs ??= this.now() - this.started;
  }

  finish(status: NonNullable<GenerationAttemptMetrics['status']>): void {
    if (this.data.elapsedMs != null) return;
    this.data.elapsedMs = this.now() - this.started;
    this.data.status = status;
  }
}
