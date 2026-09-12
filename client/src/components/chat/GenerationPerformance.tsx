import { For, Show } from 'solid-js';
import { generationTokensPerSecond, type GenerationAttemptMetrics, type GenerationMetrics } from '@tinytavern/shared';

const duration = (ms: number | undefined) => (ms == null ? '—' : `${(ms / 1000).toFixed(2)} s`);
const count = (tokens: number | undefined) => (tokens == null ? '—' : tokens.toLocaleString());

function AttemptMetrics(props: { attempt: GenerationAttemptMetrics }) {
  const rate = () => generationTokensPerSecond(props.attempt);
  const fields = () => [
    {
      label: 'Speed',
      value: rate() == null ? '—' : `${rate()!.toFixed(1)} t/s`,
      title:
        'Output tokens, including reasoning: (tokens − 1) / seconds between first and last output arrival. Network chunks may contain multiple tokens.',
    },
    { label: 'Request time', value: duration(props.attempt.elapsedMs) },
    { label: 'First output', value: duration(props.attempt.firstTokenMs) },
    { label: 'First reasoning', value: duration(props.attempt.firstReasoningMs) },
    { label: 'First visible text', value: duration(props.attempt.firstContentMs) },
    { label: 'Prompt tokens', value: count(props.attempt.promptTokens) },
    { label: 'Cached tokens', value: count(props.attempt.cachedTokens) },
    { label: 'Output tokens', value: count(props.attempt.completionTokens) },
    { label: 'Reasoning tokens', value: count(props.attempt.reasoningTokens) },
    { label: 'Text tokens', value: count(props.attempt.textTokens) },
  ];
  return (
    <dl class="grid grid-cols-2 mobile:grid-cols-1 gap-x-6 gap-y-1 m-0 text-caption tabular-nums">
      <For each={fields()}>
        {(field) => (
          <div class="flex justify-between gap-3" title={field.title}>
            <dt class="text-dim">{field.label}</dt>
            <dd class="m-0">{field.value}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}

export default function GenerationPerformance(props: { generations?: GenerationMetrics[] }) {
  return (
    <Show when={props.generations?.length}>
      <div
        class="flex flex-col gap-1 mt-2 border-t border-t-solid border-t-subtle pt-2"
        aria-label="Message generation performance"
      >
        <For each={props.generations}>
          {(generation, index) => {
            const latest = () => generation.attempts.at(-1);
            const speed = () => (latest() ? generationTokensPerSecond(latest()!) : undefined);
            return (
              <details>
                <summary class="cursor-pointer text-caption text-dim tabular-nums">
                  {generation.continuation ? 'Continuation' : 'Generation'}
                  {(props.generations?.length ?? 0) > 1 ? ` ${index() + 1}` : ''}
                  {speed() == null ? '' : ` · ${speed()!.toFixed(1)} t/s`}
                  {latest()?.firstTokenMs == null ? '' : ` · first output ${duration(latest()!.firstTokenMs)}`}
                  {generation.elapsedMs == null ? ' · running' : ` · ${duration(generation.elapsedMs)} total`}
                  {generation.speculative ? ' · speculative' : ''}
                </summary>
                <div class="flex flex-col gap-2 mt-2">
                  <Show when={generation.model}>
                    <p class="hint m-0">{generation.model}</p>
                  </Show>
                  <For each={generation.attempts}>
                    {(attempt, attemptIndex) => (
                      <div class="flex flex-col gap-1">
                        <p class="hint m-0">
                          {generation.attempts.length > 1 ? `Attempt ${attemptIndex() + 1} · ` : ''}
                          {attempt.status ?? 'running'}
                          {attempt.finishReason ? ` · ${attempt.finishReason}` : ''}
                        </p>
                        <AttemptMetrics attempt={attempt} />
                      </div>
                    )}
                  </For>
                  <p class="hint m-0">Token counts come from the endpoint. — means unavailable or not yet received.</p>
                </div>
              </details>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
