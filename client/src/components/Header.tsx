import { For, Show, createSignal } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { api } from '../state/api.ts';
import {
  closeSidebar,
  openModal,
  selectedCharacter,
  selectedConversation,
  personasEnabled,
  selectedPersona,
  setState,
  state,
  toast,
  toggleSidebar,
} from '../state/store.ts';
import { errorMessage, useDismiss } from '../util.ts';
import Avatar from './Avatar.tsx';
import GearIcon from './GearIcon.tsx';
import MapIcon from './MapIcon.tsx';
import TraceIcon from './TraceIcon.tsx';
import { TreeIcon } from './TreeView.tsx';

const ChatIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M4 5h16v11H9l-5 4z" />
  </svg>
);

const VIEWS = [
  { mode: 'chat', label: 'Chat', icon: ChatIcon },
  { mode: 'trace', label: 'Prompt trace', icon: TraceIcon },
  { mode: 'tree', label: 'Conversation tree', icon: TreeIcon },
  { mode: 'map', label: 'Tree map', icon: MapIcon },
] as const;

export default function Header() {
  const [editing, setEditing] = createSignal(false);
  const [viewOpen, setViewOpen] = createSignal(false);
  let titleInput: HTMLInputElement | undefined;
  let viewRoot: HTMLSpanElement | undefined;

  useDismiss(
    () => viewRoot,
    viewOpen,
    () => setViewOpen(false),
  );

  // The endpoint generations actually use: conversation override, else global.
  const activeEndpoint = () => {
    const id = selectedConversation()?.endpointId ?? state.settings.activeEndpointId;
    return id != null ? state.endpoints.find((e) => e.id === id) : undefined;
  };

  // On mobile this header sits inside the sidebar: every action here targets
  // the chat behind it, so get the panel out of the way.
  const show = (modal: 'settings' | 'conversation') => {
    closeSidebar();
    openModal(modal);
  };

  const setView = (mode: 'chat' | 'trace' | 'tree' | 'map') => {
    setViewOpen(false);
    closeSidebar();
    setState('viewMode', mode);
  };
  const activeView = () => VIEWS.find((view) => view.mode === state.viewMode) ?? VIEWS[0];

  const startRename = () => {
    setEditing(true);
    queueMicrotask(() => {
      if (!titleInput) return;
      titleInput.value = selectedConversation()?.title ?? '';
      titleInput.focus();
      titleInput.select();
    });
  };

  const commitRename = () => {
    if (!editing()) return; // Enter commits and the input's blur would commit again
    const conv = selectedConversation();
    const title = titleInput?.value.trim();
    if (conv && title && title !== conv.title) {
      void api
        .patchConversation(
          conv.id,
          { title },
          state.tree.conversationId === conv.id ? state.tree.activeLeafId : conv.activeLeafId,
          state.tree.conversationId === conv.id
            ? state.tree.mutationRevision
            : conv.mutationRevision,
        )
        .catch((err) => toast(errorMessage(err)));
    }
    setEditing(false);
  };

  return (
    <header class="header">
      <button
        class="icon-btn menu-btn"
        title="Conversations"
        aria-label="Open conversations"
        onClick={toggleSidebar}
      >
        ☰
      </button>
      <Show when={selectedConversation()} fallback={<span class="header-title">MiniTavern</span>}>
        {(conv) => (
          <>
            <Avatar
              src={selectedCharacter()?.avatar}
              name={selectedCharacter()?.name ?? 'Assistant'}
            />
            <div class="header-info">
              <div class="header-title-group">
                <Show
                  when={!editing()}
                  fallback={
                    <input
                      ref={titleInput}
                      class="header-title-input"
                      aria-label="Conversation title"
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.isComposing) return; // IME candidate confirmation, not a command
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setEditing(false);
                      }}
                    />
                  }
                >
                  <span class="header-title">{conv().title}</span>
                  <button
                    class="icon-btn header-rename-btn"
                    title="Rename conversation"
                    aria-label="Rename conversation"
                    onClick={startRename}
                  >
                    ✎
                  </button>
                </Show>
              </div>
              <div class="header-context">
                <Show when={(selectedCharacter()?.name ?? 'Assistant') !== conv().title}>
                  <button
                    class="header-context-item"
                    title="Conversation character"
                    onClick={() => show('conversation')}
                  >
                    {selectedCharacter()?.name ?? 'Assistant'}
                  </button>
                  <span class="header-context-separator" aria-hidden="true">
                    ·
                  </span>
                </Show>
                <Show when={!activeEndpoint()}>
                  <button
                    class="header-context-item header-context-warn"
                    onClick={() => show('settings')}
                  >
                    no endpoint
                  </button>
                </Show>
                <Show when={activeEndpoint()}>
                  {(endpoint) => (
                    <button
                      class="header-context-item"
                      title="Generation endpoint"
                      onClick={() => show('settings')}
                    >
                      {endpoint().name}
                    </button>
                  )}
                </Show>
                <Show when={personasEnabled() && selectedPersona()}>
                  {(persona) => (
                    <>
                      <span class="header-context-separator" aria-hidden="true">
                        ·
                      </span>
                      <button
                        class="header-context-item"
                        title="Conversation persona"
                        onClick={() => show('conversation')}
                      >
                        as {persona().name}
                      </button>
                    </>
                  )}
                </Show>
              </div>
            </div>
            <span class="header-view-wrap" ref={viewRoot}>
              <button
                class="header-view-btn"
                aria-label={`View: ${activeView().label}`}
                classList={{ 'header-view-active': state.viewMode !== 'chat' }}
                aria-haspopup="menu"
                aria-expanded={viewOpen()}
                onClick={() => setViewOpen(!viewOpen())}
              >
                <Dynamic component={activeView().icon} />
                <span>{activeView().label}</span>
                <span class="select-caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              <Show when={viewOpen()}>
                <div class="header-view-menu popover-surface popover-menu" role="menu">
                  <For each={VIEWS}>
                    {(view) => (
                      <button
                        role="menuitemradio"
                        aria-checked={state.viewMode === view.mode}
                        classList={{ active: state.viewMode === view.mode }}
                        onClick={() => setView(view.mode)}
                      >
                        <Dynamic component={view.icon} />
                        <span>{view.label}</span>
                        <span class="view-check" aria-hidden="true">
                          {state.viewMode === view.mode ? '✓' : ''}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </span>
            <button
              class="icon-btn"
              title="Conversation settings"
              aria-label="Conversation settings"
              onClick={() => show('conversation')}
            >
              <GearIcon />
            </button>
          </>
        )}
      </Show>
    </header>
  );
}
