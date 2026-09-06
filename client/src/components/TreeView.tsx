import { For, Show, createMemo, createSignal } from 'solid-js';
import { faCircle } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import type { Message } from '@tinytavern/shared';
import { api } from '../state/api.ts';
import { activePath, childrenByParent, navigateTree, setState, state } from '../state/store.ts';
import '../styles/treeview.css';
import MobileSidebarButton from './MobileSidebarButton.tsx';
import { speakerName, snippet } from './treeSummary.ts';

/** Activation restores the descendant chain through the authoritative treePatch. */
async function activate(message: Message): Promise<void> {
  if (state.treeNavigationPending) return;
  if (message.id === state.tree.activeLeafId) {
    setState('viewMode', 'chat');
    return;
  }
  const ok = await navigateTree(() => api.activate(message.id, state.tree));
  if (ok) setState('viewMode', 'chat');
}

/** Shared between the tree filter and composer search input. */
const [query, setQuery] = createSignal('');

/** Search result: matching message ids, plus their ancestors so the tree keeps its shape. */
interface TreeFilter {
  visible: Set<number>;
  matches: Set<number>;
}

function TreeNode(props: { message: Message; activeIds: Set<number>; filter: TreeFilter | null }) {
  const children = () =>
    (childrenByParent().get(props.message.id) ?? []).filter(
      (child) => !props.filter || props.filter.visible.has(child.id),
    );
  return (
    <li class="treeview-item">
      <button
        class="treeview-node"
        classList={{
          'treeview-on-path': props.activeIds.has(props.message.id),
          'treeview-active-leaf': props.message.id === state.tree.activeLeafId,
          'treeview-match': props.filter?.matches.has(props.message.id) ?? false,
        }}
        disabled={state.treeNavigationPending}
        title={`Activate this branch (#${props.message.id})`}
        onClick={() => void activate(props.message)}
      >
        <span class={`treeview-role role-indicator role-color-${props.message.role}`} />
        <span class="treeview-name">{speakerName(props.message)}</span>
        <span class="treeview-snippet">{snippet(props.message)}</span>
        <Show when={props.message.status !== 'done'}>
          <span
            class={`treeview-status treeview-status-${props.message.status}`}
            title={props.message.genMeta?.error ?? undefined}
          >
            {props.message.status}
          </span>
        </Show>
        <Show when={props.message.id === state.tree.activeLeafId}>
          <FontAwesomeIcon icon={faCircle} size={8} class="treeview-active-marker" />
        </Show>
      </button>
      <Show when={children().length > 0}>
        <ul class="treeview-children">
          <For each={children()}>
            {(child) => (
              <TreeNode message={child} activeIds={props.activeIds} filter={props.filter} />
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
}

export default function TreeView() {
  const activeIds = createMemo(() => new Set(activePath().map((message) => message.id)));
  const filter = createMemo<TreeFilter | null>(() => {
    const q = query().trim().toLowerCase();
    if (!q) return null;
    const visible = new Set<number>();
    const matches = new Set<number>();
    for (const message of Object.values(state.tree.messages)) {
      const haystack = `${speakerName(message)}\n${message.content}`.toLowerCase();
      if (!haystack.includes(q)) continue;
      matches.add(message.id);
      let cursor: Message | undefined = message;
      while (cursor && !visible.has(cursor.id)) {
        visible.add(cursor.id);
        cursor = cursor.parentId != null ? state.tree.messages[cursor.parentId] : undefined;
      }
    }
    return { visible, matches };
  });
  const roots = () =>
    (childrenByParent().get(-1) ?? []).filter(
      (message) => !filter() || filter()!.visible.has(message.id),
    );
  return (
    <div class="treeview">
      <Show
        when={roots().length > 0}
        fallback={<p class="hint">{query().trim() ? 'No matches.' : 'No messages yet.'}</p>}
      >
        <ul class="treeview-tree">
          <For each={roots()}>
            {(message) => <TreeNode message={message} activeIds={activeIds()} filter={filter()} />}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/** Search bar rendered in place of the composer while the tree view is active. */
export function TreeSearch() {
  return (
    <div class="composer treeview-search">
      <MobileSidebarButton />
      <input
        type="search"
        placeholder="Search messages…"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
    </div>
  );
}
