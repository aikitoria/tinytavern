import {
  useDialogActive,
  useDialogNavigationGuard,
  useDialogPage,
} from '../../state/dialogContext.ts';
import { readPageLocation, writePageLocation } from '../../state/pageLocation.ts';
import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import type { Component } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { faArrowLeft } from '@fortawesome/free-solid-svg-icons';
import { openModal, state } from '../../state/store.ts';
import Modal from '../ui/Modal.tsx';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import Select from '../ui/Select.tsx';
import { SettingsActionsContext } from './SettingsActions.tsx';
import type { SelectHandle } from '../ui/Select.tsx';
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
import MediaRenderingTab from './tabs/MediaRenderingTab.tsx';
import WorkflowsTab from './tabs/WorkflowsTab.tsx';
import { ChatMediaPromptsTab, StandaloneMediaPromptsTab } from './tabs/MediaPromptsTab.tsx';

const TABS: { key: string; label: string; group: string; component: Component }[] = [
  { key: 'general', label: 'General', group: 'Application', component: GeneralTab },
  {
    key: 'model-connections',
    label: 'Endpoints',
    group: 'Application',
    component: EndpointsTab,
  },
  { key: 'characters', label: 'Characters', group: 'Chat', component: CharactersTab },
  { key: 'personas', label: 'Personas', group: 'Chat', component: PersonasTab },
  { key: 'system-prompts', label: 'System prompts', group: 'Chat', component: PresetsTab },
  { key: 'chat-templates', label: 'Chat templates', group: 'Chat', component: TemplatesTab },
  { key: 'workflows', label: 'Workflows', group: 'Media', component: WorkflowsTab },
  {
    key: 'chat-media-prompts',
    label: 'Chat media prompts',
    group: 'Media',
    component: ChatMediaPromptsTab,
  },
  {
    key: 'standalone-media-prompts',
    label: 'Standalone media prompts',
    group: 'Media',
    component: StandaloneMediaPromptsTab,
  },
  {
    key: 'generation-settings',
    label: 'Generation settings',
    group: 'Media',
    component: MediaRenderingTab,
  },
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
  const [actionsTarget, setActionsTarget] = createSignal<HTMLElement>();
  const page = useDialogPage()();
  const initialTab = page.settingsTab;
  const [tab, setTab] = createSignal(
    TABS.some((item) => item.key === initialTab) ? initialTab! : 'general',
  );
  const navigation = createSettingsNavigation();
  useDialogNavigationGuard(navigation.navigate);
  const paneActive = useDialogActive();
  const activeTab = () =>
    TABS.find((item) => item.key === tab()) ?? TABS.find((item) => item.key === 'general')!;
  let sectionPicker!: SelectHandle;
  let contentEl!: HTMLDivElement;
  const leaveSettings = () => navigation.navigate(() => openModal(null));

  const onWheel = (event: WheelEvent) => {
    if (!paneActive()) return;
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
        writePageLocation(
          {
            chatId: state.selectedId,
            viewMode: readPageLocation().viewMode,
            modal: 'settings',
            settingsTab: key,
          },
          true,
        );
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
        class="settings-modal narrow:[&_.modal-title]:display-none"
        fullscreen
        hideCloseButton
        onClose={leaveSettings}
        headerStart={
          <button
            type="button"
            class="page-back icon-btn flex-none border-transparent bg-clear"
            aria-label="Back"
            title="Back"
            data-modal-initial-focus
            onClick={leaveSettings}
          >
            <FontAwesomeIcon icon={faArrowLeft} size={13} />
          </button>
        }
        headerExtra={
          <div class="flex items-center justify-end flex-1 min-w-0 gap-2 [&>button]:inline-flex [&>button]:items-center [&>button]:justify-center [&>button]:gap-1 [&>button]:min-h-control [&>button]:h-control">
            <div class="display-none w-50 min-w-0 compact:block">
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
        <SettingsActionsContext.Provider value={actionsTarget}>
          <div class="min-w-0 min-h-0 flex flex-1">
            <nav
              class="border-r border-r-solid border-r-subtle overflow-y-auto p-2 bg-chrome grow-0 shrink-0 basis-sidebar compact:display-none [&_[role=tablist]]:flex [&_[role=tablist]]:flex-col [&_[role=tablist]]:gap-1"
              aria-label="Settings"
            >
              <div role="tablist" aria-label="Settings sections" aria-orientation="vertical">
                <For each={TABS}>
                  {(t, index) => (
                    <>
                      <Show when={index() === 0 || TABS[index() - 1]!.group !== t.group}>
                        <div
                          role="presentation"
                          class="px-[9px] pt-1 pb-0 text-label leading-5 text-foreground font-bold"
                          classList={{ 'mt-3': index() > 0 }}
                        >
                          {t.group}
                        </div>
                      </Show>
                      <button
                        class="settings-nav-item min-h-control border-transparent w-full text-dim bg-clear text-left [&.active]:text-foreground"
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
                    </>
                  )}
                </For>
              </div>
            </nav>
            <div class="settings-editor flex flex-col min-w-0 min-h-0 flex-1">
              <div
                ref={contentEl}
                class="min-w-0 min-h-0 flex-1 overflow-y-auto [&:has(>.master-detail)]:flex [&:has(>.master-detail)]:overflow-hidden [&>.form]:w-full [&>.form]:min-h-full [&>.form]:p-4 [&_.form]:min-w-0 [&_.form>*]:shrink-0 [&_.form>*]:w-full [&_.form>*]:max-w-240 [&_.form>*]:mx-auto [&_.settings-section]:p-4 [&_.settings-section]:bg-chrome [&_.settings-section]:rounded-md [&_.field-group]:bg-panel [&_.field-group]:border-subtle [&_.field-group>:is(label,_.setting-label):first-child]:mt-0 mobile:[&_.settings-section]:p-3"
                id="settings-tab-panel"
                role="tabpanel"
                aria-label={activeTab().label}
              >
                <SettingsGuardProvider
                  register={navigation.register}
                  navigate={navigation.navigate}
                >
                  <Dynamic component={activeTab().component} />
                </SettingsGuardProvider>
              </div>
              <div
                ref={setActionsTarget}
                class="settings-actions bg-canvas border-t border-t-solid border-t-subtle flex-none [&:empty]:display-none [&_.form-actions]:m-0"
                aria-label="Settings actions"
              />
            </div>
          </div>
        </SettingsActionsContext.Provider>
      </Modal>
      <SettingsNavigationPrompt navigation={navigation}>
        You have unsaved changes. Save them before leaving this settings page?
      </SettingsNavigationPrompt>
    </>
  );
}
