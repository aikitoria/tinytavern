import { Show, type JSX } from 'solid-js';

/** Presentation only; render jobs and their fallback status belong to the caller. */
export default function SamplerProgress(props: {
  progress?: { value?: number; max?: number } | null;
  stepsClass?: string;
  fallback?: JSX.Element;
}) {
  return (
    <Show
      when={props.progress?.value !== undefined && props.progress.max}
      fallback={props.fallback}
    >
      <span class="img-progress">
        <span
          class="img-progress-fill"
          style={{ width: `${Math.round((props.progress!.value! / props.progress!.max!) * 100)}%` }}
        />
      </span>
      <span class={props.stepsClass}>
        {props.progress!.value}/{props.progress!.max}
      </span>
    </Show>
  );
}
