import { Show, createContext, onCleanup, useContext } from 'solid-js';
import Modal from './Modal.tsx';
import type { JSX } from 'solid-js';

import {
  createSettingsNavigation,
  type SettingsSectionActions,
} from '../state/settingsSubmission.ts';
export {
  createSettingsNavigation,
  type SettingsSectionActions,
} from '../state/settingsSubmission.ts';

type Register = (actions: SettingsSectionActions) => () => void;
type Navigate = (action: () => void) => void;

const SettingsGuardContext = createContext<Register>();
const SettingsNavigationContext = createContext<Navigate>();

export function SettingsGuardProvider(props: {
  register: Register;
  navigate: Navigate;
  children: JSX.Element;
}) {
  return (
    <SettingsNavigationContext.Provider value={props.navigate}>
      <SettingsGuardContext.Provider value={props.register}>
        {props.children}
      </SettingsGuardContext.Provider>
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
        class="confirm-modal"
        backdropClass="confirm-backdrop"
        onClose={guard.cancel}
      >
        <p class="confirm-message">{props.children}</p>
        <div class="form-actions confirm-actions">
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
