import { Show, createContext, useContext, type Accessor, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';

export const SettingsActionsContext = createContext<Accessor<HTMLElement | undefined>>();

/** Editors own their actions; the settings shell owns their fixed footer. */
export default function SettingsActions(props: { children: JSX.Element }) {
  const target = useContext(SettingsActionsContext);
  return (
    <Show when={target?.()} fallback={<div class="form-actions">{props.children}</div>}>
      {(element) => (
        <Portal mount={element()}>
          <div class="form-actions">{props.children}</div>
        </Portal>
      )}
    </Show>
  );
}
