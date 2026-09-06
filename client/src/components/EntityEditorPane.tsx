import { faCheck, faChevronLeft, faPlus } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import { For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { EditorId, NoticeKind } from '../util.ts';

interface PaneEditor {
  selectedId: () => EditorId;
  saved: () => boolean;
  status: () => string;
  statusKind: () => NoticeKind;
  nav: { detailOpen: () => boolean; closeDetail: () => void };
  select: (id: EditorId) => void;
  save: () => Promise<boolean>;
  discard: () => void;
  remove: () => Promise<void>;
  duplicate: () => void;
}

/** Shared settings editor shell; children supply the form fields. */
export default function EntityEditorPane<T extends { id: number }>(props: {
  editor: PaneEditor;
  items: readonly T[];
  itemLabel: (item: T) => JSX.Element;
  newLabel: string;
  /** Content beside the new-entity button. */
  listActions?: JSX.Element;
  /** Filter between list actions and contents. */
  listSearch?: JSX.Element;
  /** Actions for existing entities, before Delete. */
  extraActions?: JSX.Element;
  /** Replaces the flat list, e.g. with character folders. */
  listContent?: JSX.Element;
  /** Entity currently in use, independent of editor selection. */
  activeId?: number | null;
  /** Virtual list row for a nullable built-in/none setting. */
  defaultOption?: { label: string; description: string };
  children: JSX.Element;
}) {
  const editor = props.editor;
  const NewButton = () => (
    <button
      class="entity-new-btn"
      classList={{ active: editor.selectedId() === 'new' }}
      onClick={() => editor.select('new')}
    >
      <FontAwesomeIcon icon={faPlus} size={12} /> {props.newLabel}
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
        <Show when={props.defaultOption}>
          {(option) => (
            <button
              class="entity-default-btn"
              classList={{
                active: editor.selectedId() === 'default',
                'in-use': props.activeId === null,
              }}
              onClick={() => editor.select('default')}
            >
              <span class="entity-list-label">{option().label}</span>
              <Show when={props.activeId === null}>
                <span class="entity-active-mark">Active</span>
              </Show>
            </button>
          )}
        </Show>
        <Show
          when={props.listContent}
          fallback={
            <For each={props.items}>
              {(item) => (
                <button
                  classList={{
                    active: editor.selectedId() === item.id,
                    'in-use': props.activeId === item.id,
                  }}
                  onClick={() => editor.select(item.id)}
                >
                  <span class="entity-list-label">{props.itemLabel(item)}</span>
                  <Show when={props.activeId === item.id}>
                    <span class="entity-active-mark">Active</span>
                  </Show>
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
          <FontAwesomeIcon icon={faChevronLeft} size={12} /> Back to list
        </button>
        <Show
          when={editor.selectedId() === 'default' && props.defaultOption}
          fallback={
            <>
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
                  <span class="saved-flash">
                    <FontAwesomeIcon icon={faCheck} size={12} /> Saved
                  </span>
                </Show>
              </div>
            </>
          }
        >
          {(option) => (
            <div class="entity-default-detail">
              <h3>{option().label}</h3>
              <p>{option().description}</p>
            </div>
          )}
        </Show>
        <Show when={editor.status()}>
          <p
            class="notice"
            classList={{
              'notice-error': editor.statusKind() === 'error',
              'notice-warning': editor.statusKind() === 'warning',
              'notice-info': editor.statusKind() === 'info',
              'notice-success': editor.statusKind() === 'success',
            }}
            role={editor.statusKind() === 'error' ? 'alert' : 'status'}
          >
            {editor.status()}
          </p>
        </Show>
      </div>
    </div>
  );
}
