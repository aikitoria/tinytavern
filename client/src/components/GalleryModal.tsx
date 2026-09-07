import {
  faArrowLeft,
  faChevronDown,
  faChevronLeft,
  faChevronRight,
  faCircleInfo,
  faListCheck,
  faMagnifyingGlass,
  faSpinner,
  faUpload,
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
import { createStore } from 'solid-js/store';
import type { GalleryItem } from '@tinytavern/shared';
import { api } from '../state/api.ts';
import {
  applyGalleryItem,
  openModal,
  selectConversation,
  setState,
  state,
  toast,
} from '../state/store.ts';
import type { GalleryRenderState } from '../state/store.ts';
import { confirmAction } from '../state/confirm.ts';
import { filterGallery, galleryCharacterKey, indexGallery } from '../galleryModel.ts';
import { errorMessage } from '../util.ts';
import { activeImageRenderConfig } from '../images/imageGeneration.tsx';
import SamplerProgress from '../images/SamplerProgress.tsx';
import Avatar from './Avatar.tsx';
import DropdownSurface from './DropdownSurface.tsx';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import GalleryDetail from './GalleryDetail.tsx';
import type { GalleryDraft } from './GalleryDetail.tsx';
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
              src={state.characters.find((character) => character.id === current().id)?.avatar}
              name={current().name}
            />
          )}
        </Show>
        <span>{selected()?.name ?? 'All characters'}</span>
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
                src={state.characters.find((character) => character.id === option.id)?.avatar}
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

export default function GalleryModal() {
  const initialSize = Number(readPreference('size'));
  const [imageSize, setImageSize] = createSignal(
    initialSize >= 140 && initialSize <= 320 ? initialSize : 240,
  );
  const [showDetails, setShowDetails] = createSignal(readPreference('details') !== '0');
  const [query, setQuery] = createSignal('');
  const [search, setSearch] = createSignal('');
  const [characterKey, setCharacterKey] = createSignal('all');
  const [sort, setSort] = createSignal(readPreference('sort') === 'oldest' ? 'oldest' : 'newest');
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [selectedIds, setSelectedIds] = createSignal<ReadonlySet<number>>(new Set<number>());
  const [bulkDeleting, setBulkDeleting] = createSignal(false);
  const [uploadProgress, setUploadProgress] = createSignal<{ done: number; total: number } | null>(
    null,
  );
  const [dragging, setDragging] = createSignal(false);
  const [detailId, setDetailId] = createSignal<number | null>(null);
  const [drafts, setDrafts] = createStore<Record<number, GalleryDraft>>({});
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let backButton: HTMLButtonElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let lastDetailIndex = 0;
  let focusFrame = 0;
  let fileInput!: HTMLInputElement;
  let dragDepth = 0;
  let disposed = false;

  const byId = createMemo(() => new Map(state.gallery.map((item) => [item.id, item])));
  const index = createMemo(() => indexGallery(state.gallery));
  const filtered = createMemo(() =>
    filterGallery(index(), search(), characterKey(), sort() === 'oldest'),
  );
  const filteredIndex = createMemo(
    () => new Map(filtered().map((item, index) => [item.id, index])),
  );
  const detailItem = () => (detailId() == null ? undefined : byId().get(detailId()!));
  const detailIndex = () => (detailId() == null ? -1 : (filteredIndex().get(detailId()!) ?? -1));
  const renderingSourceIds = createMemo(
    () => new Set(state.galleryRenders.map((render) => render.sourceItemId)),
  );
  const selectableItems = createMemo(() =>
    filtered().filter((item) => !renderingSourceIds().has(item.id)),
  );
  const selectedItems = createMemo(() =>
    selectableItems().filter((item) => selectedIds().has(item.id)),
  );
  const allSelected = () =>
    selectableItems().length > 0 && selectedItems().length === selectableItems().length;
  const characterOptions = createMemo(() => {
    const groups = new Map<string, CharacterFilter>();
    for (const item of state.gallery) {
      const key = galleryCharacterKey(item);
      const current = groups.get(key);
      if (current) current.count++;
      else groups.set(key, { key, id: item.characterId, name: item.characterName, count: 1 });
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
    if (!drafts[item.id]) setDrafts(item.id, { prompt: item.prompt, instruction: '' });
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
    disposed = true;
    clearTimeout(searchTimer);
    cancelAnimationFrame(focusFrame);
    document.removeEventListener('keydown', onKey);
  });

  const toggleSelection = (id: number) => {
    if (bulkDeleting() || renderingSourceIds().has(id)) return;
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
        title: `Delete ${items.length} selected ${items.length === 1 ? 'image' : 'images'}?`,
        message: 'This permanently deletes the selected saved images and their prompts.',
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
        `Deleted ${result.deleted} saved ${result.deleted === 1 ? 'image' : 'images'}.`,
        'success',
      );
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBulkDeleting(false);
    }
  };
  const deleteItem = async (item: GalleryItem) => {
    if (
      !(await confirmAction({
        title: 'Delete saved image?',
        message: 'This permanently deletes the saved image and prompt.',
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

  const removeRender = (jobId: string) =>
    setState('galleryRenders', (renders) => renders.filter((render) => render.jobId !== jobId));
  const updateRender = (jobId: string, patch: Partial<GalleryRenderState>) => {
    const index = state.galleryRenders.findIndex((render) => render.jobId === jobId);
    if (index >= 0) setState('galleryRenders', index, patch);
  };
  const generate = (source: GalleryItem, prompt: string) => {
    if (state.galleryRenders.some((render) => render.sourceItemId === source.id)) return;
    const jobId = crypto.randomUUID();
    const config = activeImageRenderConfig();
    const pending: GalleryRenderState = {
      jobId,
      sourceItemId: source.id,
      characterId: source.characterId,
      characterName: source.characterName,
      prompt,
    };
    setState('galleryRenders', (renders) => [pending, ...renders]);
    // Jobs live in the shared store and finish even when the gallery closes.
    void (async () => {
      const progressAbort = new AbortController();
      try {
        try {
          const stream = await api.openGalleryRenderProgress(
            jobId,
            (value, max) => updateRender(jobId, { value, max }),
            (preview) => updateRender(jobId, { preview }),
            progressAbort.signal,
          );
          void stream.done.catch(() => undefined);
        } catch (err) {
          console.warn('[gallery] progress stream unavailable:', err);
        }
        const created = await api.renderGalleryImage(source.id, jobId, prompt, config);
        batch(() => {
          applyGalleryItem(created);
          removeRender(jobId);
          if (!disposed && detailId() === source.id) openDetail(created);
        });
        toast('Variation saved to gallery.', 'success');
      } catch (err) {
        toast(errorMessage(err));
      } finally {
        progressAbort.abort();
        removeRender(jobId);
      }
    })();
  };

  return (
    <Modal
      title="Gallery"
      hideCloseButton
      fullscreen
      class={`gallery-modal ${selectionMode() ? 'gallery-selection-mode' : ''} ${detailItem() ? 'gallery-detail-mode' : ''}`}
      onClose={() => {
        if (bulkDeleting()) return;
        if (detailId() != null) closeDetail();
        else if (selectionMode()) leaveSelection();
        else openModal(null);
      }}
      headerExtra={
        <div class="page-header-actions gallery-head-actions">
          <Show
            when={detailItem()}
            fallback={
              <Show
                when={selectionMode()}
                fallback={
                  <>
                    <button
                      type="button"
                      class="page-back gallery-back"
                      onClick={() => openModal(null)}
                    >
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
                  disabled={bulkDeleting() || !selectableItems().length}
                  onClick={() =>
                    setSelectedIds(
                      allSelected()
                        ? new Set<number>()
                        : new Set(selectableItems().map((item) => item.id)),
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
            total={state.gallery.length}
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
        <Show when={state.galleryRenders.length > 0}>
          <section
            class="gallery-activity"
            classList={{ hidden: detailItem() != null }}
            aria-label="Gallery render activity"
          >
            <span class="gallery-activity-label">
              <FontAwesomeIcon icon={faSpinner} size={12} class="spinner" /> Rendering{' '}
              {state.galleryRenders.length}
            </span>
            <div class="gallery-activity-jobs">
              <For each={state.galleryRenders}>
                {(job) => (
                  <button
                    type="button"
                    class="gallery-activity-job"
                    disabled={!byId().has(job.sourceItemId)}
                    onClick={() => {
                      const source = byId().get(job.sourceItemId);
                      if (source) openDetail(source);
                    }}
                  >
                    <span class="gallery-activity-preview">
                      <Show
                        when={job.preview}
                        fallback={<FontAwesomeIcon icon={faImages} size={22} />}
                      >
                        <img src={job.preview} alt="Render preview" />
                      </Show>
                    </span>
                    <span class="gallery-activity-info">
                      <strong>{job.characterName}</strong>
                      <span class="gallery-render-status">
                        <SamplerProgress
                          progress={job}
                          stepsLabel="Step"
                          fallback={<span>Waiting for render…</span>}
                        />
                      </span>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </section>
        </Show>
        <GalleryGrid
          items={filtered()}
          targetHeight={imageSize()}
          resetKey={JSON.stringify([search(), characterKey(), sort()])}
          hidden={detailItem() != null || filtered().length === 0}
          selecting={selectionMode()}
          selectedIds={selectedIds()}
          blockedIds={renderingSourceIds()}
          onOpen={openDetail}
          onToggle={toggleSelection}
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
                item={byId().get(id)!}
                draft={drafts[id]!}
                showDetails={showDetails()}
                onDraft={(patch) => setDrafts(id, patch)}
                onGenerate={generate}
                onDelete={deleteItem}
                onOpenSource={(conversationId) => {
                  openModal(null);
                  selectConversation(conversationId);
                }}
              />
            </div>
          )}
        </Show>
      </div>
    </Modal>
  );
}
