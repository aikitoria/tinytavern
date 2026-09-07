import { For, createSignal, onCleanup, onMount } from 'solid-js';
import type { Component } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { faArrowLeft } from '@fortawesome/free-solid-svg-icons';
import { openModal, state } from '../state/store.ts';
import Modal from './Modal.tsx';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import Select from './Select.tsx';
import type { SelectHandle } from './Select.tsx';
import '../styles/settings.css';
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
import ImageGenerationTab from './tabs/ImageGenerationTab.tsx';
import GalleryTab from './tabs/GalleryTab.tsx';

const TABS: { key: string; label: string; component: Component }[] = [
  { key: 'general', label: 'General', component: GeneralTab },
  { key: 'endpoints', label: 'Endpoints', component: EndpointsTab },
  { key: 'presets', label: 'Prompts', component: PresetsTab },
  { key: 'templates', label: 'Templates', component: TemplatesTab },
  { key: 'characters', label: 'Characters', component: CharactersTab },
  { key: 'personas', label: 'Personas', component: PersonasTab },
  { key: 'image-generation', label: 'Images', component: ImageGenerationTab },
  { key: 'gallery', label: 'Gallery', component: GalleryTab },
];

const canScroll = (element: HTMLElement, deltaY: number) =>
  deltaY < 0
    ? element.scrollTop > 1
    : element.scrollTop + element.clientHeight < element.scrollHeight - 1;

/** Scroll ownership varies by tab: modal body or detail form. */
function settingsScrollOwner(area: HTMLTextAreaElement): HTMLElement | null {
  const modal = area.closest<HTMLElement>('.settings-modal');
  for (let element = area.parentElement; element; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowY;
    if (
      (overflow === 'auto' || overflow === 'scroll') &&
      element.scrollHeight > element.clientHeight
    ) {
      return element;
    }
    if (element === modal) break;
  }
  return null;
}

export default function SettingsModal() {
  const [tab, setTab] = createSignal(state.settingsCharacterId != null ? 'characters' : 'general');
  const navigation = createSettingsNavigation();
  const activeTab = () => TABS.find((item) => item.key === tab()) ?? TABS[0]!;
  let sectionPicker!: SelectHandle;
  let contentEl!: HTMLDivElement;
  const leaveSettings = () => navigation.navigate(() => openModal(null));

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
        contentEl.scrollTop = 0;
        const page = contentEl.closest<HTMLElement>('.settings-modal');
        if (page) page.scrollTop = 0;
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
        fullscreen
        hideCloseButton
        onClose={leaveSettings}
        headerExtra={
          <div class="page-header-actions">
            <button
              type="button"
              class="page-back"
              data-modal-initial-focus
              onClick={leaveSettings}
            >
              <FontAwesomeIcon icon={faArrowLeft} size={13} /> Back
            </button>
            <div class="settings-section-picker">
              <Select
                ref={sectionPicker}
                ariaLabel="Settings section"
                options={TABS.map((section) => ({ value: section.key, label: section.label }))}
                value={tab()}
                onChange={(key) => {
                  // A cancelled navigation must keep the current section selected.
                  sectionPicker.value = tab();
                  chooseTab(key);
                }}
              />
            </div>
          </div>
        }
      >
        <div class="settings-workspace">
          <nav class="settings-nav" aria-label="Settings">
            <div role="tablist" aria-label="Settings sections" aria-orientation="vertical">
              <For each={TABS}>
                {(t, index) => (
                  <button
                    class="settings-nav-item"
                    classList={{ active: tab() === t.key }}
                    id={`settings-tab-${t.key}`}
                    role="tab"
                    aria-selected={tab() === t.key}
                    aria-controls="settings-tab-panel"
                    tabIndex={tab() === t.key ? 0 : -1}
                    onKeyDown={(event) => onTabKeyDown(event, index())}
                    onClick={() => chooseTab(t.key)}
                  >
                    {t.label}
                  </button>
                )}
              </For>
            </div>
          </nav>
          <div
            ref={contentEl}
            class="settings-content"
            id="settings-tab-panel"
            role="tabpanel"
            aria-label={activeTab().label}
          >
            <SettingsGuardProvider register={navigation.register} navigate={navigation.navigate}>
              <Dynamic component={activeTab().component} />
            </SettingsGuardProvider>
          </div>
        </div>
      </Modal>
      <SettingsNavigationPrompt navigation={navigation}>
        You have unsaved changes. Save them before leaving this settings page?
      </SettingsNavigationPrompt>
    </>
  );
}
