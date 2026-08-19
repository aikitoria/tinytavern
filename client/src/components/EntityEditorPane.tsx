import { For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { EditorId } from '../util.ts';

/** The subset of createEntityEditor's return value the pane needs. */
interface PaneEditor {
  selectedId: () => EditorId;
  saved: () => boolean;
  status: () => string;
  nav: { detailOpen: () => boolean; closeDetail: () => void };
  select: (id: EditorId) => void;
  save: () => Promise<boolean>;
  discard: () => void;
  remove: () => Promise<void>;
  duplicate: () => void;
}

/**
 * Master-detail scaffolding shared by the settings CRUD tabs: the entity list
 * with "+ New", the mobile back button, and the Create/Save/Discard/Delete
 * action row with saved-flash and status hint. The form fields are children.
 */
export default function EntityEditorPane<T extends { id: number }>(props: {
  editor: PaneEditor;
  items: readonly T[];
  itemLabel: (item: T) => JSX.Element;
  newLabel: string;
  /** Extra list-header content rendered beside "+ New" (e.g. card import). */
  listActions?: JSX.Element;
  /** Optional filtering control between the list actions and list contents. */
  listSearch?: JSX.Element;
  /** Extra action buttons for existing entities, before Delete (e.g. Export). */
  extraActions?: JSX.Element;
  /** Custom hierarchy for lists that are not flat (e.g. character folders). */
  listContent?: JSX.Element;
  children: JSX.Element;
}) {
  const editor = props.editor;
  const NewButton = () => (
    <button
      class="entity-new-btn"
      classList={{ active: editor.selectedId() === 'new' }}
      onClick={() => editor.select('new')}
    >
      {props.newLabel}
    </button>
  );
  return (
    <div class="master-detail" classList={{ 'detail-open': editor.nav.detailOpen() }}>
      <div class="entity-list">
        <Show when={props.listActions} fallback={<NewButton />}>
          <div class="entity-list-actions">
            <NewButton />
            {props.listActions}
          </div>
        </Show>
        {props.listSearch}
        <Show
          when={props.listContent}
          fallback={
            <For each={props.items}>
              {(item) => (
                <button
                  classList={{ active: editor.selectedId() === item.id }}
                  onClick={() => editor.select(item.id)}
                >
                  {props.itemLabel(item)}
                </button>
              )}
            </For>
          }
        >
          {props.listContent}
        </Show>
      </div>
      <div class="form">
        <button class="detail-back" onClick={editor.nav.closeDetail}>
          ‹ Back to list
        </button>
        {props.children}
        <div class="form-actions">
          <button class="primary-btn" onClick={() => void editor.save()}>
            {editor.selectedId() === 'new' ? 'Create' : 'Save'}
          </button>
          <button onClick={editor.discard}>Discard</button>
          <Show when={editor.selectedId() !== 'new'}>
            <button onClick={editor.duplicate}>Duplicate</button>
            {props.extraActions}
            <button class="danger-btn" onClick={() => void editor.remove()}>
              Delete
            </button>
          </Show>
          <Show when={editor.saved()}>
            <span class="saved-flash">✓ Saved</span>
          </Show>
        </div>
        <Show when={editor.status()}>
          <p class="hint">{editor.status()}</p>
        </Show>
      </div>
    </div>
  );
}
