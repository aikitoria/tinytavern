import { entityOptions, editReferencedEntity } from '../../state/entityReferences.ts';
import { readPageLocation, writePageLocation } from '../../state/pageLocation.ts';
import { faBarsProgress, faGear, faPen } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import { Show, createSignal } from 'solid-js';
import { api } from '../../state/api.ts';
import {
  activeMediaJobCount,
  closeSidebar,
  openModal,
  selectedConversation,
  personasEnabled,
  setState,
  state,
  toast,
} from '../../state/store.ts';
import { errorMessage } from '../../util.ts';
import Select from '../ui/Select.tsx';
import { openMediaJobs } from '../../media/navigation.ts';

const VIEWS = [
  { mode: 'chat', label: 'Chat' },
  { mode: 'trace', label: 'Prompt trace' },
  { mode: 'map', label: 'Tree map' },
] as const;

type ContextField = 'endpointId' | 'personaId';

export default function Header() {
  const [editing, setEditing] = createSignal(false);
  const [pendingContext, setPendingContext] = createSignal<{
    conversationId: number;
    field: ContextField;
    value: number | null;
  } | null>(null);
  let titleInput: HTMLInputElement | undefined;

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
        state.tree.conversationId === conv.id ? state.tree : conv,
        { [field]: value },
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

  // The mobile header lives inside the sidebar, which would obscure the chat.
  const show = (modal: 'settings' | 'conversation') => {
    closeSidebar();
    openModal(modal);
  };

  const setView = (mode: 'chat' | 'trace' | 'map') => {
    closeSidebar();
    setState('viewMode', mode);
    writePageLocation({ ...readPageLocation(), viewMode: mode === 'chat' ? undefined : mode });
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
        .patchConversation(conv.id, state.tree.conversationId === conv.id ? state.tree : conv, {
          title,
        })
        .catch((err) => toast(errorMessage(err)));
    }
    setEditing(false);
  };

  return (
    <header class="header page-header z-10 relative small-touch:absolute small-touch:z-55 small-touch:gap-2 small-touch:overflow-hidden small-touch:invisible pt-[calc(var(--space-1)_+_env(safe-area-inset-top))] small-touch:inset-[0_0_auto_min(85vw,_var(--sidebar-w))] small-touch:min-h-[calc(var(--bar-h)_+_env(safe-area-inset-top))] small-touch:p-[calc(var(--space-1)_+_env(safe-area-inset-top))_var(--space-3)_var(--space-1)]">
      <Show
        when={selectedConversation()}
        fallback={
          <span class="header-title flex-1 min-w-0 truncate font-semibold text-heading leading-tight small-touch:text-mobile-title">
            TinyTavern
          </span>
        }
      >
        {(conv) => (
          <>
            <div class="flex items-center flex-1 min-w-0 gap-2">
              <div class="flex items-center flex-1 min-w-0 gap-2">
                <Show
                  when={!editing()}
                  fallback={
                    <input
                      ref={titleInput}
                      class="min-w-0 max-w-105 h-control font-semibold text-heading"
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
                  <span class="header-title max-w-full truncate font-semibold text-heading leading-tight small-touch:text-mobile-title">
                    {conv().title}
                  </span>
                  <button
                    class="icon-btn small-touch:display-none"
                    title="Rename conversation"
                    aria-label="Rename conversation"
                    onClick={startRename}
                  >
                    <FontAwesomeIcon icon={faPen} size={14} />
                  </button>
                </Show>
              </div>
              <div class="header-context overflow-x-auto inline-flex items-center min-w-0 gap-2 ml-auto small-touch:display-none max-w-[min(45vw,_520px)]">
                <Select
                  class={`w-auto max-w-45 flex-initial [&_.select-label]:flex [&_.select-label]:items-baseline [&_.select-label]:gap-1.5 ${activeEndpoint() ? '' : 'header-context-warn'}`}
                  value={String(contextValue('endpointId') ?? '')}
                  buttonLabel={
                    <>
                      <span class="flex-none text-dim compact:display-none">Endpoint</span>
                      <span class="header-context-value truncate min-w-0">
                        {activeEndpoint()?.name ?? 'None'}
                      </span>
                    </>
                  }
                  ariaLabel="Conversation endpoint"
                  disabled={pendingContext() != null}
                  menuMinWidth={220}
                  menuClass="[&_.menu-check]:ml-auto [&_.menu-check]:text-accent"
                  showCheck
                  onChange={(value) => void updateContext('endpointId', value)}
                  options={[
                    {
                      value: '',
                      edit:
                        state.settings.activeEndpointId != null
                          ? () =>
                              editReferencedEntity('endpoints', state.settings.activeEndpointId!)
                          : undefined,
                      label: `Global default · ${
                        state.endpoints.find(
                          (endpoint) => endpoint.id === state.settings.activeEndpointId,
                        )?.name ?? 'none selected'
                      }`,
                    },
                    ...entityOptions('endpoints', state.endpoints),
                  ]}
                />
                <Select
                  class="w-auto max-w-45 flex-initial [&_.select-label]:flex [&_.select-label]:items-baseline [&_.select-label]:gap-1.5"
                  value={String(contextValue('personaId') ?? '')}
                  buttonLabel={
                    <>
                      <span class="flex-none text-dim compact:display-none">Persona</span>
                      <span class="header-context-value truncate min-w-0">
                        {personasEnabled() ? (contextPersona()?.name ?? 'None') : 'Off'}
                      </span>
                    </>
                  }
                  ariaLabel={
                    personasEnabled()
                      ? 'Conversation persona'
                      : 'Conversation persona: off for the current template'
                  }
                  disabled={pendingContext() != null || !personasEnabled()}
                  menuMinWidth={220}
                  menuClass="[&_.menu-check]:ml-auto [&_.menu-check]:text-accent"
                  showCheck
                  onChange={(value) => void updateContext('personaId', value)}
                  options={[
                    { value: '', label: 'No persona' },
                    ...entityOptions('personas', state.personas),
                  ]}
                />
              </div>
            </div>
            <Select
              class="header-view-btn w-auto flex-none"
              value={state.viewMode}
              ariaLabel={`View: ${activeView().label}`}
              menuClass="header-view-menu [&_.menu-check]:ml-auto [&_.menu-check]:text-accent"
              menuMinWidth={210}
              showCheck
              options={VIEWS.map(({ mode, label }) => ({ value: mode, label }))}
              onChange={(value) => setView(value as (typeof VIEWS)[number]['mode'])}
            />
          </>
        )}
      </Show>
      <div class="flex items-center gap-2 flex-none">
        <button
          type="button"
          class="icon-btn header-jobs-btn w-auto gap-1 px-1"
          title={
            activeMediaJobCount() ? `Media jobs (${activeMediaJobCount()} running)` : 'Media jobs'
          }
          aria-label="Media jobs"
          onClick={() => {
            closeSidebar();
            openMediaJobs();
          }}
        >
          <FontAwesomeIcon icon={faBarsProgress} size={14} />
          <span class="text-sm small-touch:display-none">Jobs</span>
          <Show when={activeMediaJobCount()}>
            <span class="text-caption tabular-nums">({activeMediaJobCount()})</span>
          </Show>
        </button>
        <Show when={selectedConversation()}>
          <button
            type="button"
            class="icon-btn header-settings-btn"
            title="Conversation settings"
            aria-label="Conversation settings"
            onClick={() => show('conversation')}
          >
            <FontAwesomeIcon icon={faGear} size={14} />
          </button>
        </Show>
      </div>
    </header>
  );
}
