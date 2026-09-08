import { Show, createEffect, onCleanup } from 'solid-js';
import { faSpinner } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';

/** Reasoning is a temporary preview, never the editable or rendered prompt. */
export default function PromptGenerationStatus(props: {
  active: boolean;
  content: string;
  reasoning?: string | null;
  showStatus?: boolean;
}) {
  let preview: HTMLDivElement | undefined;
  let frame: number | undefined;
  let follow = true;
  createEffect(() => {
    const reasoning = props.active && !props.content ? props.reasoning : '';
    if (!reasoning) {
      follow = true;
      return;
    }
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (follow && preview?.isConnected) preview.scrollTop = preview.scrollHeight;
    });
  });
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame);
  });
  return (
    <Show when={props.active}>
      <div class="prompt-generation-status" aria-busy="true">
        <Show when={props.showStatus !== false}>
          <div class="prompt-generation-status-line" role="status">
            <FontAwesomeIcon icon={faSpinner} size={12} class="spinner spinner-wait" />
            <span>{props.content ? 'Writing prompt…' : 'Thinking…'}</span>
          </div>
        </Show>
        <Show when={!props.content && props.reasoning}>
          <div
            ref={preview}
            class="reasoning-text prompt-generation-reasoning"
            aria-label="Prompt reasoning"
            onScroll={(event) => {
              const area = event.currentTarget;
              follow = area.scrollHeight - area.scrollTop - area.clientHeight < 24;
            }}
          >
            {props.reasoning}
          </div>
        </Show>
      </div>
    </Show>
  );
}
