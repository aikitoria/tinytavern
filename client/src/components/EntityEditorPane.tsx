import EntityPageTransfer from './EntityPageTransfer.tsx';
import SettingsTransferButtons from './SettingsTransferButtons.tsx';
import { entityTransferData, type TransferEntity } from '@tinytavern/shared';
import { api } from '../state/api.ts';
import SettingsActions, { SettingsActionsContext } from './SettingsActions.tsx';
import { faCheck, faChevronLeft, faPlus } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import { For, Show, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import type { EditorId, NoticeKind } from '../util.ts';
import { registerUiBack } from '../state/uiBack.ts';

interface PaneEditor {
  selectedId: () => EditorId;
  draftData: () => Record<string, unknown>;
  importData: (data: Record<string, unknown>, asNew?: boolean) => void;
  setStatus: (message: string, kind?: NoticeKind) => void;
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
  transferType?: TransferEntity;
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
  readOnly?: boolean;
  /** Virtual list row for a nullable built-in/none setting. */
  defaultOption?: { label: string; description: string };
  children: JSX.Element;
}) {
  const editor = props.editor;
  const [actionsTarget, setActionsTarget] = createSignal<HTMLElement>();
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
      <div class="entity-sidebar">
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
        <Show when={props.transferType}>
          {(type) => (
            <div class="entity-transfer-actions">
              <EntityPageTransfer type={type()} onError={editor.setStatus} />
            </div>
          )}
        </Show>
      </div>
      <div class="entity-detail">
        <SettingsActionsContext.Provider value={actionsTarget}>
          <div class="form">
            <button
              ref={(element) => registerUiBack(element, editor.nav.closeDetail)}
              class="detail-back"
              onClick={editor.nav.closeDetail}
            >
              <FontAwesomeIcon icon={faChevronLeft} size={12} /> Back to list
            </button>
            <Show
              when={editor.selectedId() === 'default' && props.defaultOption}
              fallback={
                <>
                  <Show when={props.readOnly}>
                    <p class="hint">Read-only default · duplicate it to customize.</p>
                  </Show>
                  {props.children}
                  <SettingsActions>
                    <Show when={!props.readOnly}>
                      <button class="primary-btn" onClick={() => void editor.save()}>
                        {editor.selectedId() === 'new' ? 'Create' : 'Save'}
                      </button>
                    </Show>
                    <Show when={props.transferType}>
                      {(type) => (
                        <SettingsTransferButtons
                          type={`entity:${type()}`}
                          onError={editor.setStatus}
                          exportData={async () => {
                            const draft = editor.draftData();
                            if (
                              type() === 'personas' &&
                              typeof editor.selectedId() === 'number' &&
                              draft.avatarData === undefined
                            ) {
                              draft.avatarData = (
                                await api.exportEntityRecord(type(), editor.selectedId() as number)
                              ).avatarData;
                            }
                            return entityTransferData(type(), draft);
                          }}
                          importData={(data) =>
                            editor.importData(entityTransferData(type(), data), props.readOnly)
                          }
                        />
                      )}
                    </Show>
                    <Show when={!props.readOnly}>
                      <button onClick={editor.discard}>Discard</button>
                    </Show>
                    <Show when={editor.selectedId() !== 'new'}>
                      <button onClick={editor.duplicate}>Duplicate</button>
                      {props.extraActions}
                      <Show when={!props.readOnly}>
                        <button class="danger-btn" onClick={() => void editor.remove()}>
                          Delete
                        </button>
                      </Show>
                    </Show>
                    <Show when={editor.saved()}>
                      <span class="saved-flash">
                        <FontAwesomeIcon icon={faCheck} size={12} /> Saved
                      </span>
                    </Show>
                  </SettingsActions>
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
          <div ref={setActionsTarget} class="settings-actions" aria-label="Settings actions" />
        </SettingsActionsContext.Provider>
      </div>
    </div>
  );
}
