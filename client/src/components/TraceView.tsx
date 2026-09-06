import { faCheck } from '@fortawesome/free-solid-svg-icons';
import { faCopy } from '@fortawesome/free-regular-svg-icons';
import { For, Show, createResource, createSignal, onCleanup } from 'solid-js';
import { api } from '../state/api.ts';
import { state, toast } from '../state/store.ts';
import { errorMessage } from '../util.ts';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';

function TraceMessage(props: { role: string; label?: string; content: string }) {
  const [copied, setCopied] = createSignal(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    clearTimeout(resetTimer);
  });
  const label = () => props.label ?? props.role;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.content);
      if (disposed) return;
      setCopied(true);
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast(`Could not copy message: ${errorMessage(err)}`);
    }
  };
  return (
    <section class="trace-msg">
      <div class="trace-head">
        <span class={`trace-role role-color-${props.role}`}>{label()}</span>
        <button
          type="button"
          class="icon-btn trace-copy"
          title={copied() ? 'Copied' : 'Copy message'}
          aria-label={copied() ? 'Copied' : `Copy ${label()}`}
          onClick={() => void copy()}
        >
          <FontAwesomeIcon icon={copied() ? faCheck : faCopy} size={13} />
        </button>
      </div>
      <pre class="trace-content">{props.content}</pre>
    </section>
  );
}

export default function TraceView() {
  const [trace] = createResource(
    () => ({
      id: state.selectedId,
      leaf: state.tree.activeLeafId,
      // refetch when a stream finalizes or messages change
      count: Object.values(state.tree.messages).filter((m) => m.status !== 'streaming').length,
    }),
    (key) => (key.id != null ? api.trace(key.id) : Promise.resolve(null)),
  );

  return (
    <div class="trace">
      <Show when={trace()} fallback={<p class="hint">Loading…</p>}>
        {(t) => (
          <>
            <p
              class="hint"
              title="The next generation on this branch, with system prompt, template, macros and name prefixes applied."
            >
              Next request · {t().messages.length}{' '}
              {t().messages.length === 1 ? 'message' : 'messages'}
            </p>
            <For each={t().messages}>
              {(msg) => <TraceMessage role={msg.role} content={msg.content} />}
            </For>
            <Show when={t().namePrefill}>
              <TraceMessage
                role="assistant"
                label="assistant name (prefill)"
                content={t().namePrefill!}
              />
            </Show>
            <Show when={t().reasoningPrefill}>
              <TraceMessage
                role="assistant"
                label="assistant reasoning (prefill)"
                content={t().reasoningPrefill!}
              />
            </Show>
            <Show when={t().messagePrefill}>
              <TraceMessage
                role="assistant"
                label="assistant message (prefill)"
                content={t().messagePrefill!}
              />
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
