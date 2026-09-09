import { faCheck } from '@fortawesome/free-solid-svg-icons';
import { faCopy } from '@fortawesome/free-regular-svg-icons';
import { For, Show, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import { preparePromptTrace } from '@tinytavern/shared';
import { api } from '../../state/api.ts';
import { state, toast } from '../../state/store.ts';
import { errorMessage } from '../../util.ts';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';

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
    <section class="bg-message rounded-md overflow-hidden relative py-2 px-3">
      <div class="min-h-5 pr-7 flex items-center gap-2">
        <span
          class={`trace-role text-small-label font-semibold uppercase flex-1 tracking-wider role-color-${props.role}`}
        >
          {label()}
        </span>
        <button
          type="button"
          class="icon-btn [&.icon-btn]:absolute [&.icon-btn]:top-1 [&.icon-btn]:right-1 [&.icon-btn]:min-w-7 [&.icon-btn]:size-7"
          title={copied() ? 'Copied' : 'Copy message'}
          aria-label={copied() ? 'Copied' : `Copy ${label()}`}
          onClick={() => void copy()}
        >
          <FontAwesomeIcon icon={copied() ? faCheck : faCopy} size={13} />
        </button>
      </div>
      <pre class="trace-content text-prose whitespace-pre-wrap wrap-break-word p-0 font-code text-caption font-normal m-0 mt-1">
        {props.content}
      </pre>
    </section>
  );
}

export default function TraceView(props: { pendingMessage: string }) {
  const [trace] = createResource(
    () => ({
      id: state.selectedId,
      leaf: state.tree.activeLeafId,
      revision: state.tree.mutationRevision,
      settingsRevision: state.settings.revision,
      connected: state.connected,
    }),
    (key) => (key.id != null ? api.trace(key.id) : Promise.resolve(null)),
  );
  const isCommand = () => props.pendingMessage.trimStart().startsWith('/');
  const prepared = createMemo(() => {
    if (trace.error || trace.loading) return null;
    const current = trace();
    return current ? preparePromptTrace(current, isCommand() ? '' : props.pendingMessage) : null;
  });

  return (
    <div class="trace flex flex-col gap-3">
      <Show
        when={prepared()}
        fallback={
          <p
            class={trace.error ? 'notice notice-error' : 'hint'}
            role={trace.error ? 'alert' : undefined}
          >
            {trace.error ? `Could not load prompt trace: ${errorMessage(trace.error)}` : 'Loading…'}
          </p>
        }
      >
        {(t) => (
          <>
            <p
              class="hint"
              title="The next chat request, including endpoint additions, your pending message, and enabled reasoning and message prefills."
            >
              Next request · {t().messages.length}{' '}
              {t().messages.length === 1 ? 'message' : 'messages'}
            </p>
            <Show when={isCommand()}>
              <p class="hint">
                Slash commands run separate actions; this trace previews a normal chat reply.
              </p>
            </Show>
            <For each={t().messages}>
              {(msg, index) => (
                <div class="flex flex-col gap-1">
                  <Show when={msg.reasoning_content}>
                    <TraceMessage
                      role="assistant"
                      label={
                        index() === t().prefillMessageIndex
                          ? 'assistant reasoning (prefill)'
                          : 'assistant reasoning'
                      }
                      content={msg.reasoning_content!}
                    />
                  </Show>
                  <Show when={msg.content || !msg.reasoning_content}>
                    <TraceMessage
                      role={msg.role}
                      label={
                        index() === t().pendingMessageIndex
                          ? 'user (includes pending message)'
                          : index() === t().prefillMessageIndex
                            ? 'assistant message (prefill)'
                            : undefined
                      }
                      content={msg.content}
                    />
                  </Show>
                </div>
              )}
            </For>
          </>
        )}
      </Show>
    </div>
  );
}
