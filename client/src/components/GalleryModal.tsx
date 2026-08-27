import { For, Show, batch, createEffect, createMemo, createSignal } from 'solid-js';
import type { GalleryItem } from '@minitavern/shared';
import { api } from '../state/api.ts';
import { applyGalleryItem, setState, state, toast } from '../state/store.ts';
import type { GalleryRenderState } from '../state/store.ts';
import { confirmAction } from '../state/confirm.ts';
import { errorMessage } from '../util.ts';
import { activeImageRenderConfig } from '../plugins/imageGeneration.tsx';
import Avatar from './Avatar.tsx';
import DropdownSurface from './DropdownSurface.tsx';
import GalleryIcon from './GalleryIcon.tsx';
import GallerySelectIcon, { GallerySelectAllIcon } from './GallerySelectIcon.tsx';
import GroupIcon from './GroupIcon.tsx';
import ImageViewer from './ImageViewer.tsx';
import Modal from './Modal.tsx';
import TrashIcon from './TrashIcon.tsx';

const GROUP_KEY = 'minitavern.galleryGroupByCharacter';

function initialGrouping(): boolean {
  try {
    return localStorage.getItem(GROUP_KEY) !== '0';
  } catch {
    return true;
  }
}

interface GalleryGroup {
  key: string;
  characterId: number | null;
  name: string;
  items: GalleryItem[];
  renders: GalleryRenderState[];
}

function GalleryPendingCard(props: { render: GalleryRenderState }) {
  const progress = () =>
    props.render.value !== undefined && props.render.max
      ? { value: props.render.value, max: props.render.max }
      : null;

  return (
    <article class="gallery-card gallery-pending-card" aria-label="Rendering new gallery image">
      <Show
        when={props.render.preview}
        fallback={
          <div class="gallery-pending-placeholder">
            <span class="spinner" />
          </div>
        }
      >
        {(preview) => <img src={preview()} alt="Gallery image rendering preview" />}
      </Show>
      <span class="gallery-pending-status">
        <span class="spinner" />
        <Show when={progress()} fallback={<span>Rendering…</span>}>
          {(current) => (
            <>
              <span class="img-progress">
                <span
                  class="img-progress-fill"
                  style={{ width: `${Math.round((current().value / current().max) * 100)}%` }}
                />
              </span>
              <span>
                {current().value}/{current().max}
              </span>
            </>
          )}
        </Show>
      </span>
    </article>
  );
}

function GalleryCard(props: {
  item: GalleryItem;
  onGenerate: (item: GalleryItem, prompt: string) => void;
  selectionMode: boolean;
  selected: boolean;
  selectable: boolean;
  onToggleSelection: (id: number) => void;
}) {
  const [mutating, setMutating] = createSignal(false);
  const [promptOpen, setPromptOpen] = createSignal(false);
  const [promptDraft, setPromptDraft] = createSignal(props.item.prompt);
  const [viewerOpen, setViewerOpen] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  let moreButton: HTMLButtonElement | undefined;
  const canGenerate = () => props.item.hasImageRender || activeImageRenderConfig() != null;
  const rendering = () =>
    state.galleryRenders.some((render) => render.sourceItemId === props.item.id);
  const busy = () => mutating() || rendering();

  createEffect(() => {
    if (props.selectionMode) setMenuOpen(false);
  });

  const openPromptForm = () => {
    if (busy()) return;
    setPromptDraft(props.item.prompt);
    setPromptOpen(true);
  };

  const generate = () => {
    const prompt = promptDraft().trim();
    if (!prompt || !canGenerate() || busy()) return;
    setPromptOpen(false);
    props.onGenerate(props.item, prompt);
  };

  const deleteItem = async () => {
    if (
      !(await confirmAction({
        title: 'Delete saved item?',
        message: 'This permanently deletes the saved image and prompt.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    ) {
      return;
    }
    if (busy()) return;
    setMutating(true);
    try {
      await api.deleteGalleryItem(props.item.id);
      setState('gallery', (items) => items.filter((item) => item.id !== props.item.id));
    } catch (err) {
      toast(errorMessage(err));
      setMutating(false);
    }
  };

  const copyPrompt = async (prompt = props.item.prompt) => {
    setMenuOpen(false);
    try {
      await navigator.clipboard.writeText(prompt);
      toast('Prompt copied.', 'success');
    } catch {
      toast('Could not copy the prompt.');
    }
  };

  return (
    <article
      class="gallery-card"
      classList={{
        'gallery-card-selecting': props.selectionMode,
        'gallery-card-selected': props.selected,
      }}
    >
      <button
        type="button"
        class="gallery-image-button"
        disabled={props.selectionMode && !props.selectable}
        aria-label={
          props.selectionMode
            ? `${props.selected ? 'Deselect' : 'Select'} saved image for ${props.item.characterName}`
            : `View saved image for ${props.item.characterName}`
        }
        aria-pressed={props.selectionMode ? props.selected : undefined}
        onClick={() =>
          props.selectionMode ? props.onToggleSelection(props.item.id) : setViewerOpen(true)
        }
      >
        <img src={props.item.image} alt={`Saved image for ${props.item.characterName}`} />
        <Show when={props.selectionMode}>
          <span
            class="gallery-selection-check"
            classList={{ selected: props.selected }}
            aria-hidden="true"
          >
            {props.selected ? '✓' : ''}
          </span>
        </Show>
      </button>

      <Show when={!props.selectionMode}>
        <span class="gallery-card-toolbar">
          <span class="msg-more-wrap">
            <button
              ref={moreButton}
              type="button"
              class="icon-btn"
              classList={{ 'icon-btn-active': menuOpen() }}
              title="More"
              aria-label="More saved image actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen()}
              onClick={() => setMenuOpen(!menuOpen())}
            >
              ⋯
            </button>
            <DropdownSurface
              open={menuOpen()}
              anchor={() => moreButton}
              onClose={() => setMenuOpen(false)}
              class="msg-more-menu"
              role="menu"
              ariaLabel="Saved image actions"
              placement="auto"
              align="end"
              fitContentWidth
              keyboardNavigation
              autoFocus
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  openPromptForm();
                }}
              >
                View / edit prompt
              </button>
              <button type="button" role="menuitem" onClick={() => void copyPrompt()}>
                Copy prompt
              </button>
              <div class="menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                disabled={busy()}
                onClick={() => {
                  setMenuOpen(false);
                  openPromptForm();
                }}
              >
                Generate image
              </button>
              <div class="menu-separator" role="separator" />
              <button
                type="button"
                class="danger"
                role="menuitem"
                disabled={busy()}
                onClick={() => {
                  setMenuOpen(false);
                  void deleteItem();
                }}
              >
                <TrashIcon /> Delete saved image
              </button>
            </DropdownSurface>
          </span>
        </span>
      </Show>

      <Show when={viewerOpen()}>
        <ImageViewer src={props.item.image} onClose={() => setViewerOpen(false)} />
      </Show>
      <Show when={promptOpen()}>
        <Modal
          title="Generate gallery image"
          class="gallery-prompt-modal"
          onClose={() => setPromptOpen(false)}
        >
          <form
            class="gallery-prompt-dialog form"
            onSubmit={(event) => {
              event.preventDefault();
              generate();
            }}
          >
            <label for={`gallery-prompt-${props.item.id}`}>Prompt</label>
            <textarea
              id={`gallery-prompt-${props.item.id}`}
              data-modal-initial-focus
              rows={8}
              value={promptDraft()}
              onInput={(event) => setPromptDraft(event.currentTarget.value)}
            />
            <p class="hint">
              Uses the active image workflow, or this image's saved workflow when none is active.
            </p>
            <Show when={!canGenerate()}>
              <p class="notice notice-error" role="alert">
                Select an image workflow in Settings → Tools → Image Generation first.
              </p>
            </Show>
            <div class="form-actions">
              <button
                type="submit"
                class="primary-btn"
                disabled={!promptDraft().trim() || !canGenerate() || busy()}
              >
                Generate image
              </button>
              <button type="button" onClick={() => void copyPrompt(promptDraft())}>
                Copy prompt
              </button>
              <button type="button" onClick={() => setPromptOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      </Show>
    </article>
  );
}

export default function GalleryModal() {
  const [grouped, setGrouped] = createSignal(initialGrouping());
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [selectedIds, setSelectedIds] = createSignal<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = createSignal(false);

  const renderingSourceIds = createMemo(
    () => new Set(state.galleryRenders.map((render) => render.sourceItemId)),
  );
  const selectableItems = createMemo(() =>
    state.gallery.filter((item) => !renderingSourceIds().has(item.id)),
  );
  const selectedItems = createMemo(() => {
    const selected = selectedIds();
    return selectableItems().filter((item) => selected.has(item.id));
  });
  const allSelected = createMemo(
    () => selectableItems().length > 0 && selectedItems().length === selectableItems().length,
  );

  const toggleSelection = (id: number) => {
    if (bulkDeleting() || renderingSourceIds().has(id)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const leaveSelectionMode = () => {
    if (bulkDeleting()) return;
    setSelectedIds(new Set<number>());
    setSelectionMode(false);
  };
  const toggleSelectAll = () => {
    if (bulkDeleting()) return;
    setSelectedIds(
      allSelected() ? new Set<number>() : new Set(selectableItems().map((item) => item.id)),
    );
  };
  const deleteSelected = async () => {
    const items = selectedItems();
    const count = items.length;
    if (
      count === 0 ||
      !(await confirmAction({
        title: `Delete ${count} selected ${count === 1 ? 'image' : 'images'}?`,
        message: `This permanently deletes the selected saved ${count === 1 ? 'image and its prompt' : 'images and their prompts'}.`,
        confirmLabel: 'Delete',
        danger: true,
      }))
    ) {
      return;
    }
    setBulkDeleting(true);
    const ids = items.map((item) => item.id);
    try {
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

  const removeRender = (jobId: string) =>
    setState('galleryRenders', (renders) => renders.filter((render) => render.jobId !== jobId));
  const updateRender = (jobId: string, patch: Partial<GalleryRenderState>) => {
    const index = state.galleryRenders.findIndex((render) => render.jobId === jobId);
    if (index >= 0) setState('galleryRenders', index, patch);
  };

  const generate = (source: GalleryItem, prompt: string) => {
    if (state.galleryRenders.some((render) => render.sourceItemId === source.id)) return;
    const jobId = crypto.randomUUID();
    const pending: GalleryRenderState = {
      jobId,
      sourceItemId: source.id,
      characterId: source.characterId,
      characterName: source.characterName,
      prompt,
    };
    setState('galleryRenders', (renders) => [pending, ...renders]);
    void (async () => {
      let completed = false;
      try {
        try {
          const stream = await api.openGalleryRenderProgress(
            jobId,
            (value, max) => updateRender(jobId, { value, max }),
            (preview) => updateRender(jobId, { preview }),
          );
          void stream.done.catch(() => undefined);
        } catch (err) {
          console.warn('[gallery] progress stream unavailable:', err);
        }
        const created = await api.renderGalleryImage(
          source.id,
          jobId,
          prompt,
          activeImageRenderConfig(),
        );
        batch(() => {
          applyGalleryItem(created);
          removeRender(jobId);
        });
        completed = true;
      } catch (err) {
        toast(errorMessage(err));
      } finally {
        if (!completed) removeRender(jobId);
      }
    })();
  };

  const groups = createMemo<GalleryGroup[]>(() => {
    if (!grouped()) {
      return [
        {
          key: 'all',
          characterId: null,
          name: '',
          items: [...state.gallery],
          renders: [...state.galleryRenders],
        },
      ];
    }
    const byKey = new Map<string, GalleryGroup>();
    const ensureGroup = (characterId: number | null, characterName: string) => {
      const key = characterId != null ? `id:${characterId}` : `name:${characterName}`;
      let group = byKey.get(key);
      if (!group) {
        const currentCharacter =
          characterId != null
            ? state.characters.find((character) => character.id === characterId)
            : undefined;
        group = {
          key,
          characterId,
          name: currentCharacter?.name ?? characterName,
          items: [],
          renders: [],
        };
        byKey.set(key, group);
      }
      return group;
    };
    for (const item of state.gallery) {
      ensureGroup(item.characterId, item.characterName).items.push(item);
    }
    for (const render of state.galleryRenders) {
      ensureGroup(render.characterId, render.characterName).renders.push(render);
    }
    return [...byKey.values()];
  });
  const toggleGrouping = () => {
    const next = !grouped();
    setGrouped(next);
    try {
      localStorage.setItem(GROUP_KEY, next ? '1' : '0');
    } catch {
      /* Storage may be unavailable in hardened/private browser contexts. */
    }
  };

  return (
    <Modal
      title="Gallery"
      class={`gallery-modal ${selectionMode() ? 'gallery-selection-mode' : ''}`}
      backdropClass="gallery-backdrop"
      headerExtra={
        <div class="gallery-modal-head-actions">
          <Show
            when={selectionMode()}
            fallback={
              <>
                <span class="gallery-count">{state.gallery.length} saved</span>
                <button
                  type="button"
                  class="icon-btn"
                  title="Select gallery images"
                  aria-label="Select gallery images"
                  disabled={state.gallery.length === 0}
                  onClick={() => setSelectionMode(true)}
                >
                  <GallerySelectIcon />
                </button>
                <button
                  class="icon-btn"
                  classList={{ 'icon-btn-active': grouped() }}
                  title="Group by character"
                  aria-label="Group gallery by character"
                  aria-pressed={grouped()}
                  onClick={toggleGrouping}
                >
                  <GroupIcon />
                </button>
              </>
            }
          >
            <span class="gallery-count">{selectedItems().length} selected</span>
            <button
              type="button"
              class="icon-btn"
              classList={{ 'icon-btn-active': allSelected() }}
              title={allSelected() ? 'Clear selection' : 'Select all'}
              aria-label={allSelected() ? 'Clear gallery selection' : 'Select all gallery images'}
              aria-pressed={allSelected()}
              disabled={bulkDeleting() || selectableItems().length === 0}
              onClick={toggleSelectAll}
            >
              <GallerySelectAllIcon checked={allSelected()} />
            </button>
            <button
              type="button"
              class="icon-btn gallery-delete-selected"
              title="Delete selected images"
              aria-label="Delete selected gallery images"
              disabled={bulkDeleting() || selectedItems().length === 0}
              onClick={() => void deleteSelected()}
            >
              <TrashIcon />
            </button>
            <button
              type="button"
              class="icon-btn icon-btn-active"
              title="Finish selecting"
              aria-label="Finish selecting gallery images"
              disabled={bulkDeleting()}
              onClick={leaveSelectionMode}
            >
              <GallerySelectIcon />
            </button>
          </Show>
        </div>
      }
    >
      <Show
        when={state.gallery.length > 0}
        fallback={
          <div class="gallery-empty">
            <GalleryIcon />
            <strong>No saved images yet</strong>
            <span>Save an image swipe from its message controls to keep it here.</span>
          </div>
        }
      >
        <div class="gallery-content">
          <For each={groups()}>
            {(group) => (
              <section class="gallery-group">
                <Show when={grouped()}>
                  <div class="gallery-group-head">
                    <Show
                      when={
                        group.characterId != null
                          ? state.characters.find((character) => character.id === group.characterId)
                          : undefined
                      }
                      fallback={<span class="avatar avatar-fallback">{group.name[0] ?? 'A'}</span>}
                    >
                      {(character) => <Avatar src={character().avatar} name={character().name} />}
                    </Show>
                    <span>{group.name}</span>
                    <span class="gallery-group-count">
                      {group.items.length + group.renders.length}
                    </span>
                  </div>
                </Show>
                <div class="gallery-grid">
                  <For each={group.renders}>
                    {(render) => <GalleryPendingCard render={render} />}
                  </For>
                  <For each={group.items}>
                    {(item) => (
                      <GalleryCard
                        item={item}
                        onGenerate={generate}
                        selectionMode={selectionMode()}
                        selected={selectedIds().has(item.id) && !renderingSourceIds().has(item.id)}
                        selectable={!renderingSourceIds().has(item.id)}
                        onToggleSelection={toggleSelection}
                      />
                    )}
                  </For>
                </div>
              </section>
            )}
          </For>
        </div>
      </Show>
    </Modal>
  );
}
