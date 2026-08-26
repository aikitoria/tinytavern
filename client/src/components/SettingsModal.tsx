import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import type { Component } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { openModal } from '../state/store.ts';
import Modal from './Modal.tsx';
import { SettingsGuardProvider } from './SettingsGuard.tsx';
import type { SettingsSectionActions } from './SettingsGuard.tsx';
import GeneralTab from './tabs/GeneralTab.tsx';
import EndpointsTab from './tabs/EndpointsTab.tsx';
import PresetsTab from './tabs/PresetsTab.tsx';
import TemplatesTab from './tabs/TemplatesTab.tsx';
import CharactersTab from './tabs/CharactersTab.tsx';
import PersonasTab from './tabs/PersonasTab.tsx';
import ToolsTab from './tabs/ToolsTab.tsx';

const TABS: { key: string; label: string; component: Component }[] = [
  { key: 'general', label: 'General', component: GeneralTab },
  { key: 'endpoints', label: 'Endpoints', component: EndpointsTab },
  { key: 'presets', label: 'Prompts', component: PresetsTab },
  { key: 'templates', label: 'Templates', component: TemplatesTab },
  { key: 'characters', label: 'Characters', component: CharactersTab },
  { key: 'personas', label: 'Personas', component: PersonasTab },
  { key: 'tools', label: 'Tools', component: ToolsTab },
];

const canScroll = (element: HTMLElement, deltaY: number) =>
  deltaY < 0
    ? element.scrollTop > 1
    : element.scrollTop + element.clientHeight < element.scrollHeight - 1;

/** The modal body scrolls simple tabs, while master-detail tabs scroll their
 * detail form. Find whichever scroll owner encloses this field. */
function settingsScrollOwner(area: HTMLTextAreaElement): HTMLElement | null {
  const modal = area.closest<HTMLElement>('.settings-modal');
  for (
    let element = area.parentElement;
    element && element !== modal;
    element = element.parentElement
  ) {
    const overflow = getComputedStyle(element).overflowY;
    if (
      (overflow === 'auto' || overflow === 'scroll') &&
      element.scrollHeight > element.clientHeight
    ) {
      return element;
    }
  }
  return null;
}

export default function SettingsModal() {
  const [tab, setTab] = createSignal('general');
  const [promptOpen, setPromptOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const activeTab = () => TABS.find((item) => item.key === tab()) ?? TABS[0]!;
  let activeActions: SettingsSectionActions | undefined;
  let pendingNavigation: (() => void) | undefined;

  const onWheel = (event: WheelEvent) => {
    if (!event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const area = target.closest<HTMLTextAreaElement>('.settings-modal textarea');
    if (!area) return;
    // Focusing a multiline editor explicitly opts into its native wheel
    // behavior, including what happens at its own scroll boundaries.
    if (document.activeElement === area) return;
    const owner = settingsScrollOwner(area);
    if (!owner || !canScroll(owner, event.deltaY)) return;

    // Hover alone should never trap settings scroll.
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? owner.clientHeight : 1;
    event.preventDefault();
    owner.scrollTop += event.deltaY * scale;
  };

  onMount(() => document.addEventListener('wheel', onWheel, { capture: true, passive: false }));
  onCleanup(() => document.removeEventListener('wheel', onWheel, true));

  const register = (actions: SettingsSectionActions) => {
    activeActions = actions;
    return () => {
      if (activeActions === actions) activeActions = undefined;
    };
  };

  const navigate = (action: () => void) => {
    if (!activeActions?.isDirty()) {
      action();
      return;
    }
    pendingNavigation = action;
    setPromptOpen(true);
  };
  const chooseTab = (key: string, after?: () => void) => {
    if (key !== tab())
      navigate(() => {
        setTab(key);
        after?.();
      });
  };
  const onTabKeyDown = (event: KeyboardEvent, index: number) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
      return;
    event.preventDefault();
    const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? TABS.length - 1
          : (index + direction + TABS.length) % TABS.length;
    const nextKey = TABS[nextIndex]!.key;
    chooseTab(nextKey, () =>
      queueMicrotask(() => document.getElementById(`settings-tab-${nextKey}`)?.focus()),
    );
  };

  const finishNavigation = () => {
    const action = pendingNavigation;
    pendingNavigation = undefined;
    setPromptOpen(false);
    action?.();
  };

  const saveAndContinue = async () => {
    if (!activeActions || saving()) return;
    setSaving(true);
    const saved = await activeActions.save();
    setSaving(false);
    if (saved) finishNavigation();
    else cancelNavigation();
  };

  const discardAndContinue = () => {
    activeActions?.discard();
    finishNavigation();
  };

  const cancelNavigation = () => {
    pendingNavigation = undefined;
    setPromptOpen(false);
  };

  return (
    <>
      <Modal
        title="Settings"
        class="settings-modal"
        onClose={() => navigate(() => openModal(null))}
        headerExtra={
          <div class="tabs" role="tablist" aria-label="Settings sections">
            <For each={TABS}>
              {(t, index) => (
                <button
                  class="tab"
                  classList={{ active: tab() === t.key }}
                  id={`settings-tab-${t.key}`}
                  role="tab"
                  aria-selected={tab() === t.key}
                  aria-controls="settings-tab-panel"
                  data-modal-initial-focus={tab() === t.key ? '' : undefined}
                  tabIndex={tab() === t.key ? 0 : -1}
                  onKeyDown={(event) => onTabKeyDown(event, index())}
                  onClick={() => chooseTab(t.key)}
                >
                  {t.label}
                </button>
              )}
            </For>
          </div>
        }
      >
        <div
          class="settings-content"
          id="settings-tab-panel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${tab()}`}
        >
          <SettingsGuardProvider register={register} navigate={navigate}>
            <Dynamic component={activeTab().component} />
          </SettingsGuardProvider>
        </div>
      </Modal>
      <Show when={promptOpen()}>
        <Modal
          title="Save changes?"
          class="confirm-modal"
          backdropClass="confirm-backdrop"
          onClose={cancelNavigation}
        >
          <p class="confirm-message">
            You have unsaved changes. Save them before leaving this settings page?
          </p>
          <div class="form-actions confirm-actions">
            <button class="primary-btn" disabled={saving()} onClick={() => void saveAndContinue()}>
              {saving() ? 'Saving…' : 'Save'}
            </button>
            <button disabled={saving()} onClick={discardAndContinue}>
              Discard
            </button>
            <button data-modal-initial-focus disabled={saving()} onClick={cancelNavigation}>
              Cancel
            </button>
          </div>
        </Modal>
      </Show>
    </>
  );
}
