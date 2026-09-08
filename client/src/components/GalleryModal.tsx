import { useDialogPage } from '../state/dialogContext.ts';
import { readPageLocation, writePageLocation } from '../state/pageLocation.ts';
import {
  faArrowLeft,
  faBarsProgress,
  faChevronDown,
  faChevronLeft,
  faChevronRight,
  faCircleInfo,
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
import { mediaJobActive, type GalleryItem } from '@tinytavern/shared';
import { api } from '../state/api.ts';
import { applyGalleryItem, openModal, setState, state, toast } from '../state/store.ts';
import { confirmAction } from '../state/confirm.ts';
import { filterGallery, indexGallery } from '../galleryModel.ts';
import { errorMessage } from '../util.ts';
import {
  MEDIA_TOOL_LINKS,
  openMediaJobs,
  openMediaTool,
  restorePage,
} from '../media/navigation.ts';
import Avatar from './Avatar.tsx';
import DropdownSurface from './DropdownSurface.tsx';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import GalleryDetail from './GalleryDetail.tsx';
import GalleryGrid from './GalleryGrid.tsx';
import Modal from './Modal.tsx';
import Select from './Select.tsx';
import '../styles/gallery.css';

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
      <button
        ref={button}
        type="button"
        class="select-btn gallery-character-picker"
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
                state.characters.find((character) => character.id === current().id)?.avatarThumbnail
              }
              name={current().name}
            />
          )}
        </Show>
        <span class="gallery-character-label">{selected()?.name ?? 'All characters'}</span>
        <FontAwesomeIcon icon={faChevronDown} size={10} />
      </button>
      <DropdownSurface
        open={open()}
        anchor={() => button}
        onClose={() => setOpen(false)}
        class="gallery-character-menu"
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
          <span class="gallery-filter-count">{props.total}</span>
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
              <span class="gallery-filter-count">{option.count}</span>
            </button>
          )}
        </For>
      </DropdownSurface>
    </>
  );
}

export interface GalleryPickerOptions {
  maximum: number;
  selectedAssetIds: number[];
  onConfirm: (items: GalleryItem[]) => void;
  onCancel: () => void;
}

export default function GalleryModal(props: { picker?: GalleryPickerOptions; active?: boolean }) {
  const runningJobs = createMemo(
    () =>
      Object.values(state.mediaJobs).filter(
        (job) => job.operation !== 'image-describe' && mediaJobActive(job.state),
      ).length,
  );
  const galleryItems = () =>
    props.picker ? state.gallery.filter((item) => item.media?.kind === 'image') : state.gallery;
  const [pickedIds, setPickedIds] = createSignal<number[]>(
    (props.picker?.selectedAssetIds ?? []).flatMap((assetId) => {
      const item = state.gallery.find((entry) => entry.media?.id === assetId);
      return item ? [item.id] : [];
    }),
  );
  const pickedItems = () =>
    pickedIds().flatMap((id) => {
      const item = state.gallery.find((entry) => entry.id === id && entry.media?.kind === 'image');
      return item ? [item] : [];
    });
  const togglePicked = (id: number) => {
    const selected = pickedIds();
    if (selected.includes(id)) {
      setPickedIds(selected.filter((current) => current !== id));
    } else if (props.picker?.maximum === 1) {
      setPickedIds([id]);
    } else if (selected.length < (props.picker?.maximum ?? 0)) {
      setPickedIds([...selected, id]);
    } else {
      toast(`Choose up to ${props.picker?.maximum} images.`);
    }
  };
  const leave = () => (props.picker ? props.picker.onCancel() : openModal(null));
  const initialPage = props.picker ? null : useDialogPage()();
  const initialSize = Number(readPreference('size'));
  const [imageSize, setImageSize] = createSignal(
    initialSize >= 140 && initialSize <= 320 ? initialSize : 240,
  );
  const [showDetails, setShowDetails] = createSignal(readPreference('details') !== '0');
  const [query, setQuery] = createSignal(initialPage?.query ?? '');
  const [search, setSearch] = createSignal(initialPage?.query ?? '');
  const [characterKey, setCharacterKey] = createSignal(initialPage?.character ?? 'all');
  const [sort, setSort] = createSignal(
    (initialPage?.sort ?? readPreference('sort')) === 'oldest' ? 'oldest' : 'newest',
  );
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [toolsOpen, setToolsOpen] = createSignal(false);
  let toolsButton: HTMLButtonElement | undefined;
  const [selectedIds, setSelectedIds] = createSignal<ReadonlySet<number>>(new Set<number>());
  const [bulkDeleting, setBulkDeleting] = createSignal(false);
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
  const index = createMemo(() => indexGallery(galleryItems()));
  const filtered = createMemo(() =>
    filterGallery(index(), search(), characterKey(), sort() === 'oldest'),
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
    if (!files.length || uploadProgress() || bulkDeleting()) return;
    const character = characterOptions().find((option) => option.key === characterKey());
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
          const item = await api.uploadGalleryImage(file, character?.id ?? null, character?.name);
          applyGalleryItem(item);
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
    });
  };
  createEffect(() => {
    void search();
    void characterKey();
    setSelectedIds(new Set<number>());
  });
  createEffect(() => {
    if (
      characterKey() !== 'all' &&
      !characterOptions().some((option) => option.key === characterKey())
    )
      setCharacterKey('all');
  });

  const openDetail = (item: GalleryItem) => {
    const moveFocus =
      detailId() == null || document.activeElement?.closest('.gallery-detail-content');
    setToolsOpen(false);
    setDetailId(item.id);
    if (window.matchMedia('(max-width: 767px)').matches) {
      const modal = backButton?.closest<HTMLElement>('.gallery-modal');
      if (modal) modal.scrollTop = 0;
    }
    lastDetailIndex = filteredIndex().get(item.id) ?? 0;
    cancelAnimationFrame(focusFrame);
    if (moveFocus)
      focusFrame = requestAnimationFrame(() => backButton?.focus({ preventScroll: true }));
  };
  const closeDetail = () => {
    setDetailId(null);
    if (!filtered().length) queueMicrotask(() => searchInput?.focus({ preventScroll: true }));
  };
  const navigateDetail = (direction: number) => {
    const position = detailIndex();
    const next = position < 0 ? undefined : filtered()[position + direction];
    if (next) openDetail(next);
  };
  createEffect(() => {
    const id = detailId();
    if (id == null) return;
    if (byId().has(id)) lastDetailIndex = filteredIndex().get(id) ?? lastDetailIndex;
    else
      untrack(() => {
        const next = filtered()[Math.min(lastDetailIndex, filtered().length - 1)];
        if (next) openDetail(next);
        else closeDetail();
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
    if (bulkDeleting()) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const leaveSelection = () => {
    if (bulkDeleting()) return;
    batch(() => {
      setSelectedIds(new Set<number>());
      setSelectionMode(false);
    });
  };
  const deleteSelected = async () => {
    const items = selectedItems();
    if (!items.length || bulkDeleting()) return;
    if (
      !(await confirmAction({
        title: `Delete ${items.length} selected ${items.length === 1 ? 'item' : 'items'}?`,
        message: 'This permanently deletes the selected items and their prompts.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    const stillSelected = new Set(selectedItems().map((item) => item.id));
    if (items.some((item) => !stillSelected.has(item.id))) {
      toast('The selection changed. Review it before deleting.');
      return;
    }
    setBulkDeleting(true);
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
      setBulkDeleting(false);
    }
  };
  const deleteItem = async (item: GalleryItem) => {
    const kind = item.media?.kind === 'video' ? 'video' : 'image';
    if (
      !(await confirmAction({
        title: `Delete saved ${kind}?`,
        message: `This permanently deletes the saved ${kind} and prompt.`,
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteGalleryItem(item.id);
      setState('gallery', (items) => items.filter((candidate) => candidate.id !== item.id));
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  return (
    <Modal
      active={props.active}
      title={props.picker ? 'Choose reference images' : 'Gallery'}
      hideCloseButton
      fullscreen
      class={`gallery-modal ${selectionMode() ? 'gallery-selection-mode' : ''} ${detailItem() ? 'gallery-detail-mode' : ''}`}
      onClose={() => {
        if (bulkDeleting()) return;
        if (detailId() != null) closeDetail();
        else if (selectionMode()) leaveSelection();
        else leave();
      }}
      headerExtra={
        <div class="page-header-actions gallery-head-actions">
          <Show when={props.picker}>
            <button
              class="page-back"
              onClick={() => (detailId() === null ? leave() : closeDetail())}
            >
              <FontAwesomeIcon icon={faArrowLeft} size={13} /> Back
            </button>
            <span class="gallery-count">
              {pickedItems().length} / {props.picker!.maximum} selected
            </span>
            <Show when={detailItem()}>
              {(item) => (
                <button onClick={() => togglePicked(item().id)}>
                  {pickedIds().includes(item().id) ? 'Remove selection' : 'Select image'}
                </button>
              )}
            </Show>
            <button onClick={() => fileInput.click()} disabled={uploadProgress() !== null}>
              Upload
            </button>
            <button
              class="primary-btn"
              disabled={pickedItems().length === 0}
              onClick={() => props.picker!.onConfirm(pickedItems())}
            >
              Use selected
            </button>
            <button onClick={leave}>Cancel</button>
          </Show>
          <Show when={!props.picker}>
            <Show
              when={detailItem()}
              fallback={
                <Show
                  when={selectionMode()}
                  fallback={
                    <>
                      <button type="button" class="page-back gallery-back" onClick={leave}>
                        <FontAwesomeIcon icon={faArrowLeft} size={13} /> Back
                      </button>
                      <span class="gallery-count">
                        {filtered().length} {filtered().length === 1 ? 'image' : 'images'}
                      </span>
                      <button
                        type="button"
                        disabled={uploadProgress() != null}
                        onClick={() => fileInput.click()}
                      >
                        <FontAwesomeIcon icon={faUpload} size={14} /> Upload
                      </button>
                      <button
                        type="button"
                        disabled={!filtered().length}
                        onClick={() => setSelectionMode(true)}
                      >
                        <FontAwesomeIcon icon={faListCheck} size={14} /> Select
                      </button>
                    </>
                  }
                >
                  <span class="gallery-count" aria-live="polite">
                    {selectedItems().length} selected
                  </span>
                  <button
                    type="button"
                    disabled={bulkDeleting() || !filtered().length}
                    onClick={() =>
                      setSelectedIds(
                        allSelected()
                          ? new Set<number>()
                          : new Set(filtered().map((item) => item.id)),
                      )
                    }
                  >
                    {allSelected() ? 'Clear selection' : 'Select all'}
                  </button>
                  <button
                    type="button"
                    class="danger"
                    disabled={bulkDeleting() || !selectedItems().length}
                    onClick={() => void deleteSelected()}
                  >
                    <FontAwesomeIcon icon={faTrashCan} size={14} /> Delete
                  </button>
                  <button type="button" disabled={bulkDeleting()} onClick={leaveSelection}>
                    Done
                  </button>
                </Show>
              }
            >
              <button
                ref={backButton}
                type="button"
                class="page-back gallery-back"
                onClick={closeDetail}
              >
                <FontAwesomeIcon icon={faArrowLeft} size={13} /> Back
              </button>
              <span class="gallery-count">
                {detailIndex() >= 0 ? `${detailIndex() + 1} / ${filtered().length}` : 'Saved image'}
              </span>
              <div class="gallery-detail-nav">
                <button
                  type="button"
                  class="icon-btn"
                  aria-label="Previous gallery image"
                  title="Previous image"
                  disabled={detailIndex() <= 0}
                  onClick={() => navigateDetail(-1)}
                >
                  <FontAwesomeIcon icon={faChevronLeft} size={14} />
                </button>
                <button
                  type="button"
                  class="icon-btn"
                  aria-label="Next gallery image"
                  title="Next image"
                  disabled={detailIndex() < 0 || detailIndex() >= filtered().length - 1}
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
                <FontAwesomeIcon icon={faCircleInfo} size={14} /> Details
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
                <FontAwesomeIcon icon={faWrench} size={14} /> Tools
                <FontAwesomeIcon icon={faChevronDown} size={10} />
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
                <For each={MEDIA_TOOL_LINKS}>
                  {(tool) => (
                    <button
                      role="menuitem"
                      onClick={() => {
                        setToolsOpen(false);
                        openMediaTool(tool.operation);
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
                Jobs{runningJobs() ? ` (${runningJobs()})` : ''}
              </button>
            </Show>
          </Show>
        </div>
      }
    >
      <div
        class="gallery-workspace"
        onDragEnter={(event) => {
          if (!event.dataTransfer?.types.includes('Files')) return;
          event.preventDefault();
          dragDepth++;
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer?.types.includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = uploadProgress() || bulkDeleting() ? 'none' : 'copy';
        }}
        onDragLeave={() => {
          if (--dragDepth <= 0) {
            dragDepth = 0;
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          if (!event.dataTransfer?.types.includes('Files')) return;
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
          <div class="gallery-drop-overlay">
            <FontAwesomeIcon icon={faUpload} size={26} />
            <strong>
              {uploadProgress()
                ? 'Upload in progress'
                : bulkDeleting()
                  ? 'Deletion in progress'
                  : 'Drop images to upload'}
            </strong>
            <span>PNG, JPEG, WebP · Up to 64 MB each</span>
          </div>
        </Show>
        <Show when={uploadProgress()}>
          {(progress) => (
            <div class="gallery-upload-progress" role="status">
              <FontAwesomeIcon icon={faSpinner} size={12} class="spinner" />
              Uploading {progress().done} / {progress().total}
            </div>
          )}
        </Show>
        <div class="gallery-toolbar" classList={{ hidden: detailItem() != null }}>
          <div class="gallery-search">
            <FontAwesomeIcon icon={faMagnifyingGlass} size={14} />
            <input
              ref={searchInput}
              data-modal-initial-focus
              type="search"
              aria-label="Search gallery prompts"
              placeholder="Search prompts…"
              value={query()}
              disabled={bulkDeleting()}
              onInput={(event) => updateQuery(event.currentTarget.value)}
            />
          </div>
          <CharacterPicker
            options={characterOptions()}
            value={characterKey()}
            total={galleryItems().length}
            disabled={bulkDeleting()}
            onChange={setCharacterKey}
          />
          <Select
            class="gallery-sort"
            ariaLabel="Sort gallery"
            value={sort()}
            disabled={bulkDeleting()}
            options={[
              { value: 'newest', label: 'Newest first' },
              { value: 'oldest', label: 'Oldest first' },
            ]}
            onChange={(value) => {
              setSort(value);
              savePreference('sort', value);
            }}
          />
          <label class="gallery-size-control">
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
        </div>
        <GalleryGrid
          items={filtered()}
          targetHeight={imageSize()}
          resetKey={JSON.stringify([search(), characterKey(), sort()])}
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
          <div class="gallery-empty">
            <FontAwesomeIcon icon={faImages} size={34} />
            <strong>{state.gallery.length ? 'No matching images' : 'No saved images yet'}</strong>
            <span>
              {state.gallery.length
                ? 'Try another prompt search or character.'
                : 'Upload images, drop them here, or save an image from chat.'}
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
            <div id="gallery-detail-content" class="gallery-detail-content">
              <GalleryDetail
                readOnly={props.picker !== undefined}
                active={props.active}
                item={byId().get(id)!}
                showDetails={showDetails()}
                onDelete={deleteItem}
                onOpenSource={(conversationId) => {
                  const page = { chatId: conversationId, modal: null };
                  writePageLocation(page, true);
                  restorePage(page);
                }}
              />
            </div>
          )}
        </Show>
      </div>
    </Modal>
  );
}
