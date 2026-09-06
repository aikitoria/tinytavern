import { For, Show, createResource } from 'solid-js';
import { api } from '../state/api.ts';
import { state } from '../state/store.ts';

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
      <p class="hint">
        The messages the next generation on this branch will send upstream (system prompt, template,
        macros and name prefixes applied).
      </p>
      <Show when={trace()} fallback={<p class="hint">Loading…</p>}>
        {(t) => (
          <>
            <For each={t().messages}>
              {(msg) => (
                <div class="trace-msg">
                  <span class="trace-role" classList={{ [`role-color-${msg.role}`]: true }}>
                    {msg.role}
                  </span>
                  <pre class="trace-content">{msg.content}</pre>
                </div>
              )}
            </For>
            <Show when={t().namePrefill}>
              <div class="trace-msg">
                <span class="trace-role role-color-assistant">assistant name (prefill)</span>
                <pre class="trace-content">{t().namePrefill}</pre>
              </div>
            </Show>
            <Show when={t().reasoningPrefill}>
              <div class="trace-msg">
                <span class="trace-role role-color-assistant">assistant reasoning (prefill)</span>
                <pre class="trace-content">{t().reasoningPrefill}</pre>
              </div>
            </Show>
            <Show when={t().messagePrefill}>
              <div class="trace-msg">
                <span class="trace-role role-color-assistant">assistant message (prefill)</span>
                <pre class="trace-content">{t().messagePrefill}</pre>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
