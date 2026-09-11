import { useDialogNavigationGuard, useDialogPage } from '../../state/dialogContext.ts';
import {
  navigatePageWithGuards,
  readPageLocation,
  writePageLocation,
} from '../../state/pageLocation.ts';
import {
  faArrowLeft,
  faBarsProgress,
  faChevronDown,
  faChevronLeft,
  faChevronRight,
  faCircleInfo,
  faCheck,
  faCheckDouble,
  faSliders,
  faListCheck,
  faMagnifyingGlass,
  faSpinner,
  faUpload,
  faWrench,
} from '@fortawesome/free-solid-svg-icons';
import { faImages, faTrashCan } from '@fortawesome/free-regular-svg-icons';
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import type { GalleryItem } from '@tinytavern/shared';
import { api } from '../../state/api.ts';
import {
  activeMediaJobCount,
  galleryFoldersLoaded,
  openModal,
  setState,
  state,
  toast,
} from '../../state/store.ts';
import { confirmDelete } from '../../state/confirm.ts';
import {
  adjacentGalleryIndex,
  filterGallery,
  indexGallery,
  resolveGalleryFolder,
} from '../../galleryModel.ts';
import { errorMessage } from '../../util.ts';
import {
  mediaToolLinks,
  openMediaJobs,
  openMediaTool,
  restorePage,
} from '../../media/navigation.ts';
import Avatar from '../ui/Avatar.tsx';
import DropdownSurface from '../ui/DropdownSurface.tsx';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import GalleryDetail from './GalleryDetail.tsx';
import GalleryGrid from './GalleryGrid.tsx';
import Modal from '../ui/Modal.tsx';
import Select, { type SelectHandle } from '../ui/Select.tsx';
import ReferenceEditButton from '../ui/ReferenceEditButton.tsx';
import { editReferencedEntity } from '../../state/entityReferences.ts';
import { createSettingsNavigation, SettingsNavigationPrompt } from '../settings/SettingsGuard.tsx';
import { createFolderActions } from '../settings/FolderEntityList.tsx';

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(`tinytavern.gallery.${key}`);
  } catch {
    return null;
  }
}
function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(`tinytavern.gallery.${key}`, value);
  } catch {
    /* Optional browser preferences. */
  }
}

interface CharacterFilter {
  key: string;
  id: number | null;
  name: string;
  count: number;
}

function CharacterPicker(props: {
  options: CharacterFilter[];
  value: string;
  total: number;
  disabled: boolean;
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  const selected = () => props.options.find((option) => option.key === props.value);
  const pick = (value: string) => {
    props.onChange(value);
    setOpen(false);
    button.focus({ preventScroll: true });
  };
  return (
    <>
      <div class="select-control">
        <button
          ref={button}
          type="button"
          class="select-btn [&_.avatar]:shrink-0 [&_.avatar]:text-tiny [&_.avatar]:w-5 [&_.avatar]:h-5"
          aria-label="Filter gallery by character"
          aria-haspopup="menu"
          aria-expanded={open()}
          disabled={props.disabled}
          onClick={() => setOpen(!open())}
        >
          <Show when={selected()} fallback={<FontAwesomeIcon icon={faImages} size={15} />}>
            {(current) => (
              <Avatar
                src={
                  state.characters.find((character) => character.id === current().id)
                    ?.avatarThumbnail
                }
                name={current().name}
              />
            )}
          </Show>
          <span class="select-label flex-1 min-w-0 text-left truncate">
            {selected()?.name ?? 'All characters'}
          </span>
          <FontAwesomeIcon icon={faChevronDown} size={10} />
        </button>
        <Show when={state.characters.find((character) => character.id === selected()?.id)}>
          {(character) => (
            <ReferenceEditButton
              label={character().name}
              onClick={() => {
                setOpen(false);
                editReferencedEntity('characters', character().id);
              }}
            />
          )}
        </Show>
      </div>
      <DropdownSurface
        open={open()}
        anchor={() => button}
        onClose={() => setOpen(false)}
        class="[&_.avatar]:shrink-0 [&_.avatar]:text-tiny [&_.avatar]:size-5.5"
        role="menu"
        ariaLabel="Gallery character filter"
        matchAnchorWidth
        minWidth={230}
        maxHeight={360}
        keyboardNavigation
        autoFocus
      >
        <button
          type="button"
          role="menuitemradio"
          aria-checked={props.value === 'all'}
          onClick={() => pick('all')}
        >
          <FontAwesomeIcon icon={faImages} size={16} /> <span>All characters</span>
          <span class="ml-auto text-muted text-xs tabular-nums">{props.total}</span>
        </button>
        <For each={props.options}>
          {(option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={option.key === props.value}
              onClick={() => pick(option.key)}
            >
              <Avatar
                src={
                  state.characters.find((character) => character.id === option.id)?.avatarThumbnail
                }
                name={option.name}
              />
              <span>{option.name}</span>
              <span class="ml-auto text-muted text-xs tabular-nums">{option.count}</span>
            </button>
          )}
        </For>
      </DropdownSurface>
    </>
  );
}

export interface GalleryPickerOptions {
  kind?: 'image' | 'video';
  maximum: number;
  selectedAssetIds: number[];
  onConfirm: (items: GalleryItem[]) => void;
  onCancel: () => void;
}

export default function GalleryModal(props: { picker?: GalleryPickerOptions; active?: boolean }) {
  const navigation = createSettingsNavigation();
  if (!props.picker) useDialogNavigationGuard(navigation.navigate);
  const galleryItems = () =>
    props.picker
      ? state.gallery.filter((item) => item.media?.kind === (props.picker?.kind ?? 'image'))
      : state.gallery;
  const pickerNoun = () => (props.picker?.kind === 'video' ? 'videos' : 'images');
  const [pickedIds, setPickedIds] = createSignal<number[]>(
    (props.picker?.selectedAssetIds ?? []).flatMap((assetId) => {
      const item = state.gallery.find((entry) => entry.media?.id === assetId);
      return item ? [item.id] : [];
    }),
  );
  const togglePicked = (id: number) => {
    const selected = pickedIds();
    if (selected.includes(id)) {
      setPickedIds(selected.filter((current) => current !== id));
    } else if (props.picker?.maximum === 1) {
      setPickedIds([id]);
    } else if (selected.length < (props.picker?.maximum ?? 0)) {
      setPickedIds([...selected, id]);
    } else {
      toast(`Choose up to ${props.picker?.maximum} ${pickerNoun()}.`);
    }
  };
  const leave = () =>
    navigation.navigate(() => (props.picker ? props.picker.onCancel() : openModal(null)));
  const initialPage = props.picker ? null : useDialogPage()();
  const initialSize = Number(readPreference('size'));
  const [imageSize, setImageSize] = createSignal(
    initialSize >= 140 && initialSize <= 320 ? initialSize : 240,
  );
  const [showDetails, setShowDetails] = createSignal(
    props.picker !== undefined || readPreference('details') !== '0',
  );
  const [query, setQuery] = createSignal(initialPage?.query ?? '');
  const [search, setSearch] = createSignal(initialPage?.query ?? '');
  const [characterKey, setCharacterKey] = createSignal(initialPage?.character ?? 'all');
  const [folderKey, setFolderKey] = createSignal(String(initialPage?.galleryFolder ?? 'all'));
  let folderSelect: SelectHandle | undefined;
  let moveSelect: SelectHandle | undefined;
  const folderId = () =>
    folderKey() === 'all' ? undefined : folderKey() === 'root' ? null : Number(folderKey());
  createEffect(() => {
    setFolderKey(resolveGalleryFolder(folderKey(), state.galleryFolders, galleryFoldersLoaded()));
  });
  const folders = createFolderActions({
    folders: () => state.galleryFolders,
    noun: 'images and videos',
    create: (name) => api.entityFolders.gallery.create({ name }),
    rename: (id, name) => api.entityFolders.gallery.patch(id, { name }),
    remove: async (id) => {
      await api.entityFolders.gallery.remove(id);
      if (folderKey() === String(id)) setFolderKey('root');
    },
    onError: (message) => toast(message),
  });
  const [sort, setSort] = createSignal(
    (initialPage?.sort ?? readPreference('sort')) === 'oldest' ? 'oldest' : 'newest',
  );
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [toolsOpen, setToolsOpen] = createSignal(false);
  const [optionsOpen, setOptionsOpen] = createSignal(false);
  let toolsButton: HTMLButtonElement | undefined;
  const [selectedIds, setSelectedIds] = createSignal<ReadonlySet<number>>(new Set<number>());
  const [bulkBusy, setBulkBusy] = createSignal(false);
  const [uploadProgress, setUploadProgress] = createSignal<{ done: number; total: number } | null>(
    null,
  );
  const [dragging, setDragging] = createSignal(false);
  const [detailId, setDetailId] = createSignal<number | null>(initialPage?.galleryId ?? null);
  createEffect(() => {
    if (props.picker || props.active === false || state.modal !== 'gallery') return;
    writePageLocation({
      chatId: state.selectedId,
      modal: 'gallery',
      viewMode: readPageLocation().viewMode,
      galleryId: detailId() ?? undefined,
      galleryFolder:
        folderKey() === 'all' ? undefined : folderKey() === 'root' ? 'root' : Number(folderKey()),
      query: search(),
      character: characterKey(),
      sort: sort(),
    });
  });
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let backButton: HTMLButtonElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let lastDetailIndex = 0;
  let focusFrame = 0;
  let fileInput!: HTMLInputElement;
  let dragDepth = 0;

  const byId = createMemo(() => new Map(galleryItems().map((item) => [item.id, item])));
  const pickedItems = createMemo(() =>
    pickedIds().flatMap((id) => {
      const item = byId().get(id);
      return item ? [item] : [];
    }),
  );
  createEffect(() => {
    const items = pickedItems();
    if (items.length !== pickedIds().length) setPickedIds(items.map((item) => item.id));
  });
  const index = createMemo(() => indexGallery(galleryItems()));
  const filtered = createMemo(() =>
    filterGallery(index(), search(), characterKey(), sort() === 'oldest', folderId()),
  );
  const filteredIndex = createMemo(
    () => new Map(filtered().map((item, index) => [item.id, index])),
  );
  const detailItem = () => (detailId() == null ? undefined : byId().get(detailId()!));
  const detailIndex = () => (detailId() == null ? -1 : (filteredIndex().get(detailId()!) ?? -1));
  const selectedItems = createMemo(() => filtered().filter((item) => selectedIds().has(item.id)));
  const allSelected = () => filtered().length > 0 && selectedItems().length === filtered().length;
  const characterOptions = createMemo(() => {
    const groups = new Map<string, CharacterFilter>();
    for (const item of galleryItems()) {
      const associations = item.characters.length
        ? item.characters
        : [{ id: null, name: item.characterName }];
      for (const character of associations) {
        const key = character.id === null ? `name:${character.name}` : `id:${character.id}`;
        const current = groups.get(key);
        if (current) current.count++;
        else groups.set(key, { key, id: character.id, name: character.name, count: 1 });
      }
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  const updateQuery = (value: string) => {
    setQuery(value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setSearch(value), 120);
  };
  const upload = async (files: File[]) => {
    if (!files.length || uploadProgress() || bulkBusy()) return;
    const character = characterOptions().find((option) => option.key === characterKey());
    const targetFolder = folderId();
    setUploadProgress({ done: 0, total: files.length });
    let cursor = 0;
    let done = 0;
    let saved = 0;
    const errors: string[] = [];
    const worker = async () => {
      while (cursor < files.length) {
        const file = files[cursor++]!;
        try {
          if (file.size > 64 * 1024 * 1024) throw new Error('maximum size is 64 MB');
          await api.uploadGalleryImage(file, character?.id ?? null, character?.name, targetFolder);
          saved++;
        } catch (err) {
          errors.push(`${file.name}: ${errorMessage(err)}`);
        }
        setUploadProgress({ done: ++done, total: files.length });
      }
    };
    await Promise.all([worker(), worker()]);
    setUploadProgress(null);
    if (saved) toast(`Uploaded ${saved} ${saved === 1 ? 'image' : 'images'}.`, 'success');
    if (errors.length) toast(`${errors.length} failed. ${errors.slice(0, 2).join('; ')}`);
  };
  const clearFilters = () => {
    clearTimeout(searchTimer);
    batch(() => {
      setQuery('');
      setSearch('');
      setCharacterKey('all');
      setFolderKey('all');
    });
  };
  createEffect(() => {
    void search();
    void characterKey();
    void folderKey();
    setSelectedIds(new Set<number>());
  });
  createEffect(() => {
    if (
      characterKey() !== 'all' &&
      !characterOptions().some((option) => option.key === characterKey())
    )
      setCharacterKey('all');
  });

  const showDetail = (item: GalleryItem) => {
    const moveFocus =
      detailId() == null || document.activeElement?.closest('.gallery-detail-content');
    setToolsOpen(false);
    setDetailId(item.id);
    if (
      window.matchMedia('(max-width: 767px), (pointer: coarse) and (max-width: 1024px)').matches
    ) {
      const modal = backButton?.closest<HTMLElement>('.gallery-modal');
      if (modal) modal.scrollTop = 0;
    }
    lastDetailIndex = filteredIndex().get(item.id) ?? 0;
    cancelAnimationFrame(focusFrame);
    if (moveFocus)
      focusFrame = requestAnimationFrame(() => backButton?.focus({ preventScroll: true }));
  };
  const hideDetail = () => {
    setDetailId(null);
    if (!filtered().length) queueMicrotask(() => searchInput?.focus({ preventScroll: true }));
  };
  const openDetail = (item: GalleryItem) => navigation.navigate(() => showDetail(item));
  const closeDetail = () => navigation.navigate(hideDetail);
  const detailNeighbor = (direction: number) =>
    filtered()[adjacentGalleryIndex(detailIndex(), lastDetailIndex, direction, filtered().length)];
  const navigateDetail = (direction: number) => {
    const next = detailNeighbor(direction);
    if (next) openDetail(next);
  };
  createEffect(() => {
    const id = detailId();
    if (id == null) return;
    if (byId().has(id)) lastDetailIndex = filteredIndex().get(id) ?? lastDetailIndex;
    else
      untrack(() => {
        navigation.cancel();
        const next = filtered()[Math.min(lastDetailIndex, filtered().length - 1)];
        if (next) showDetail(next);
        else hideDetail();
      });
  });

  const onKey = (event: KeyboardEvent) => {
    if (props.active === false) {
      return;
    }
    if (
      !detailItem() ||
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('input, textarea, select, [contenteditable], [role="menu"]')
    )
      return;
    const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    if (!dialogs[dialogs.length - 1]?.classList.contains('gallery-modal')) return;
    event.preventDefault();
    navigateDetail(event.key === 'ArrowLeft' ? -1 : 1);
  };
  onMount(() => document.addEventListener('keydown', onKey));
  onCleanup(() => {
    clearTimeout(searchTimer);
    cancelAnimationFrame(focusFrame);
    document.removeEventListener('keydown', onKey);
  });

  const toggleSelection = (id: number) => {
    if (bulkBusy()) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const leaveSelection = () => {
    if (bulkBusy()) return;
    batch(() => {
      setSelectedIds(new Set<number>());
      setSelectionMode(false);
    });
  };
  const deleteSelected = async (event: MouseEvent) => {
    const items = selectedItems();
    if (!items.length || bulkBusy()) return;
    if (
      !(await confirmDelete(
        {
          title: `Delete ${items.length} selected ${items.length === 1 ? 'item' : 'items'}?`,
          message: 'This permanently deletes the selected items and their prompts.',
          confirmLabel: 'Delete',
          danger: true,
        },
        event,
      ))
    )
      return;
    const stillSelected = new Set(selectedItems().map((item) => item.id));
    if (items.some((item) => !stillSelected.has(item.id))) {
      toast('The selection changed. Review it before deleting.');
      return;
    }
    setBulkBusy(true);
    try {
      const ids = items.map((item) => item.id);
      const result = await api.deleteGalleryItems(ids);
      const removed = new Set(ids);
      batch(() => {
        setState('gallery', (gallery) => gallery.filter((item) => !removed.has(item.id)));
        setSelectedIds(new Set<number>());
        setSelectionMode(false);
      });
      toast(
        `Deleted ${result.deleted} saved ${result.deleted === 1 ? 'item' : 'items'}.`,
        'success',
      );
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBulkBusy(false);
    }
  };
  const deleteItem = async (item: GalleryItem, event: MouseEvent) => {
    const kind = item.media?.kind === 'video' ? 'video' : 'image';
    if (
      !(await confirmDelete(
        {
          title: `Delete saved ${kind}?`,
          message: `This permanently deletes the saved ${kind} and prompt.`,
          confirmLabel: 'Delete',
          danger: true,
        },
        event,
      ))
    )
      return;
    try {
      await api.deleteGalleryItem(item.id);
      setState('gallery', (items) => items.filter((candidate) => candidate.id !== item.id));
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  const moveItems = async (value: string) => {
    const items = selectedItems();
    if (!value || !items.length || bulkBusy()) return;
    setBulkBusy(true);
    try {
      await api.moveGalleryItems(items, value === 'root' ? null : Number(value));
      setSelectedIds(new Set<number>());
      toast(`Moved ${items.length} ${items.length === 1 ? 'item' : 'items'}.`, 'success');
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBulkBusy(false);
      if (moveSelect) moveSelect.value = '';
    }
  };

  const FolderMoveSelect = () => (
    <Select
      ref={moveSelect}
      class="gallery-move-select min-w-0"
      ariaLabel="Move gallery items to folder"
      value=""
      buttonLabel="Move to folder…"
      disabled={bulkBusy() || !selectedItems().length}
      options={[
        { value: 'root', label: 'Unfiled' },
        ...folders.options().map(({ value, label }) => ({ value, label })),
      ]}
      onChange={(value) => void moveItems(value)}
    />
  );

  return (
    <>
      <Modal
        active={props.active}
        title={props.picker ? `Choose reference ${pickerNoun()}` : 'Gallery'}
        hideCloseButton
        fullscreen
        class={`gallery-modal small-touch:[&_.modal-head]:gap-2 small-touch:[&_.modal-title]:display-none ${selectionMode() ? 'gallery-selection-mode' : ''} ${detailItem() ? 'gallery-detail-mode' : ''}`}
        onClose={() => {
          if (bulkBusy()) return;
          if (detailId() != null) closeDetail();
          else if (selectionMode()) leaveSelection();
          else leave();
        }}
        headerStart={
          <Show when={props.picker || !selectionMode() || detailItem()}>
            <button
              ref={backButton}
              type="button"
              class="page-back icon-btn flex-none border-transparent bg-clear gallery-back"
              aria-label="Back"
              title="Back"
              onClick={() => (detailId() === null ? leave() : closeDetail())}
            >
              <FontAwesomeIcon icon={faArrowLeft} size={13} />
            </button>
          </Show>
        }
        headerExtra={
          <>
            <Show when={!detailItem()}>
              <div class="gallery-toolbar flex items-center gap-2 flex-1 min-w-0">
                <Select
                  ref={folderSelect}
                  class="gallery-folder-select min-w-0"
                  ariaLabel="Browse gallery folders"
                  value={folderKey()}
                  disabled={bulkBusy()}
                  options={[
                    { value: 'all', label: 'All media' },
                    { value: 'root', label: 'Unfiled' },
                    ...folders
                      .options()
                      .map((option) =>
                        props.picker ? { value: option.value, label: option.label } : option,
                      ),
                  ]}
                  onChange={(value) => {
                    if (folderSelect) folderSelect.value = folderKey();
                    navigation.navigate(() => {
                      setDetailId(null);
                      setFolderKey(value);
                    });
                  }}
                />
                <Show
                  when={!props.picker && selectionMode()}
                  fallback={
                    <div class="gallery-search flex items-center gap-2 min-w-0 pl-3 bg-canvas border border-solid border-control-line rounded-sm text-control [&:focus-within]:border-accent [&:focus-within]:-outline-offset-1 [&_input]:shadow-clear [&_input]:outline-clear [&_input]:text-sm [&_input]:leading-5 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-clear [&_input]:bg-clear [&_input]:p-1.5 [&_input]:pr-3 [&_input]:pl-0 [&_input:focus]:outline-clear flex-1">
                      <FontAwesomeIcon icon={faMagnifyingGlass} size={14} />
                      <input
                        ref={searchInput}
                        data-modal-initial-focus
                        type="search"
                        aria-label="Search gallery prompts"
                        placeholder="Search prompts…"
                        value={query()}
                        disabled={bulkBusy()}
                        onInput={(event) => updateQuery(event.currentTarget.value)}
                      />
                    </div>
                  }
                >
                  <FolderMoveSelect />
                </Show>
                <button
                  class="icon-btn shrink-0"
                  classList={{ 'icon-btn-active': characterKey() !== 'all' }}
                  title="Gallery options"
                  aria-label="Gallery options"
                  aria-haspopup="dialog"
                  onClick={() => setOptionsOpen(true)}
                >
                  <FontAwesomeIcon icon={faSliders} size={15} />
                </button>
              </div>
            </Show>
            <div class="gallery-header-actions flex items-center justify-end flex-none min-w-0 gap-2 [&>button]:inline-flex [&>button]:items-center [&>button]:justify-center [&>button]:gap-1 [&>button]:min-h-control [&>button]:h-control small:gap-1">
              <Show when={props.picker}>
                <span class="whitespace-nowrap text-dim text-caption tabular-nums">
                  {pickedItems().length} / {props.picker!.maximum}
                  <span class="gallery-action-label"> selected</span>
                </span>
                <Show when={detailItem()}>
                  {(item) => (
                    <button
                      aria-label={
                        pickedIds().includes(item().id)
                          ? 'Remove selection'
                          : `Select ${props.picker?.kind ?? 'image'}`
                      }
                      onClick={() => togglePicked(item().id)}
                    >
                      <FontAwesomeIcon icon={faCheck} size={14} />
                      <span class="gallery-action-label">
                        {pickedIds().includes(item().id) ? 'Deselect' : 'Select'}
                      </span>
                    </button>
                  )}
                </Show>
                <Show when={props.picker?.kind !== 'video'}>
                  <button
                    title="Upload images"
                    aria-label="Upload images"
                    onClick={() => fileInput.click()}
                    disabled={uploadProgress() !== null}
                  >
                    <FontAwesomeIcon
                      icon={uploadProgress() ? faSpinner : faUpload}
                      size={14}
                      class={uploadProgress() ? 'spinner' : ''}
                    />
                    <span class="gallery-action-label">Upload</span>
                  </button>
                </Show>
                <button
                  class="primary-btn"
                  disabled={pickedItems().length === 0}
                  onClick={() => props.picker!.onConfirm(pickedItems())}
                >
                  Use<span class="gallery-action-label"> selected</span>
                </button>
                <button class="gallery-picker-cancel" onClick={leave}>
                  Cancel
                </button>
              </Show>
              <Show when={!props.picker}>
                <Show
                  when={detailItem()}
                  fallback={
                    <Show
                      when={selectionMode()}
                      fallback={
                        <>
                          <span class="gallery-action-label whitespace-nowrap text-dim text-caption tabular-nums">
                            {filtered().length} {filtered().length === 1 ? 'image' : 'images'}
                          </span>
                          <button
                            type="button"
                            title="Upload images"
                            aria-label="Upload images"
                            disabled={uploadProgress() != null}
                            onClick={() => fileInput.click()}
                          >
                            <FontAwesomeIcon
                              icon={uploadProgress() ? faSpinner : faUpload}
                              size={14}
                              class={uploadProgress() ? 'spinner' : ''}
                            />
                            <span class="gallery-action-label">Upload</span>
                          </button>
                          <button
                            type="button"
                            title="Select gallery items"
                            aria-label="Select gallery items"
                            disabled={!filtered().length}
                            onClick={() => setSelectionMode(true)}
                          >
                            <FontAwesomeIcon icon={faListCheck} size={14} />
                            <span class="gallery-action-label">Select</span>
                          </button>
                        </>
                      }
                    >
                      <span
                        class="whitespace-nowrap text-dim text-caption tabular-nums"
                        aria-live="polite"
                      >
                        {selectedItems().length}
                        <span class="gallery-action-label"> selected</span>
                      </span>
                      <button
                        type="button"
                        title={allSelected() ? 'Clear selection' : 'Select all'}
                        aria-label={allSelected() ? 'Clear selection' : 'Select all'}
                        disabled={bulkBusy() || !filtered().length}
                        onClick={() =>
                          setSelectedIds(
                            allSelected()
                              ? new Set<number>()
                              : new Set(filtered().map((item) => item.id)),
                          )
                        }
                      >
                        <FontAwesomeIcon icon={faCheckDouble} size={14} />
                        <span class="gallery-action-label">
                          {allSelected() ? 'Clear selection' : 'Select all'}
                        </span>
                      </button>
                      <button
                        type="button"
                        class="danger"
                        title="Delete selected items"
                        aria-label="Delete selected items"
                        disabled={bulkBusy() || !selectedItems().length}
                        onClick={(event) => void deleteSelected(event)}
                      >
                        <FontAwesomeIcon icon={faTrashCan} size={14} />
                        <span class="gallery-action-label">Delete</span>
                      </button>
                      <button type="button" disabled={bulkBusy()} onClick={leaveSelection}>
                        Done
                      </button>
                    </Show>
                  }
                >
                  <span class="whitespace-nowrap text-dim text-caption tabular-nums">
                    {detailIndex() >= 0
                      ? `${detailIndex() + 1} / ${filtered().length}`
                      : 'Saved image'}
                  </span>
                  <div class="flex gap-1">
                    <button
                      type="button"
                      class="icon-btn"
                      aria-label="Previous gallery image"
                      title="Previous image"
                      disabled={!detailNeighbor(-1)}
                      onClick={() => navigateDetail(-1)}
                    >
                      <FontAwesomeIcon icon={faChevronLeft} size={14} />
                    </button>
                    <button
                      type="button"
                      class="icon-btn"
                      aria-label="Next gallery image"
                      title="Next image"
                      disabled={!detailNeighbor(1)}
                      onClick={() => navigateDetail(1)}
                    >
                      <FontAwesomeIcon icon={faChevronRight} size={14} />
                    </button>
                  </div>
                  <button
                    type="button"
                    class="gallery-details-toggle"
                    aria-label={showDetails() ? 'Hide image details' : 'Show image details'}
                    aria-expanded={showDetails()}
                    aria-controls="gallery-detail-panel"
                    onClick={() => {
                      const next = !showDetails();
                      setShowDetails(next);
                      savePreference('details', next ? '1' : '0');
                    }}
                  >
                    <FontAwesomeIcon icon={faCircleInfo} size={14} />
                    <span class="gallery-action-label">Details</span>
                  </button>
                </Show>
                <Show when={!selectionMode() && !detailItem()}>
                  <button
                    ref={toolsButton}
                    type="button"
                    aria-label="Media tools"
                    aria-haspopup="menu"
                    aria-expanded={toolsOpen()}
                    onClick={() => setToolsOpen(!toolsOpen())}
                  >
                    <FontAwesomeIcon icon={faWrench} size={14} />
                    <span class="gallery-action-label">Tools</span>
                  </button>
                  <DropdownSurface
                    open={toolsOpen()}
                    anchor={() => toolsButton}
                    onClose={() => setToolsOpen(false)}
                    role="menu"
                    ariaLabel="Media tools"
                    fitContentWidth
                    minWidth={160}
                    keyboardNavigation
                    autoFocus
                  >
                    <For each={mediaToolLinks()}>
                      {(tool) => (
                        <button
                          role="menuitem"
                          onClick={() => {
                            setToolsOpen(false);
                            openMediaTool(tool.workflowId, { galleryFolderId: folderId() ?? null });
                          }}
                        >
                          {tool.label}
                        </button>
                      )}
                    </For>
                  </DropdownSurface>
                </Show>
                <Show when={!selectionMode()}>
                  <button type="button" aria-label="Media jobs" onClick={openMediaJobs}>
                    <FontAwesomeIcon icon={faBarsProgress} size={14} />
                    <span class="gallery-action-label">
                      Jobs{activeMediaJobCount() ? ` (${activeMediaJobCount()})` : ''}
                    </span>
                  </button>
                </Show>
              </Show>
              <Show when={uploadProgress()}>
                {(progress) => (
                  <span class="sr-only" role="status">
                    Uploading {progress().done} / {progress().total}
                  </span>
                )}
              </Show>
            </div>
          </>
        }
      >
        <div
          class="gallery-workspace flex flex-col relative flex-1 min-h-0 mobile:block mobile:overflow-visible"
          onDragEnter={(event) => {
            if (!event.dataTransfer?.types.includes('Files')) return;
            if (props.picker?.kind === 'video') {
              event.preventDefault();
              return;
            }
            event.preventDefault();
            dragDepth++;
            setDragging(true);
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer?.types.includes('Files')) return;
            if (props.picker?.kind === 'video') {
              event.preventDefault();
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = uploadProgress() || bulkBusy() ? 'none' : 'copy';
          }}
          onDragLeave={() => {
            if (--dragDepth <= 0) {
              dragDepth = 0;
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            if (!event.dataTransfer?.types.includes('Files')) return;
            if (props.picker?.kind === 'video') {
              event.preventDefault();
              return;
            }
            event.preventDefault();
            dragDepth = 0;
            setDragging(false);
            void upload([...event.dataTransfer.files]);
          }}
        >
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = '';
              void upload(files);
            }}
          />
          <Show when={dragging()}>
            <div class="flex flex-col items-center justify-center gap-3 absolute inset-3 z-5 pointer-events-none bg-panel border-2 border-dashed border-accent text-foreground [&_span]:text-dim [&_span]:text-sm rounded-[var(--radius-md)]">
              <FontAwesomeIcon icon={faUpload} size={26} />
              <strong>
                {uploadProgress()
                  ? 'Upload in progress'
                  : bulkBusy()
                    ? 'Gallery update in progress'
                    : 'Drop images to upload'}
              </strong>
              <span>PNG, JPEG, WebP · Up to 64 MB each</span>
            </div>
          </Show>
          <GalleryGrid
            items={filtered()}
            targetHeight={imageSize()}
            resetKey={JSON.stringify([search(), characterKey(), sort(), folderKey()])}
            hidden={detailItem() != null || filtered().length === 0}
            active={props.active}
            selecting={props.picker !== undefined || selectionMode()}
            selectedIds={props.picker ? new Set(pickedIds()) : selectedIds()}
            onOpen={openDetail}
            onToggle={props.picker ? togglePicked : toggleSelection}
            onInspect={props.picker ? openDetail : undefined}
            selectionOrder={props.picker ? pickedIds() : undefined}
          />
          <Show when={!detailItem() && filtered().length === 0}>
            <div class="flex items-center justify-center flex-col gap-2 flex-1 p-4 text-dim text-center text-sm [&>svg]:mb-2 [&>svg]:text-muted [&_strong]:text-foreground [&_strong]:text-lg">
              <FontAwesomeIcon icon={faImages} size={34} />
              <strong>
                {state.gallery.length
                  ? `No matching ${props.picker ? pickerNoun() : 'media'}`
                  : 'No saved media yet'}
              </strong>
              <span>
                {state.gallery.length
                  ? 'Try another folder, prompt search or character.'
                  : props.picker?.kind === 'video'
                    ? 'Save a generated video to the gallery to select it here.'
                    : 'Upload images, drop them here, or save media from chat.'}
              </span>
              <Show when={state.gallery.length > 0}>
                <button type="button" onClick={clearFilters}>
                  Clear filters
                </button>
              </Show>
            </div>
          </Show>
          <Show when={detailItem() && detailId()} keyed>
            {(id) => (
              <div
                id="gallery-detail-content"
                class="gallery-detail-content flex flex-1 min-h-0 mobile:block"
              >
                <GalleryDetail
                  readOnly={props.picker !== undefined}
                  active={props.active}
                  item={byId().get(id)!}
                  showDetails={showDetails()}
                  register={navigation.register}
                  onDelete={deleteItem}
                  onOpenSource={(conversationId) => {
                    const page = { chatId: conversationId, modal: null };
                    navigatePageWithGuards(page, () => {
                      writePageLocation(page, true);
                      restorePage(page);
                    });
                  }}
                />
              </div>
            )}
          </Show>
        </div>
      </Modal>
      <Show when={optionsOpen()}>
        <Modal
          title="Gallery options"
          onClose={() => setOptionsOpen(false)}
          class="[&.modal]:h-auto [&.modal]:max-w-100 small-touch:[&.modal]:border small-touch:[&.modal]:border-solid small-touch:[&.modal]:border-line small-touch:[&.modal]:rounded-lg"
          backdropClass="small-touch:[&.modal-backdrop]:flex small-touch:[&.modal-backdrop]:items-center small-touch:[&.modal-backdrop]:justify-center small-touch:[&.modal-backdrop]:p-4"
        >
          <div class="flex flex-col gap-3">
            <CharacterPicker
              options={characterOptions()}
              value={characterKey()}
              total={galleryItems().length}
              disabled={bulkBusy()}
              onChange={setCharacterKey}
            />
            <Select
              class="w-full"
              ariaLabel="Sort gallery"
              value={sort()}
              disabled={bulkBusy()}
              options={[
                { value: 'newest', label: 'Newest first' },
                { value: 'oldest', label: 'Oldest first' },
              ]}
              onChange={(value) => {
                setSort(value);
                savePreference('sort', value);
              }}
            />
            <label class="flex items-center gap-2 text-dim text-xs whitespace-nowrap min-w-0 [&_input]:shadow-clear [&_input]:w-full [&_input]:min-w-0 [&_input]:h-6 [&_input]:p-0 [&_input]:border-clear [&_input]:bg-clear">
              Image size
              <input
                type="range"
                min={140}
                max={320}
                step={20}
                value={imageSize()}
                aria-label="Gallery image size"
                onInput={(event) => {
                  const value = Number(event.currentTarget.value);
                  setImageSize(value);
                  savePreference('size', String(value));
                }}
              />
            </label>
            <Show when={!props.picker}>
              <div class="flex gap-2 items-center border-t border-t-solid border-t-subtle pt-3">
                <folders.NewButton disabled={bulkBusy()} />
                <Show
                  when={state.galleryFolders.find((folder) => String(folder.id) === folderKey())}
                >
                  {(folder) => (
                    <button
                      class="icon-btn"
                      title="Delete folder"
                      aria-label={`Delete folder ${folder().name}`}
                      disabled={bulkBusy()}
                      onClick={(event) => void folders.remove(folder(), event)}
                    >
                      <FontAwesomeIcon icon={faTrashCan} size={14} />
                    </button>
                  )}
                </Show>
              </div>
            </Show>
          </div>
        </Modal>
      </Show>
      <folders.Dialog />
      <SettingsNavigationPrompt navigation={navigation}>
        You have unsaved gallery details. Save them before leaving this image?
      </SettingsNavigationPrompt>
    </>
  );
}
