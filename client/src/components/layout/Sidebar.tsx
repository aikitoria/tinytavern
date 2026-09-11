import {
  faChevronDown,
  faChevronRight,
  faEllipsis,
  faLayerGroup,
  faSliders,
  faPlus,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { faImages } from '@fortawesome/free-regular-svg-icons';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import type { Character, Conversation } from '@tinytavern/shared';
import { api } from '../../state/api.ts';
import { createCharacterGroups } from '../../state/characterGroups.ts';
import {
  deleteConversation,
  newConversation,
  openModal,
  selectConversation,
  state,
  toast,
  toggleGroupByCharacter,
} from '../../state/store.ts';
import { errorMessage } from '../../util.ts';
import { confirmDelete } from '../../state/confirm.ts';
import Avatar from '../ui/Avatar.tsx';
import DropdownSurface from '../ui/DropdownSurface.tsx';
import ReferenceEditButton from '../ui/ReferenceEditButton.tsx';
import { editReferencedEntity } from '../../state/entityReferences.ts';

interface SearchResult {
  conversation: Conversation;
  snippet: string | null;
}

interface ConvGroup {
  character: Character | null;
  conversations: Conversation[];
}

export default function Sidebar() {
  const [newMenuOpen, setNewMenuOpen] = createSignal(false);
  const [newChatQuery, setNewChatQuery] = createSignal('');
  const [collapsedCharacterFolders, setCollapsedCharacterFolders] = createSignal<
    ReadonlySet<number>
  >(new Set());
  const [query, setQuery] = createSignal('');
  const [results, setResults] = createSignal<SearchResult[] | null>(null);
  const [conversationMenu, setConversationMenu] = createSignal<Conversation | null>(null);
  let searchTimer: number | undefined;
  let sidebarHead: HTMLDivElement | undefined;
  let newChatButton: HTMLButtonElement | undefined;
  let conversationMenuButton: HTMLButtonElement | undefined;

  const closeNewChatMenu = () => {
    setNewMenuOpen(false);
    setNewChatQuery('');
  };

  // Ignore responses for superseded queries.
  const runSearch = (q: string) => {
    void api
      .search(q)
      .then((r) => {
        if (query().trim() === q) setResults(r);
      })
      .catch(console.error);
  };

  const onSearchInput = (value: string) => {
    setQuery(value);
    clearTimeout(searchTimer);
    const q = value.trim();
    if (!q) {
      setResults(null);
      return;
    }
    searchTimer = window.setTimeout(() => runSearch(q), 250);
  };

  // Remove stale search entries after deletes/renames elsewhere.
  createEffect(
    on(
      () =>
        state.conversations
          .filter((c) => c.promptMode !== 'media')
          .map((c) => `${c.id}:${c.title}`)
          .join('\n'),
      () => {
        const q = query().trim();
        if (q && results()) runSearch(q);
      },
      { defer: true },
    ),
  );

  const create = (characterId: number | null) => {
    setNewMenuOpen(false);
    setNewChatQuery('');
    void newConversation(characterId);
  };

  const toggleCharacterFolder = (id: number) => {
    setCollapsedCharacterFolders((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const { rootCharacters, charactersInFolder, searchActive, matchingCharacterCount } =
    createCharacterGroups(newChatQuery);

  const remove = async (id: number, event: MouseEvent) => {
    event.stopPropagation();
    if (
      !(await confirmDelete(
        {
          title: 'Delete conversation?',
          message: 'This permanently deletes the conversation and its generated images.',
          confirmLabel: 'Delete',
          danger: true,
        },
        event,
      ))
    )
      return;
    try {
      await deleteConversation(id);
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  const runConversationMenuAction = (event: MouseEvent) => {
    const conversation = conversationMenu();
    if (!conversation) return;
    setConversationMenu(null);
    conversationMenuButton?.focus({ preventScroll: true });
    void remove(conversation.id, event);
  };

  const characterOf = (characterId: number | null) =>
    characterId != null ? state.characters.find((c) => c.id === characterId) : undefined;

  // Input is newest-first; first appearance preserves recency within and across groups.
  const convGroups = createMemo<ConvGroup[]>(() => {
    const byKey = new Map<string, ConvGroup>();
    const groups: ConvGroup[] = [];
    for (const conv of state.conversations) {
      if (conv.promptMode === 'media') continue;
      const character = characterOf(conv.characterId) ?? null;
      const key = character ? String(character.id) : 'none';
      let group = byKey.get(key);
      if (!group) {
        group = { character, conversations: [] };
        byKey.set(key, group);
        groups.push(group);
      }
      group.conversations.push(conv);
    }
    return groups;
  });

  const ConvItem = (props: {
    conv: Conversation;
    snippet?: string | null;
    expanded?: boolean;
    grouped?: boolean;
  }) => {
    let menuButton: HTMLButtonElement | undefined;
    onCleanup(() => {
      if (conversationMenuButton === menuButton) setConversationMenu(null);
    });

    return (
      <div
        class="conv-item gap-0 cursor-pointer select-none border border-solid border-transparent flex items-center p-2 rounded-sm [&:hover_.conv-actions]:max-w-18 [&:hover_.conv-actions]:ml-1 [&:hover_.conv-actions]:opacity-100 [&:hover_.conv-actions]:visible [&:hover_.conv-actions]:pointer-events-auto [&:focus-within_.conv-actions]:max-w-18 [&:focus-within_.conv-actions]:ml-1 [&:focus-within_.conv-actions]:opacity-100 [&:focus-within_.conv-actions]:visible [&:focus-within_.conv-actions]:pointer-events-auto [&.search-result]:items-start [&.search-result]:py-3 [&.search-result_.conv-select]:shadow-clear [&.search-result_.conv-select]:items-start [&.search-result_.avatar]:mt-0.5 [&.search-result_.conv-snippet]:overflow-hidden [&.search-result_.conv-snippet]:wrap-anywhere [&.search-result_.conv-snippet]:text-ellipsis [&.search-result_.conv-snippet]:whitespace-normal mobile-touch:[&_.conv-actions]:display-none"
        classList={{
          active: props.conv.id === state.selectedId,
          'search-result': props.expanded,
        }}
        onClick={() => selectConversation(props.conv.id)}
      >
        <button
          class="conv-select text-inherit bg-clear flex items-center flex-1 min-w-0 gap-2 overflow-hidden p-0 border-clear text-left shadow-clear [&:hover:not(:disabled)]:bg-clear [&:hover:not(:disabled)]:border-transparent rounded-[calc(var(--radius-control)_-_2px)]"
          aria-current={props.conv.id === state.selectedId ? 'page' : undefined}
        >
          <Show when={!props.grouped}>
            <Show
              when={characterOf(props.conv.characterId)}
              fallback={<span class="avatar avatar-fallback">A</span>}
            >
              {(character) => <Avatar src={character().avatarThumbnail} name={character().name} />}
            </Show>
          </Show>
          <span class="flex flex-col flex-1 min-w-0">
            <span class="text-body-small truncate">{props.conv.title}</span>
            <Show when={props.snippet}>
              <span class="conv-snippet truncate text-dim text-xs">{props.snippet}</span>
            </Show>
          </span>
        </button>
        <span
          class="conv-actions flex-none max-w-0 ml-0 opacity-0 invisible pointer-events-none inline-flex overflow-hidden"
          aria-label={`Actions for ${props.conv.title}`}
        >
          <button
            class="icon-btn conv-delete"
            title="Delete"
            aria-label={`Delete ${props.conv.title}`}
            onClick={(e) => void remove(props.conv.id, e)}
          >
            <FontAwesomeIcon icon={faXmark} size={14} />
          </button>
        </span>
        <button
          ref={menuButton}
          type="button"
          class="icon-btn display-none mobile-touch:inline-flex mobile-touch:ml-1"
          title="Conversation actions"
          aria-label={`Actions for ${props.conv.title}`}
          aria-haspopup="menu"
          aria-expanded={conversationMenu()?.id === props.conv.id}
          onClick={(event) => {
            event.stopPropagation();
            const open = conversationMenu()?.id === props.conv.id;
            conversationMenuButton = event.currentTarget;
            setConversationMenu(open ? null : props.conv);
          }}
        >
          <FontAwesomeIcon icon={faEllipsis} size={16} />
        </button>
      </div>
    );
  };

  const CharacterChoice = (props: { character: Character; child?: boolean }) => (
    <div class="flex items-center gap-1 [&>button:first-child]:flex-1 [&>button:first-child]:min-w-0">
      <button
        classList={{ 'new-chat-folder-child': props.child }}
        onClick={() => create(props.character.id)}
      >
        <Avatar src={props.character.avatarThumbnail} name={props.character.name} />{' '}
        {props.character.name}
      </button>
      <ReferenceEditButton
        label={props.character.name}
        onClick={() => {
          closeNewChatMenu();
          editReferencedEntity('characters', props.character.id);
        }}
      />
    </div>
  );
  return (
    <aside
      class="sidebar w-sidebar border-r border-r-solid border-r-subtle flex flex-col relative bg-chrome shrink-0 [&_.avatar]:text-sm [&_.avatar]:size-6.5 small-touch:fixed small-touch:z-60 small-touch:[&.open]:shadow-clear small-touch:inset-[0_auto_0_0] small-touch:w-[min(85vw,_var(--sidebar-w))] small-touch:pt-[env(safe-area-inset-top)]"
      classList={{ open: state.sidebarOpen }}
    >
      <div
        class="py-1 px-2 min-h-bar border-b border-b-solid border-b-subtle flex items-center flex-none justify-between"
        ref={sidebarHead}
      >
        <span class="flex items-center min-w-0 gap-2 font-semibold text-heading leading-tight small-touch:text-mobile-title">
          <span class="truncate">TinyTavern</span>
          <span
            class="rounded-circle bg-danger shrink-0 size-2 [&.ok]:bg-success"
            classList={{ ok: state.connected }}
            title={state.connected ? 'Connected' : 'Disconnected'}
            role="status"
            aria-label={state.connected ? 'Connected' : 'Disconnected'}
          />
        </span>
        <span class="flex items-center flex-none">
          <button
            ref={newChatButton}
            type="button"
            class="icon-btn"
            title="New chat"
            aria-label="New chat"
            aria-haspopup="dialog"
            aria-expanded={newMenuOpen()}
            onClick={() => {
              const open = !newMenuOpen();
              setNewMenuOpen(open);
              if (!open) setNewChatQuery('');
            }}
          >
            <FontAwesomeIcon icon={faPlus} size={16} />
          </button>
          <button
            type="button"
            class="icon-btn"
            title="Gallery"
            aria-label="Open saved image gallery"
            onClick={() => {
              closeNewChatMenu();
              openModal('gallery');
            }}
          >
            <FontAwesomeIcon icon={faImages} />
          </button>
          <button
            type="button"
            class="icon-btn"
            title="Settings"
            aria-label="Open settings"
            onClick={() => {
              closeNewChatMenu();
              openModal('settings');
            }}
          >
            <FontAwesomeIcon icon={faSliders} size={16} />
          </button>
        </span>
      </div>

      <DropdownSurface
        open={newMenuOpen()}
        anchor={() => sidebarHead}
        dismissRoot={() => newChatButton}
        focusTarget={() => newChatButton}
        onClose={closeNewChatMenu}
        class="[&_.new-chat-folder-toggle]:text-muted [&_.new-chat-folder-toggle]:text-xs [&_.new-chat-folder-toggle]:font-semibold [&_.new-chat-folder-toggle]:tracking-wide [&_.new-chat-folder-child]:pl-[calc(var(--space-3)_+_22px)]"
        role="dialog"
        ariaLabel="Choose a character for a new chat"
        placement="bottom"
        align="start"
        matchAnchorWidth
        maxHeight={() => window.innerHeight * 0.5}
        anchorInset={8}
      >
        <div class="sticky top-0 z-1 bg-raised border-b border-b-solid border-b-line p-2">
          <input
            class="search-input flex-1 min-w-0"
            placeholder="Search characters…"
            value={newChatQuery()}
            onInput={(event) => setNewChatQuery(event.currentTarget.value)}
          />
        </div>
        {/* Assistant is normally a seeded character. */}
        <Show when={state.characters.length === 0}>
          <button onClick={() => create(null)}>
            <span class="avatar avatar-fallback">A</span> Assistant
          </button>
        </Show>
        <For each={state.characterFolders}>
          {(folder) => (
            <Show when={charactersInFolder(folder.id).length > 0}>
              <div class="new-chat-folder">
                <button
                  class="new-chat-folder-toggle"
                  aria-expanded={searchActive() || !collapsedCharacterFolders().has(folder.id)}
                  onClick={() => {
                    if (!searchActive()) toggleCharacterFolder(folder.id);
                  }}
                >
                  <span class="w-2.5 text-center text-muted grow-0 shrink-0 basis-2.5">
                    {searchActive() || !collapsedCharacterFolders().has(folder.id) ? (
                      <FontAwesomeIcon icon={faChevronDown} size={10} />
                    ) : (
                      <FontAwesomeIcon icon={faChevronRight} size={12} />
                    )}
                  </span>
                  <span>{folder.name}</span>
                </button>
                <Show when={searchActive() || !collapsedCharacterFolders().has(folder.id)}>
                  <For each={charactersInFolder(folder.id)}>
                    {(character) => <CharacterChoice character={character} child />}
                  </For>
                </Show>
              </div>
            </Show>
          )}
        </For>
        <For each={rootCharacters()}>
          {(character) => <CharacterChoice character={character} />}
        </For>
        <Show when={searchActive() && matchingCharacterCount() === 0}>
          <p class="hint py-1 px-2">No matches.</p>
        </Show>
      </DropdownSurface>

      <nav class="flex-1 min-h-0 overflow-y-auto p-2">
        <Show
          when={results()}
          fallback={
            <Show
              when={state.groupByCharacter}
              fallback={
                <For each={state.conversations.filter((c) => c.promptMode !== 'media')}>
                  {(conv) => <ConvItem conv={conv} />}
                </For>
              }
            >
              <For each={convGroups()}>
                {(group) => (
                  <section class="conv-group [&:first-child_.conv-group-head]:mt-0 [&_.conv-item]:ml-3 [&_.conv-item]:pl-5 [&_.conv-item]:relative [&_.conv-item::before]:absolute [&_.conv-item::before]:left-1.5 [&_.conv-item::before]:h-2 [&_.conv-item::before]:top-[calc(50%_-_7px)] [&_.conv-item::before]:w-[7px]">
                    <div class="conv-group-head select-none flex items-center gap-2 mt-2 p-2 pb-1">
                      <Show
                        when={group.character}
                        fallback={<span class="avatar avatar-fallback">A</span>}
                      >
                        {(character) => (
                          <Avatar src={character().avatarThumbnail} name={character().name} />
                        )}
                      </Show>
                      <span class="truncate text-dim text-xs font-semibold">
                        {group.character?.name ?? 'No character'}
                      </span>
                    </div>
                    <For each={group.conversations}>
                      {(conv) => <ConvItem conv={conv} grouped />}
                    </For>
                  </section>
                )}
              </For>
            </Show>
          }
        >
          {(found) => (
            <>
              <Show when={found().length === 0}>
                <p class="hint py-1 px-2">No matches.</p>
              </Show>
              <For each={found()}>
                {(r) => <ConvItem conv={r.conversation} snippet={r.snippet} expanded />}
              </For>
            </>
          )}
        </Show>
      </nav>
      <footer class="border-t border-t-solid border-t-subtle flex items-center flex-none gap-2 [&_.search-input]:h-8 [&_.search-input]:py-1 [&_.search-input]:px-2 p-[var(--space-2)_var(--space-2)_calc(var(--space-2)_+_env(safe-area-inset-bottom))]">
        <div class="flex flex-1 min-w-0 p-0">
          <input
            class="search-input flex-1 min-w-0"
            placeholder="Search…"
            aria-label="Search conversations"
            value={query()}
            onInput={(e) => onSearchInput(e.currentTarget.value)}
          />
        </div>
        <button
          type="button"
          class="icon-btn text-control border-transparent bg-clear size-8 [&:hover]:text-foreground [&:hover]:bg-raised [&:hover]:border-transparent"
          classList={{ 'icon-btn-active': state.groupByCharacter }}
          title="Group by character"
          aria-label="Group by character"
          aria-pressed={state.groupByCharacter}
          onClick={toggleGroupByCharacter}
        >
          <FontAwesomeIcon icon={faLayerGroup} size={16} />
        </button>
      </footer>
      <DropdownSurface
        open={conversationMenu() != null}
        anchor={() => conversationMenuButton}
        onClose={() => setConversationMenu(null)}
        class="[&_.danger]:text-danger"
        role="menu"
        ariaLabel={`Actions for ${conversationMenu()?.title ?? 'conversation'}`}
        placement="auto"
        align="end"
        minWidth={160}
        keyboardNavigation
        autoFocus
      >
        <button type="button" role="menuitem" class="danger" onClick={runConversationMenuAction}>
          Delete
        </button>
      </DropdownSurface>
    </aside>
  );
}
