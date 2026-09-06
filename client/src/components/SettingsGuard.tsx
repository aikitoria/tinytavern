import { Show, createContext, createSignal, onCleanup, useContext } from 'solid-js';
import Modal from './Modal.tsx';
import type { JSX } from 'solid-js';

export interface SettingsSectionActions {
  isDirty: () => boolean;
  /** Returns false when validation or persistence failed. */
  save: () => Promise<boolean>;
  discard: () => void;
}

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

/** One guard owns the mounted editor and a single deferred navigation. */
export function createSettingsNavigation() {
  const [promptOpen, setPromptOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  let activeActions: SettingsSectionActions | undefined;
  let pendingNavigation: (() => void) | undefined;

  const cancel = () => {
    pendingNavigation = undefined;
    setPromptOpen(false);
  };
  const finish = () => {
    const action = pendingNavigation;
    cancel();
    action?.();
  };
  return {
    promptOpen,
    saving,
    register(actions: SettingsSectionActions) {
      activeActions = actions;
      return () => {
        if (activeActions === actions) activeActions = undefined;
      };
    },
    navigate(action: () => void) {
      if (!activeActions?.isDirty()) action();
      else {
        pendingNavigation = action;
        setPromptOpen(true);
      }
    },
    cancel,
    async save() {
      if (!activeActions || saving()) return;
      const actions = activeActions;
      const navigation = pendingNavigation;
      setSaving(true);
      try {
        const saved = await actions.save();
        // A closed prompt or replacement editor must not complete an old save.
        if (actions !== activeActions || navigation !== pendingNavigation) return;
        if (saved) finish();
        else cancel();
      } finally {
        setSaving(false);
      }
    },
    discard() {
      activeActions?.discard();
      finish();
    },
  };
}

export function SettingsNavigationPrompt(props: {
  navigation: ReturnType<typeof createSettingsNavigation>;
  children: JSX.Element;
}) {
  const guard = props.navigation;
  return (
    <Show when={guard.promptOpen()}>
      <Modal
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
          <button data-modal-initial-focus disabled={guard.saving()} onClick={guard.cancel}>
            Cancel
          </button>
        </div>
      </Modal>
    </Show>
  );
}
