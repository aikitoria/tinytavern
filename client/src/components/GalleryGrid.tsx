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
import { faCheck, faImage, faPlay, faFilm } from '@fortawesome/free-solid-svg-icons';
import type { GalleryItem } from '@tinytavern/shared';
import { galleryRowAt, layoutGallery, visibleGalleryRows } from '../galleryModel.ts';
import type { GalleryCell, GalleryLayout } from '../galleryModel.ts';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';

function GalleryVideoPreview(props: { url: string }) {
  let player!: HTMLVideoElement;
  const [playing, setPlaying] = createSignal(false);

  onMount(() => {
    player.muted = true;
    void player.play().catch(() => {
      // Leave the poster visible when playback is unavailable.
    });
  });
  onCleanup(() => {
    player.pause();
    player.removeAttribute('src');
    player.load();
  });

  return (
    <video
      ref={player}
      class="gallery-video-preview"
      classList={{ playing: playing() }}
      src={props.url}
      muted
      loop
      playsinline
      preload="none"
      aria-hidden="true"
      onPlaying={() => setPlaying(true)}
      onError={() => setPlaying(false)}
    />
  );
}

function GalleryTile(props: {
  cell: GalleryCell;
  count: number;
  selected: boolean;
  selecting: boolean;
  tabStop: boolean;
  preview: boolean;
  onPointerEnter: (event: PointerEvent) => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onClick: () => void;
  onInspect?: () => void;
  selectionNumber?: number;
}) {
  const [failed, setFailed] = createSignal(false);
  const video = () => props.cell.item.media?.kind === 'video';
  const kind = () => (video() ? 'video' : 'image');
  createEffect(() => {
    props.cell.item.media?.thumbnail;
    setFailed(false);
  });
  return (
    <div
      class="gallery-tile"
      classList={{ selected: props.selected, selecting: props.selecting }}
      role="listitem"
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
      style={{ left: `${props.cell.left}px`, width: `${props.cell.width}px` }}
    >
      <button
        type="button"
        class="gallery-image-button"
        data-gallery-id={props.cell.item.id}
        tabIndex={props.tabStop ? 0 : -1}
        aria-label={`${props.selecting ? (props.selected ? 'Deselect' : 'Select') : 'View'} ${kind()} ${props.cell.index + 1} of ${props.count}: ${props.cell.item.characterName}`}
        aria-pressed={props.selecting ? props.selected : undefined}
        title={props.cell.item.prompt.slice(0, 240)}
        onFocus={props.onFocus}
        onClick={props.onClick}
      >
        <Show
          when={!failed() && props.cell.item.media?.thumbnail}
          fallback={<FontAwesomeIcon icon={video() ? faFilm : faImage} size={24} />}
        >
          <img
            src={props.cell.item.media?.thumbnail!}
            alt={`${video() ? 'Video preview' : 'Saved image'} for ${props.cell.item.characterName}`}
            width={props.cell.item.imageWidth ?? undefined}
            height={props.cell.item.imageHeight ?? undefined}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
          />
        </Show>
        <Show when={props.preview && video()}>
          <GalleryVideoPreview url={props.cell.item.media!.url} />
        </Show>
        <Show when={video()}>
          <span class="gallery-video-badge" title="Video" aria-hidden="true">
            <FontAwesomeIcon icon={faPlay} size={18} />
          </span>
        </Show>
        <Show when={props.selecting}>
          <span class="gallery-selection-check" aria-hidden="true">
            <Show when={props.selected}>
              <Show
                when={props.selectionNumber}
                fallback={<FontAwesomeIcon icon={faCheck} size={12} />}
              >
                {props.selectionNumber}
              </Show>
            </Show>
          </span>
        </Show>
        <span class="gallery-tile-caption" aria-hidden="true">
          {props.cell.item.characterName}
        </span>
      </button>
      <Show when={props.onInspect}>
        <button
          class="gallery-inspect"
          onClick={props.onInspect}
          aria-label={`View ${kind()} details`}
        >
          Details
        </button>
      </Show>
    </div>
  );
}

export default function GalleryGrid(props: {
  items: GalleryItem[];
  targetHeight: number;
  resetKey: string;
  hidden: boolean;
  active?: boolean;
  selecting: boolean;
  selectedIds: ReadonlySet<number>;
  onOpen: (item: GalleryItem) => void;
  onToggle: (id: number) => void;
  onInspect?: (item: GalleryItem) => void;
  selectionOrder?: number[];
}) {
  let viewport!: HTMLDivElement;
  let stage!: HTMLDivElement;
  let frame = 0;
  let focusFrame = 0;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let returnTop = 0;
  let returnId: number | null = null;
  let previous: GalleryLayout | undefined;
  let previousKey = props.resetKey;
  let wasHidden = false;
  let layoutWasVisible = false;
  let scrollHost: HTMLElement | undefined;
  let stageOffset = 0;
  const scrollRoot = () => scrollHost ?? viewport;
  const scrollTop = () => scrollRoot().scrollTop - stageOffset;
  const setScrollTop = (top: number) => {
    scrollRoot().scrollTop = Math.max(0, top + stageOffset);
  };
  const measureOffset = () => {
    stageOffset =
      stage.getBoundingClientRect().top -
      scrollRoot().getBoundingClientRect().top +
      scrollRoot().scrollTop;
  };
  const [width, setWidth] = createSignal(0);
  const [view, setView] = createSignal({ top: 0, height: 600 });
  const [previewId, setPreviewId] = createSignal<number | null>(null);
  const stopPreview = () => {
    clearTimeout(previewTimer);
    previewTimer = undefined;
    setPreviewId(null);
  };
  const [focusedId, setFocusedId] = createSignal<number | null>(null);
  const layout = createMemo(() => layoutGallery(props.items, width(), props.targetHeight));
  const range = createMemo(
    () => visibleGalleryRows(layout().rows, view().top, view().height),
    undefined,
    { equals: (a, b) => a.start === b.start && a.end === b.end },
  );
  const renderedRows = createMemo(() => {
    const current = layout();
    const { start, end } = range();
    const rows = current.rows.slice(start, end);
    const focused = focusedId();
    const focusRow = focused == null ? undefined : current.rowById.get(focused);
    // A wheel scroll must not unmount the currently focused button.
    if (focusRow !== undefined && (focusRow < start || focusRow >= end))
      rows.push(current.rows[focusRow]!);
    return rows;
  });
  const updateViewport = () => {
    frame = 0;
    if (!props.hidden && props.active !== false) {
      returnTop = scrollTop();
      setView({ top: returnTop, height: scrollRoot().clientHeight });
    }
  };
  const onScroll = () => {
    stopPreview();
    if (!frame) frame = requestAnimationFrame(updateViewport);
  };
  const focusButton = (id: number | null) => {
    const button =
      id == null ? null : stage.querySelector<HTMLButtonElement>(`[data-gallery-id="${id}"]`);
    (button ?? viewport).focus({ preventScroll: true });
  };
  onMount(() => {
    const onVisibilityChange = () => {
      if (document.hidden) stopPreview();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    onCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange));
    const mobile = window.matchMedia('(max-width: 767px)');
    const measure = () => {
      if (props.hidden || props.active === false) return;
      cancelAnimationFrame(frame);
      frame = 0;
      const nextHost = mobile.matches
        ? (viewport.closest<HTMLElement>('.gallery-modal') ?? viewport)
        : viewport;
      if (nextHost !== scrollHost) {
        scrollHost?.removeEventListener('scroll', onScroll);
        scrollHost = nextHost;
        scrollHost.addEventListener('scroll', onScroll, { passive: true });
      }
      measureOffset();
      const measuredWidth = stage.clientWidth;
      // Read the viewport before publishing width, which updates row layout.
      const top = scrollTop();
      const height = scrollRoot().clientHeight;
      batch(() => {
        if (measuredWidth > 0) setWidth(measuredWidth);
        returnTop = top;
        setView({ top, height });
      });
    };
    const sizes = new WeakMap<Element, { width: number; height: number }>();
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const previous = sizes.get(entry.target);
        sizes.set(entry.target, { width, height });
        // Our own row layout changes the stage height; only its width is an input.
        if (
          !previous ||
          previous.width !== width ||
          (entry.target !== stage && previous.height !== height)
        ) {
          changed = true;
        }
      }
      if (changed) measure();
    });
    observer.observe(viewport);
    observer.observe(stage);
    observer.observe(viewport.closest('.gallery-modal') ?? viewport);
    mobile.addEventListener('change', measure);
    createEffect(() => {
      if (!props.hidden && props.active !== false) untrack(measure);
      else {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    });
    onCleanup(() => {
      observer.disconnect();
      scrollHost?.removeEventListener('scroll', onScroll);
      mobile.removeEventListener('change', measure);
    });
  });
  onCleanup(() => {
    cancelAnimationFrame(frame);
    cancelAnimationFrame(focusFrame);
    clearTimeout(previewTimer);
  });

  createEffect(() => {
    if (props.hidden || props.active === false) stopPreview();
  });

  createEffect(() => {
    const next = layout();
    const key = props.resetKey;
    const visible = !props.hidden && props.active !== false;
    untrack(() => {
      if (focusedId() != null && !next.rowById.has(focusedId()!)) setFocusedId(null);
      // Hidden scroll containers can report zero; restore the retained anchor on reveal.
      let top = visible && layoutWasVisible ? scrollTop() : returnTop;
      layoutWasVisible = visible;
      if (key !== previousKey) {
        top = -stageOffset;
        setFocusedId(null);
      } else if (previous && top > 0) {
        const row = previous.rows[galleryRowAt(previous.rows, top)];
        const anchor = row?.cells[0]?.item.id;
        const nextIndex = anchor == null ? undefined : next.rowById.get(anchor);
        if (row && nextIndex !== undefined) top = next.rows[nextIndex]!.top + top - row.top;
      }
      previous = next;
      previousKey = key;
      returnTop = top;
      if (visible) {
        setScrollTop(top);
        updateViewport();
      }
    });
  });

  createEffect(() => {
    const hidden = props.hidden;
    if (hidden && !wasHidden && scrollRoot() !== viewport) scrollRoot().scrollTop = 0;
    if (!hidden && wasHidden) {
      const top = returnTop;
      focusFrame = requestAnimationFrame(() => {
        measureOffset();
        setScrollTop(top);
        updateViewport();
        focusButton(returnId);
      });
    }
    wasHidden = hidden;
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
      return;
    const current = layout();
    if (!current.rows.length) return;
    const id = Number(
      (event.target as HTMLElement).closest<HTMLButtonElement>('[data-gallery-id]')?.dataset
        .galleryId,
    );
    const rowIndex = current.rowById.get(id) ?? 0;
    const row = current.rows[rowIndex]!;
    const cell = row.cells.find((entry) => entry.item.id === id) ?? row.cells[0]!;
    let index = cell.index;
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = props.items.length - 1;
    else if (event.key === 'ArrowLeft') index--;
    else if (event.key === 'ArrowRight') index++;
    else {
      const neighbor = current.rows[rowIndex + (event.key === 'ArrowUp' ? -1 : 1)];
      if (neighbor) {
        const center = cell.left + cell.width / 2;
        index = neighbor.cells.reduce((best, entry) =>
          Math.abs(entry.left + entry.width / 2 - center) <
          Math.abs(best.left + best.width / 2 - center)
            ? entry
            : best,
        ).index;
      }
    }
    event.preventDefault();
    const next = props.items[Math.max(0, Math.min(props.items.length - 1, index))]!;
    const nextRow = current.rows[current.rowById.get(next.id)!]!;
    setFocusedId(next.id);
    if (
      nextRow.top < scrollTop() ||
      nextRow.top + nextRow.height > scrollTop() + scrollRoot().clientHeight
    )
      setScrollTop(nextRow.top);
    updateViewport();
    cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => focusButton(next.id));
  };

  return (
    <div
      ref={viewport}
      class="gallery-browser-scroll"
      classList={{ hidden: props.hidden }}
      tabIndex={-1}
      aria-label="Saved images and videos; use arrow keys to browse"
      onKeyDown={onKeyDown}
    >
      <div
        ref={stage}
        class="gallery-rows"
        role="list"
        aria-label="Saved images and videos"
        style={{ height: `${layout().height}px` }}
      >
        <For each={renderedRows()}>
          {(row) => (
            <div
              class="gallery-row"
              role="presentation"
              style={{ top: `${row.top}px`, height: `${row.height}px` }}
            >
              <For each={row.cells}>
                {(cell) => (
                  <GalleryTile
                    onInspect={
                      props.onInspect
                        ? () => {
                            returnTop = scrollTop();
                            returnId = cell.item.id;
                            stopPreview();
                            props.onInspect!(cell.item);
                          }
                        : undefined
                    }
                    selectionNumber={
                      props.selectionOrder?.includes(cell.item.id)
                        ? props.selectionOrder.indexOf(cell.item.id) + 1
                        : undefined
                    }
                    cell={cell}
                    preview={previewId() === cell.item.id}
                    onPointerEnter={(event) => {
                      stopPreview();
                      if (
                        cell.item.media?.kind === 'video' &&
                        event.pointerType !== 'touch' &&
                        event.buttons === 0 &&
                        !document.hidden &&
                        !props.hidden &&
                        props.active !== false
                      ) {
                        previewTimer = setTimeout(() => {
                          previewTimer = undefined;
                          setPreviewId(cell.item.id);
                        }, 500);
                      }
                    }}
                    onPointerLeave={stopPreview}
                    count={props.items.length}
                    selected={props.selectedIds.has(cell.item.id)}
                    selecting={props.selecting}
                    tabStop={
                      focusedId() === cell.item.id || (focusedId() == null && cell.index === 0)
                    }
                    onFocus={() => setFocusedId(cell.item.id)}
                    onClick={() => {
                      stopPreview();
                      if (props.selecting) props.onToggle(cell.item.id);
                      else {
                        returnTop = scrollTop();
                        returnId = cell.item.id;
                        props.onOpen(cell.item);
                      }
                    }}
                  />
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
