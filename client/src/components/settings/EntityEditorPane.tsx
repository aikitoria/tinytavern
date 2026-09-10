import EntityActiveBadge from './EntityActiveBadge.tsx';
import EntityPageTransfer from './EntityPageTransfer.tsx';
import { SettingsDraftContext } from './SettingsSection.tsx';
import { entitySettingsSchema } from './settingsSchema.ts';
import type { ENTITY_FIELDS, SettingsFieldSchema } from '@tinytavern/shared';
import SettingsTransferButtons from './SettingsTransferButtons.tsx';
import { entityTransferData, type TransferEntity } from '@tinytavern/shared';
import { api } from '../../state/api.ts';
import SettingsActions, { SettingsActionsContext } from './SettingsActions.tsx';
import { faChevronLeft, faPlus } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import { For, Show, createMemo, createSignal } from 'solid-js';
import { collectionByName } from '../../state/collectionOrder.ts';
import type { JSX } from 'solid-js';
import type { EditorId, NoticeKind } from '../../util.ts';
import { registerUiBack } from '../../state/uiBack.ts';

interface PaneEditor<Id extends number | string> {
  selectedId: () => EditorId<Id>;
  identity: () => unknown;
  draftData: () => Record<string, unknown>;
  importData: (data: Record<string, unknown>, asNew?: boolean) => void;
  setStatus: (message: string, kind?: NoticeKind) => void;
  saved: () => boolean;
  saving: () => boolean;
  status: () => string;
  statusKind: () => NoticeKind;
  nav: { detailOpen: () => boolean; closeDetail: () => void };
  select: (id: EditorId<Id>) => void;
  save: () => Promise<boolean>;
  discard: () => void;
  remove: () => Promise<void>;
  duplicate: () => void;
}

/** Shared settings editor shell; children supply the form fields. */
export default function EntityEditorPane<T extends { id: number | string; name: string }>(props: {
  editor: PaneEditor<T['id']>;
  transferType?: TransferEntity;
  sectionType?: keyof typeof ENTITY_FIELDS;
  sectionSchema?: SettingsFieldSchema;
  items: readonly T[];
  itemLabel: (item: T) => JSX.Element;
  newLabel: string;
  /** Content beside the new-entity button. */
  listActions?: JSX.Element;
  listFooter?: JSX.Element;
  formActions?: JSX.Element;
  /** Filter between list actions and contents. */
  listSearch?: JSX.Element;
  /** Actions for existing entities, before Delete. */
  extraActions?: JSX.Element;
  /** Replaces the flat list, e.g. with character folders. */
  listContent?: JSX.Element;
  /** Entity currently in use, independent of editor selection. */
  activeId?: T['id'] | null;
  readOnly?: boolean;
  /** Virtual list row for a nullable built-in/none setting. */
  defaultOption?: { label: string; description: string };
  defaultContent?: JSX.Element;
  defaultActions?: JSX.Element;
  children: JSX.Element;
}) {
  const editor = props.editor;
  const sortedItems = createMemo(() => collectionByName(props.items));
  const exportDraft = async (fields?: readonly string[]) => {
    const draft = editor.draftData();
    const id = editor.selectedId();
    if (
      props.transferType === 'personas' &&
      typeof id === 'number' &&
      draft.avatarData === undefined &&
      (!fields || fields.includes('avatarData'))
    ) {
      draft.avatarData = (await api.exportEntityRecord('personas', id)).avatarData;
    }
    return draft;
  };
  const sectionDraft = {
    get schema() {
      return (
        props.sectionSchema ??
        entitySettingsSchema(props.sectionType ?? props.transferType ?? 'presets')
      );
    },
    read: editor.draftData,
    identity: editor.identity,
    exportRead: exportDraft,
    write: (data: Record<string, unknown>) =>
      editor.importData(data, props.readOnly || editor.selectedId() === 'default'),
    onError: editor.setStatus,
  };
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
    <SettingsDraftContext.Provider value={sectionDraft}>
      <div
        class="master-detail grid-rows-[minmax(0,_1fr)_auto] gap-0 grid flex-1 min-h-0 small-touch:[&>.entity-detail]:display-none small-touch:[&.detail-open>.entity-detail]:flex small-touch:[&.detail-open_.entity-sidebar]:display-none grid-cols-[220px_minmax(0,_1fr)] small-touch:grid-cols-[1fr]"
        classList={{ 'detail-open': editor.nav.detailOpen() }}
      >
        <div class="entity-sidebar border-r border-r-solid border-r-subtle flex flex-col min-w-0 min-h-0 overflow-hidden bg-chrome">
          <div class="entity-list flex flex-col flex-1 min-h-0 overflow-y-auto p-2 bg-chrome [&>button:where(:not(.entity-new-btn))]:flex [&>button:where(:not(.entity-new-btn))]:items-center [&>button:where(:not(.entity-new-btn))]:gap-2 [&>button:where(:not(.entity-new-btn))]:bg-clear [&>button:where(:not(.entity-new-btn))]:border-clear [&>button:where(:not(.entity-new-btn))]:text-left [&>button:where(:not(.entity-new-btn))]:min-h-control [&>button:where(:not(.entity-new-btn))]:py-1 [&>button:where(:not(.entity-new-btn))]:px-2 [&>button:where(:not(.entity-new-btn))]:rounded-sm [&>button:where(:not(.entity-new-btn))]:truncate [&_:where(.character-folder)_button]:flex [&_:where(.character-folder)_button]:items-center [&_:where(.character-folder)_button]:gap-2 [&_:where(.character-folder)_button]:bg-clear [&_:where(.character-folder)_button]:border-clear [&_:where(.character-folder)_button]:text-left [&_:where(.character-folder)_button]:min-h-control [&_:where(.character-folder)_button]:py-1 [&_:where(.character-folder)_button]:px-2 [&_:where(.character-folder)_button]:rounded-sm [&_:where(.character-folder)_button]:truncate [&_.entity-default-btn]:mb-1 [&_.entity-default-btn]:text-dim [&_button.in-use_.entity-list-label]:text-foreground [&_.entity-new-btn]:flex [&_.entity-new-btn]:items-center [&_.entity-new-btn]:gap-2 [&_.entity-new-btn]:justify-center [&>.entity-new-btn]:mb-2 [&_.entity-new-btn.active]:border-accent [&_.entity-new-btn.active]:shadow-clear [&_.avatar]:text-xs [&_.avatar]:size-6 [&_.character-folder]:flex [&_.character-folder]:flex-col [&_.character-folder-row]:grid [&_.character-folder-row]:items-center [&_.character-tree-entry]:min-h-8.5 [&_.character-tree-entry]:py-1 [&_.character-tree-entry]:px-2 [&_.character-folder-row>button]:min-h-8.5 [&_.character-folder-row>button]:py-1 [&_.character-folder-row>button]:px-2 [&_.character-folder-toggle]:min-w-0 [&_.character-folder-action]:justify-center [&_.character-folder-action]:text-muted [&_.character-folder-action]:opacity-0 [&_.character-folder-action]:invisible [&_.character-folder-action]:pointer-events-none [&_.character-folder-row:hover_.character-folder-action]:opacity-100 [&_.character-folder-row:hover_.character-folder-action]:visible [&_.character-folder-row:hover_.character-folder-action]:pointer-events-auto [&_.character-folder-row:focus-within_.character-folder-action]:opacity-100 [&_.character-folder-row:focus-within_.character-folder-action]:visible [&_.character-folder-row:focus-within_.character-folder-action]:pointer-events-auto [&_.character-tree-child]:ml-3 [&_.character-tree-child]:pl-5 [&_.character-tree-child]:relative [&_.character-tree-child::before]:absolute [&_.character-tree-child::before]:left-1.5 [&_.character-tree-child::before]:h-2 [&_.character-folder-empty]:pt-1 [&_.character-folder-empty]:pr-3 [&_.character-folder-empty]:pb-2 [&_.character-folder-empty]:pl-9.5 [&_.character-folder-empty]:text-muted [&_.character-folder-empty]:text-xs [&_.character-folder-empty]:italic small-touch:[&_.character-folder-action]:opacity-100 small-touch:[&_.character-folder-action]:visible small-touch:[&_.character-folder-action]:pointer-events-auto gap-[3px] [&_.character-folder]:gap-[3px] [&_.character-folder-row]:grid-cols-[minmax(0,_1fr)_30px_30px] [&_.character-tree-child::before]:top-[calc(50%_-_7px)] [&_.character-tree-child::before]:w-[7px]">
            <Show when={props.listActions} fallback={<NewButton />}>
              <div class="mb-2 flex gap-2 [&_button]:flex-1 [&_button]:flex [&_button]:items-center [&_button]:gap-2 [&_button]:justify-center [&_button]:whitespace-nowrap">
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
                  <span class="entity-list-label text-ellipsis flex items-center flex-1 min-w-0 gap-2 overflow-hidden">
                    {option().label}
                  </span>
                  <Show when={props.activeId === null}>
                    <EntityActiveBadge />
                  </Show>
                </button>
              )}
            </Show>
            <Show
              when={props.listContent}
              fallback={
                <For each={sortedItems()}>
                  {(item) => (
                    <button
                      classList={{
                        active: editor.selectedId() === item.id,
                        'in-use': props.activeId === item.id,
                      }}
                      onClick={() => editor.select(item.id)}
                    >
                      <span class="entity-list-label text-ellipsis flex items-center flex-1 min-w-0 gap-2 overflow-hidden">
                        {props.itemLabel(item)}
                      </span>
                      <Show when={props.activeId === item.id}>
                        <EntityActiveBadge />
                      </Show>
                    </button>
                  )}
                </For>
              }
            >
              {props.listContent}
            </Show>
          </div>
          <Show when={props.listFooter || props.transferType}>
            <div class="border-t border-t-solid border-t-subtle flex flex-none gap-1 flex-wrap p-2 pb-[max(var(--space-2),_env(safe-area-inset-bottom))]">
              {props.listFooter}
              <Show when={props.transferType}>
                {(type) => <EntityPageTransfer type={type()} onError={editor.setStatus} />}
              </Show>
            </div>
          </Show>
        </div>
        <div class="entity-detail flex flex-col min-w-0 min-h-0 [&>.form]:flex-1 [&>.form]:overflow-y-auto [&>.form]:min-h-0 [&>.form]:p-4">
          <SettingsActionsContext.Provider value={actionsTarget}>
            <div class="form [&_label]:text-label [&_label]:text-foreground [&_label]:mt-2">
              <button
                ref={(element) => registerUiBack(element, editor.nav.closeDetail)}
                class="display-none small-touch:flex small-touch:self-start small-touch:bg-clear small-touch:border-clear small-touch:py-1 small-touch:px-0 small-touch:text-accent small-touch:text-body-small"
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
                    <SettingsActions
                      save={props.readOnly ? undefined : editor.save}
                      discard={props.readOnly ? undefined : editor.discard}
                      saveLabel={editor.selectedId() === 'new' ? 'Create' : 'Save'}
                      saving={editor.saving()}
                      saved={editor.saved()}
                    >
                      {props.formActions}
                      <Show when={props.transferType}>
                        {(type) => (
                          <SettingsTransferButtons
                            type={`entity:${type()}`}
                            onError={editor.setStatus}
                            exportData={async () => {
                              return entityTransferData(type(), await exportDraft());
                            }}
                            importData={(data) =>
                              editor.importData(entityTransferData(type(), data), props.readOnly)
                            }
                          />
                        )}
                      </Show>
                      <Show when={editor.selectedId() !== 'new'}>
                        <button disabled={editor.saving()} onClick={editor.duplicate}>
                          Duplicate
                        </button>
                        {props.extraActions}
                        <Show when={!props.readOnly}>
                          <button
                            class="danger-btn"
                            disabled={editor.saving()}
                            onClick={() => void editor.remove()}
                          >
                            Delete
                          </button>
                        </Show>
                      </Show>
                    </SettingsActions>
                  </>
                }
              >
                {(option) => (
                  <>
                    <Show
                      when={props.defaultContent}
                      fallback={
                        <div class="max-w-120 m-auto p-6 text-center text-dim [&_h3]:text-foreground [&_h3]:text-subheading [&_h3]:m-0 [&_h3]:mb-2 [&_p]:m-0">
                          <h3>{option().label}</h3>
                          <p>{option().description}</p>
                        </div>
                      }
                    >
                      {props.defaultContent}
                    </Show>
                    <Show when={props.defaultActions}>
                      <SettingsActions>{props.defaultActions}</SettingsActions>
                    </Show>
                  </>
                )}
              </Show>
            </div>
            <div
              ref={setActionsTarget}
              class="settings-actions bg-canvas border-t border-t-solid border-t-subtle flex-none [&:empty]:display-none [&_.form-actions]:m-0"
              aria-label="Settings actions"
            />
          </SettingsActionsContext.Provider>
        </div>
        <Show when={editor.status()}>
          <p
            class="notice col-span-full m-0 max-h-32 overflow-y-auto"
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
    </SettingsDraftContext.Provider>
  );
}
