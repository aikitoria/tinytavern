import { For, createSignal, onCleanup, onMount } from 'solid-js';
import type { Component } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { openModal } from '../state/store.ts';
import Modal from './Modal.tsx';
import {
  createSettingsNavigation,
  SettingsGuardProvider,
  SettingsNavigationPrompt,
} from './SettingsGuard.tsx';
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

/** Scroll ownership varies by tab: modal body or detail form. */
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
  const navigation = createSettingsNavigation();
  const activeTab = () => TABS.find((item) => item.key === tab()) ?? TABS[0]!;

  const onWheel = (event: WheelEvent) => {
    if (!event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const area = target.closest<HTMLTextAreaElement>('.settings-modal textarea');
    if (!area) return;
    // Focus opts into native textarea scrolling, including boundary behavior.
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

  const chooseTab = (key: string, after?: () => void) => {
    if (key !== tab())
      navigation.navigate(() => {
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

  return (
    <>
      <Modal
        title="Settings"
        class="settings-modal"
        onClose={() => navigation.navigate(() => openModal(null))}
        headerExtra={
          <div class="tab-strip tabs" role="tablist" aria-label="Settings sections">
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
          <SettingsGuardProvider register={navigation.register} navigate={navigation.navigate}>
            <Dynamic component={activeTab().component} />
          </SettingsGuardProvider>
        </div>
      </Modal>
      <SettingsNavigationPrompt navigation={navigation}>
        You have unsaved changes. Save them before leaving this settings page?
      </SettingsNavigationPrompt>
    </>
  );
}
