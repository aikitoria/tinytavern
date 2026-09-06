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
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import type { Character, Conversation } from '@tinytavern/shared';
import { api } from '../state/api.ts';
import { createCharacterGroups } from '../state/characterGroups.ts';
import {
  deleteConversation,
  newConversation,
  openModal,
  selectConversation,
  state,
  toast,
  toggleGroupByCharacter,
} from '../state/store.ts';
import { errorMessage } from '../util.ts';
import { confirmAction } from '../state/confirm.ts';
import Avatar from './Avatar.tsx';
import DropdownSurface from './DropdownSurface.tsx';

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
  let sidebarToolsRow: HTMLDivElement | undefined;
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
      () => state.conversations.map((c) => `${c.id}:${c.title}`).join('\n'),
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
      !(await confirmAction({
        title: 'Delete conversation?',
        message: 'This permanently deletes the conversation and its generated images.',
        confirmLabel: 'Delete',
        danger: true,
      }))
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

  const ConvItem = (props: { conv: Conversation; snippet?: string | null; expanded?: boolean }) => {
    let menuButton: HTMLButtonElement | undefined;
    onCleanup(() => {
      if (conversationMenuButton === menuButton) setConversationMenu(null);
    });

    return (
      <div
        class="conv-item"
        classList={{
          active: props.conv.id === state.selectedId,
          'search-result': props.expanded,
        }}
        onClick={() => selectConversation(props.conv.id)}
      >
        <button
          class="conv-select"
          aria-current={props.conv.id === state.selectedId ? 'page' : undefined}
        >
          <Show
            when={characterOf(props.conv.characterId)}
            fallback={<span class="avatar avatar-fallback">A</span>}
          >
            {(character) => <Avatar src={character().avatar} name={character().name} />}
          </Show>
          <span class="conv-body">
            <span class="conv-title">{props.conv.title}</span>
            <Show when={props.snippet}>
              <span class="conv-snippet">{props.snippet}</span>
            </Show>
          </span>
        </button>
        <span class="conv-actions" aria-label={`Actions for ${props.conv.title}`}>
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
          class="icon-btn conv-menu-btn"
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

  return (
    <aside class="sidebar" classList={{ open: state.sidebarOpen }}>
      <div class="sidebar-head">
        <span class="brand">
          <span class="brand-name">TinyTavern</span>
          <span
            class="conn-dot"
            classList={{ ok: state.connected }}
            title={state.connected ? 'Connected' : 'Disconnected'}
            role="status"
            aria-label={state.connected ? 'Connected' : 'Disconnected'}
          />
        </span>
        <span class="sidebar-head-actions">
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

      <div class="sidebar-tools-row" ref={sidebarToolsRow}>
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
        <DropdownSurface
          open={newMenuOpen()}
          anchor={() => sidebarToolsRow}
          dismissRoot={() => newChatButton}
          focusTarget={() => newChatButton}
          onClose={closeNewChatMenu}
          class="new-chat-menu"
          role="dialog"
          ariaLabel="Choose a character for a new chat"
          placement="bottom"
          align="start"
          matchAnchorWidth
          maxHeight={() => window.innerHeight * 0.5}
          anchorInset={8}
        >
          <div class="new-chat-search">
            <input
              class="search-input"
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
                    <span class="tree-disclosure">
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
                      {(character) => (
                        <button class="new-chat-folder-child" onClick={() => create(character.id)}>
                          <Avatar src={character.avatar} name={character.name} /> {character.name}
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              </Show>
            )}
          </For>
          <For each={rootCharacters()}>
            {(character) => (
              <button onClick={() => create(character.id)}>
                <Avatar src={character.avatar} name={character.name} /> {character.name}
              </button>
            )}
          </For>
          <Show when={searchActive() && matchingCharacterCount() === 0}>
            <p class="hint search-empty">No matches.</p>
          </Show>
        </DropdownSurface>

        <div class="search-wrap">
          <input
            class="search-input"
            placeholder="Search…"
            aria-label="Search conversations"
            value={query()}
            onInput={(e) => onSearchInput(e.currentTarget.value)}
          />
        </div>
      </div>

      <nav class="conv-list">
        <Show
          when={results()}
          fallback={
            <Show
              when={state.groupByCharacter}
              fallback={<For each={state.conversations}>{(conv) => <ConvItem conv={conv} />}</For>}
            >
              <For each={convGroups()}>
                {(group) => (
                  <section class="conv-group">
                    <div class="conv-group-head">
                      <Show
                        when={group.character}
                        fallback={<span class="avatar avatar-fallback">A</span>}
                      >
                        {(character) => <Avatar src={character().avatar} name={character().name} />}
                      </Show>
                      <span class="conv-group-name">{group.character?.name ?? 'No character'}</span>
                    </div>
                    <For each={group.conversations}>{(conv) => <ConvItem conv={conv} />}</For>
                  </section>
                )}
              </For>
            </Show>
          }
        >
          {(found) => (
            <>
              <Show when={found().length === 0}>
                <p class="hint search-empty">No matches.</p>
              </Show>
              <For each={found()}>
                {(r) => <ConvItem conv={r.conversation} snippet={r.snippet} expanded />}
              </For>
            </>
          )}
        </Show>
      </nav>
      <button
        type="button"
        class="icon-btn sidebar-group-toggle"
        classList={{ 'icon-btn-active': state.groupByCharacter }}
        title="Group by character"
        aria-label="Group by character"
        aria-pressed={state.groupByCharacter}
        onClick={toggleGroupByCharacter}
      >
        <FontAwesomeIcon icon={faLayerGroup} size={16} />
      </button>
      <DropdownSurface
        open={conversationMenu() != null}
        anchor={() => conversationMenuButton}
        onClose={() => setConversationMenu(null)}
        class="conv-actions-menu"
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
