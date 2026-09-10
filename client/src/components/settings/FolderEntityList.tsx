import EntityActiveBadge from './EntityActiveBadge.tsx';
import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import { faChevronDown, faChevronRight, faPen, faXmark } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import Modal from '../ui/Modal.tsx';
import SettingLabel, { createDefaultField } from '../forms/SettingField.tsx';
import { confirmAction } from '../../state/confirm.ts';
import { errorMessage } from '../../util.ts';
import { collectionByName } from '../../state/collectionOrder.ts';

/** The same searchable folder browser serves settings entities with numeric or string IDs. */
export function createFolderBrowser<
  T extends { id: number | string; name: string },
  F extends { id: number | string; name: string },
>(props: {
  items: () => readonly T[];
  folders: () => readonly F[];
  folderId: (item: T) => F['id'] | null;
  selectedId: () => number | string;
  activeId?: () => T['id'] | null;
  select: (id: T['id']) => void;
  label: (item: T) => JSX.Element;
  noun: string;
  create: (name: string) => Promise<unknown>;
  rename: (id: F['id'], name: string) => Promise<unknown>;
  remove: (id: F['id']) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = createSignal('');
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<F['id']>>(new Set());
  const [dialog, setDialog] = createSignal<{ id: F['id'] | null } | null>(null);
  const [name, setName] = createSignal('');
  const [error, setError] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const field = createDefaultField(() => '');
  const empty: T[] = [];
  const sortedItems = createMemo(() => collectionByName(props.items()));
  const sortedFolders = createMemo(() => collectionByName(props.folders()));
  const groups = createMemo(() => {
    const search = query().trim().toLocaleLowerCase();
    const folders = new Set(props.folders().map((folder) => folder.id));
    const root: T[] = [];
    const byFolder = new Map<F['id'], T[]>();
    let count = 0;
    for (const item of sortedItems()) {
      if (search && !item.name.toLocaleLowerCase().includes(search)) continue;
      count++;
      const folder = props.folderId(item);
      if (folder === null || !folders.has(folder)) root.push(item);
      else {
        let group = byFolder.get(folder);
        if (!group) byFolder.set(folder, (group = []));
        group.push(item);
      }
    }
    return { root, byFolder, count, search: Boolean(search) };
  });
  const members = (id: F['id']) => groups().byFolder.get(id) ?? empty;
  const expanded = (id: F['id']) => groups().search || !collapsed().has(id);
  const edit = (id: F['id'] | null, current = '') => {
    setName(current);
    setError('');
    setDialog({ id });
  };
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const current = dialog();
    if (!current || !name().trim() || saving()) return;
    setSaving(true);
    setError('');
    try {
      if (current.id === null) await props.create(name().trim());
      else await props.rename(current.id, name().trim());
      setDialog(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const remove = async (folder: F) => {
    if (
      !(await confirmAction({
        title: 'Delete folder?',
        message: `Delete “${folder.name}”? Its ${props.noun} will move to the root.`,
        confirmLabel: 'Delete folder',
        danger: true,
      }))
    )
      return;
    try {
      await props.remove(folder.id);
    } catch (err) {
      props.onError(errorMessage(err));
    }
  };
  const Entry = (entry: { item: T; child?: boolean }) => (
    <button
      class="character-tree-entry"
      classList={{
        active: props.selectedId() === entry.item.id,
        'character-tree-child': entry.child,
      }}
      onClick={() => props.select(entry.item.id)}
    >
      <span class="min-w-0 truncate flex flex-1 items-center gap-2">{props.label(entry.item)}</span>
      <Show when={props.activeId?.() === entry.item.id}>
        <EntityActiveBadge />
      </Show>
    </button>
  );
  const NewButton = () => <button onClick={() => edit(null)}>Folder</button>;
  const List = () => (
    <>
      <div class="mb-2 [&_.search-input]:min-h-control">
        <input
          class="search-input w-full min-w-0"
          aria-label={`Search ${props.noun}`}
          placeholder={`Search ${props.noun}…`}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <For each={sortedFolders()}>
        {(folder) => (
          <Show when={!groups().search || members(folder.id).length > 0}>
            <section class="character-folder">
              <div class="character-folder-row">
                <button
                  class="character-folder-toggle"
                  aria-expanded={expanded(folder.id)}
                  title={expanded(folder.id) ? 'Collapse folder' : 'Expand folder'}
                  onClick={() => {
                    if (groups().search) return;
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(folder.id)) next.delete(folder.id);
                      else next.add(folder.id);
                      return next;
                    });
                  }}
                >
                  <span class="w-2.5 text-center text-muted grow-0 shrink-0 basis-2.5">
                    <FontAwesomeIcon
                      icon={expanded(folder.id) ? faChevronDown : faChevronRight}
                      size={expanded(folder.id) ? 10 : 12}
                    />
                  </span>
                  <span class="text-ellipsis overflow-hidden">{folder.name}</span>
                </button>
                <button
                  class="character-folder-action"
                  title="Rename folder"
                  aria-label={`Rename ${folder.name}`}
                  onClick={() => edit(folder.id, folder.name)}
                >
                  <FontAwesomeIcon icon={faPen} size={14} />
                </button>
                <button
                  class="character-folder-action"
                  title="Delete folder"
                  aria-label={`Delete ${folder.name}`}
                  onClick={() => void remove(folder)}
                >
                  <FontAwesomeIcon icon={faXmark} size={14} />
                </button>
              </div>
              <Show when={expanded(folder.id)}>
                <For each={members(folder.id)}>{(item) => <Entry item={item} child />}</For>
                <Show when={!groups().search && members(folder.id).length === 0}>
                  <span class="character-folder-empty">Empty folder</span>
                </Show>
              </Show>
            </section>
          </Show>
        )}
      </For>
      <For each={groups().root}>{(item) => <Entry item={item} />}</For>
      <Show when={groups().search && groups().count === 0}>
        <p class="hint py-1 px-2">No matches.</p>
      </Show>
    </>
  );
  const Dialog = () => (
    <Show when={dialog()}>
      {(current) => (
        <Modal
          title={current().id === null ? 'Create folder' : 'Rename folder'}
          class="confirm-modal [&.confirm-modal]:h-auto [&.confirm-modal]:w-full [&.confirm-modal]:max-w-107.5 [&.confirm-modal]:max-h-[min(80dvh,_520px)] [&_.modal-body]:p-5 small-touch:[&.confirm-modal]:border small-touch:[&.confirm-modal]:border-solid small-touch:[&.confirm-modal]:border-line small-touch:[&.confirm-modal]:rounded-lg small-touch:[&.confirm-modal]:pt-0"
          backdropClass="confirm-backdrop z-400 small-touch:[&.confirm-backdrop]:p-4"
          onClose={() => {
            if (!saving()) setDialog(null);
          }}
        >
          <form
            class="form [&_label]:text-label [&_label]:text-foreground [&_label]:mt-2"
            onSubmit={save}
          >
            <SettingLabel field={field} for="folder-name">
              Folder name
            </SettingLabel>
            <input
              ref={field.ref}
              id="folder-name"
              data-modal-initial-focus
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
            />
            <Show when={error()}>
              <p class="notice notice-error" role="alert">
                {error()}
              </p>
            </Show>
            <div class="form-actions flex items-center gap-2 flex-wrap mt-4">
              <button class="primary-btn" type="submit" disabled={!name().trim() || saving()}>
                {saving() ? 'Saving…' : current().id === null ? 'Create' : 'Rename'}
              </button>
              <button type="button" disabled={saving()} onClick={() => setDialog(null)}>
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      )}
    </Show>
  );
  return {
    NewButton,
    List,
    Dialog,
    options: () =>
      sortedFolders().map((folder) => ({
        value: String(folder.id),
        label: folder.name,
        edit: () => edit(folder.id, folder.name),
      })),
  };
}
