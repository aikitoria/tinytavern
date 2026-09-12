import { Show, createContext, onCleanup, useContext } from 'solid-js';
import Modal from '../ui/Modal.tsx';
import type { JSX } from 'solid-js';

import { createSettingsNavigation, type SettingsSectionActions } from '../../state/settingsSubmission.ts';
export { createSettingsNavigation, type SettingsSectionActions } from '../../state/settingsSubmission.ts';

type Register = (actions: SettingsSectionActions) => () => void;
type Navigate = (action: () => void) => void;

const SettingsGuardContext = createContext<Register>();
const SettingsNavigationContext = createContext<Navigate>();

export function SettingsGuardProvider(props: { register: Register; navigate: Navigate; children: JSX.Element }) {
  return (
    <SettingsNavigationContext.Provider value={props.navigate}>
      <SettingsGuardContext.Provider value={props.register}>{props.children}</SettingsGuardContext.Provider>
    </SettingsNavigationContext.Provider>
  );
}

/** Registers the save/discard contract for the currently mounted settings page. */
export function useSettingsGuard(actions: SettingsSectionActions): void {
  const register = useContext(SettingsGuardContext);
  if (!register) return;
  const unregister = register(actions);
  onCleanup(unregister);
}

/** Runs in-page navigation through Settings' Save / Discard / Cancel prompt. */
export function useSettingsNavigation(): Navigate {
  return useContext(SettingsNavigationContext) ?? ((action) => action());
}

export function SettingsNavigationPrompt(props: {
  navigation: ReturnType<typeof createSettingsNavigation>;
  children: JSX.Element;
}) {
  const guard = props.navigation;
  return (
    <Show when={guard.promptOpen()}>
      <Modal
        active
        title="Save changes?"
        class="confirm-modal [&.confirm-modal]:h-auto [&.confirm-modal]:w-full [&.confirm-modal]:max-w-107.5 [&.confirm-modal]:max-h-[min(80dvh,_520px)] [&_.modal-body]:p-5 small-touch:[&.confirm-modal]:border small-touch:[&.confirm-modal]:border-solid small-touch:[&.confirm-modal]:border-line small-touch:[&.confirm-modal]:rounded-lg small-touch:[&.confirm-modal]:pt-0"
        backdropClass="confirm-backdrop z-400 small-touch:[&.confirm-backdrop]:p-4"
        onClose={guard.cancel}
      >
        <p class="m-0 text-dim">{props.children}</p>
        <div class="form-actions flex items-center gap-2 flex-wrap mt-4 mt-5">
          <button class="primary-btn" disabled={guard.saving()} onClick={() => void guard.save()}>
            {guard.saving() ? 'Saving…' : 'Save'}
          </button>
          <button disabled={guard.saving()} onClick={guard.discard}>
            Discard
          </button>
          <button data-modal-initial-focus onClick={guard.cancel}>
            Cancel
          </button>
        </div>
      </Modal>
    </Show>
  );
}
