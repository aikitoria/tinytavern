import { For, Show, createSignal } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { api } from '../state/api.ts';
import {
  closeSidebar,
  openModal,
  selectedCharacter,
  selectedConversation,
  personasEnabled,
  setState,
  state,
  toast,
  toggleSidebar,
} from '../state/store.ts';
import { errorMessage } from '../util.ts';
import Avatar from './Avatar.tsx';
import DropdownSurface from './DropdownSurface.tsx';
import GearIcon from './GearIcon.tsx';
import MapIcon from './MapIcon.tsx';
import Select from './Select.tsx';
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

type ContextField = 'endpointId' | 'personaId';

export default function Header() {
  const [editing, setEditing] = createSignal(false);
  const [viewOpen, setViewOpen] = createSignal(false);
  const [pendingContext, setPendingContext] = createSignal<{
    conversationId: number;
    field: ContextField;
    value: number | null;
  } | null>(null);
  let titleInput: HTMLInputElement | undefined;
  let viewButton: HTMLButtonElement | undefined;

  const contextValue = (field: ContextField) => {
    const pending = pendingContext();
    if (
      pending &&
      pending.conversationId === selectedConversation()?.id &&
      pending.field === field
    ) {
      return pending.value;
    }
    return selectedConversation()?.[field] ?? null;
  };

  const contextPersona = () => {
    const id = contextValue('personaId');
    return id != null ? state.personas.find((persona) => persona.id === id) : undefined;
  };

  // The endpoint generations actually use: conversation override, else global.
  const activeEndpoint = () => {
    const id = contextValue('endpointId') ?? state.settings.activeEndpointId;
    return id != null ? state.endpoints.find((endpoint) => endpoint.id === id) : undefined;
  };

  const updateContext = async (field: ContextField, rawValue: string) => {
    const conv = selectedConversation();
    if (!conv || pendingContext()) return;
    const value = rawValue ? Number(rawValue) : null;
    if (conv[field] === value) return;
    setPendingContext({ conversationId: conv.id, field, value });
    try {
      const updated = await api.patchConversation(
        conv.id,
        { [field]: value },
        state.tree.conversationId === conv.id ? state.tree.activeLeafId : conv.activeLeafId,
        state.tree.conversationId === conv.id ? state.tree.mutationRevision : conv.mutationRevision,
      );
      setState('conversations', (conversations) =>
        conversations.map((conversation) =>
          conversation.id === updated.id ? updated : conversation,
        ),
      );
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setPendingContext((pending) =>
        pending?.conversationId === conv.id && pending.field === field ? null : pending,
      );
    }
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
      titleInput.focus({ preventScroll: true });
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
                <Select
                  class={`header-context-select ${activeEndpoint() ? '' : 'header-context-warn'}`}
                  value={String(contextValue('endpointId') ?? '')}
                  buttonLabel={`Endpoint · ${activeEndpoint()?.name ?? 'None'}`}
                  ariaLabel="Conversation endpoint"
                  disabled={pendingContext() != null}
                  menuMinWidth={220}
                  menuClass="header-dropdown-menu"
                  showCheck
                  onChange={(value) => void updateContext('endpointId', value)}
                  options={[
                    {
                      value: '',
                      label: `Global default · ${
                        state.endpoints.find(
                          (endpoint) => endpoint.id === state.settings.activeEndpointId,
                        )?.name ?? 'none selected'
                      }`,
                    },
                    ...state.endpoints.map((endpoint) => ({
                      value: String(endpoint.id),
                      label: endpoint.name,
                    })),
                  ]}
                />
                <Select
                  class="header-context-select"
                  value={String(contextValue('personaId') ?? '')}
                  buttonLabel={`Persona · ${personasEnabled() ? (contextPersona()?.name ?? 'None') : 'Off'}`}
                  ariaLabel="Conversation persona"
                  disabled={pendingContext() != null || !personasEnabled()}
                  menuMinWidth={220}
                  menuClass="header-dropdown-menu"
                  showCheck
                  onChange={(value) => void updateContext('personaId', value)}
                  options={[
                    { value: '', label: 'No persona' },
                    ...state.personas.map((persona) => ({
                      value: String(persona.id),
                      label: persona.name,
                    })),
                  ]}
                />
              </div>
            </div>
            <span class="header-view-wrap">
              <button
                ref={viewButton}
                type="button"
                class="header-view-btn"
                aria-label={`View: ${activeView().label}`}
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
              <DropdownSurface
                open={viewOpen()}
                anchor={() => viewButton}
                onClose={() => setViewOpen(false)}
                class="header-view-menu header-dropdown-menu"
                role="menu"
                ariaLabel="Conversation view"
                placement="bottom"
                align="end"
                minWidth={210}
                keyboardNavigation
                autoFocus
              >
                <For each={VIEWS}>
                  {(view) => (
                    <button
                      type="button"
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
              </DropdownSurface>
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
