import { Show, createContext, useContext, type Accessor, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { faCheck } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';

export const SettingsActionsContext = createContext<Accessor<HTMLElement | undefined>>();

/** Editors own their actions; the settings shell owns their fixed footer. */
export default function SettingsActions(props: {
  children?: JSX.Element;
  save?: () => unknown;
  discard?: () => void;
  saving?: boolean;
  saved?: boolean;
  saveLabel?: string;
  inline?: boolean;
}) {
  const target = useContext(SettingsActionsContext);
  const actions = () => (
    <div class="form-actions flex items-center gap-2 flex-wrap mt-4">
      <Show when={props.save}>
        <button class="primary-btn" disabled={props.saving} onClick={() => void props.save?.()}>
          {props.saving ? 'Saving…' : (props.saveLabel ?? 'Save')}
        </button>
      </Show>
      <Show when={props.discard}>
        <button disabled={props.saving} onClick={() => props.discard?.()}>
          Discard
        </button>
      </Show>
      {props.children}
      <Show when={props.saved}>
        <span class="text-success text-sm">
          <FontAwesomeIcon icon={faCheck} size={12} /> Saved
        </span>
      </Show>
    </div>
  );
  return (
    <Show when={!props.inline && target?.()} fallback={actions()}>
      {(element) => <Portal mount={element()}>{actions()}</Portal>}
    </Show>
  );
}
