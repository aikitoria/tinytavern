import { Show, createEffect, onCleanup } from 'solid-js';
import { faSpinner } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import { createStreamScroll } from '../streamScroll.ts';

/** Reasoning is a temporary preview, never the editable or rendered prompt. */
export default function PromptGenerationStatus(props: {
  active: boolean;
  content: string;
  reasoning?: string | null;
  showStatus?: boolean;
}) {
  let preview: HTMLDivElement | undefined;
  const scroll = createStreamScroll(() => preview, requestAnimationFrame, cancelAnimationFrame);
  createEffect(() => {
    const reasoning = props.active && !props.content ? props.reasoning : '';
    scroll.update(reasoning ? 'reasoning' : null, Boolean(reasoning));
  });
  onCleanup(scroll.dispose);
  return (
    <Show when={props.active}>
      <div class="prompt-generation-status flex flex-col min-w-0 gap-2" aria-busy="true">
        <Show when={props.showStatus !== false}>
          <div class="flex items-center gap-2 text-dim text-sm" role="status">
            <FontAwesomeIcon
              icon={faSpinner}
              size={12}
              class="spinner inline-block w-3 h-3 text-dim flex-none w-2.5 h-2.5 origin-center"
            />
            <span>{props.content ? 'Writing prompt…' : 'Thinking…'}</span>
          </div>
        </Show>
        <Show when={!props.content && props.reasoning}>
          <div
            ref={preview}
            class="reasoning-text py-2 px-3 whitespace-pre-wrap bg-thinking text-dim text-sm rounded-sm prompt-generation-reasoning max-h-40 overflow-y-auto wrap-anywhere mt-1 mr-0 mb-2 ml-0 m-0"
            aria-label="Prompt reasoning"
            onScroll={scroll.onScroll}
          >
            {props.reasoning}
          </div>
        </Show>
      </div>
    </Show>
  );
}
