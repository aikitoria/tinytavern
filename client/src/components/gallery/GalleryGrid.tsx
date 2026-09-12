import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { faCheck, faImage, faPlay, faFilm } from '@fortawesome/free-solid-svg-icons';
import type { GalleryItem } from '@tinytavern/shared';
import { galleryRowAt, layoutGallery, layoutGalleryFolders, visibleGalleryRows } from '../../galleryModel.ts';
import type { GalleryCell, GalleryLayout, GalleryFolderGroup } from '../../galleryModel.ts';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';

const savedTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const durationSeconds = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function GalleryVideoPreview(props: { url: string; audible: boolean }) {
  let player!: HTMLVideoElement;
  const [playing, setPlaying] = createSignal(false);

  createEffect(() => {
    const audible = props.audible;
    let current = true;
    player.muted = !audible;
    void player.play().catch(() => {
      if (!current || !audible) return;
      // Hover may not grant audio permission. Keep the preview playing silently.
      player.muted = true;
      void player.play().catch(() => {
        // Leave the poster visible when playback is unavailable.
      });
    });
    onCleanup(() => {
      current = false;
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
      class="inset-0 block object-contain pointer-events-none opacity-0 size-full absolute [&.playing]:opacity-100 [&.playing~.gallery-video-badge]:opacity-0"
      classList={{ playing: playing() }}
      src={props.url}
      muted
      autoplay
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
  workflowName?: string;
  cell: GalleryCell;
  top: number;
  height: number;
  count: number;
  selected: boolean;
  selecting: boolean;
  tabStop: boolean;
  preview: boolean;
  onFocus: () => void;
  onClick: () => void;
  onInspect?: () => void;
  selectionNumber?: number;
}) {
  const [failed, setFailed] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  const video = () => props.cell.item.media?.kind === 'video';
  const kind = () => (video() ? 'video' : 'image');
  const summary = createMemo(() => {
    const item = props.cell.item;
    const width = item.media.width;
    const height = item.media.height;
    const duration = video() ? item.media?.duration : null;
    return [
      props.workflowName,
      width && height ? `${width}×${height}` : null,
      duration != null && duration > 0 ? `${durationSeconds.format(duration)}s` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  });
  const saved = createMemo(() => savedTime.format(props.cell.item.createdAt));
  createEffect(() => {
    props.cell.item.media?.thumbnail;
    setFailed(false);
  });
  return (
    <div
      class="gallery-tile overflow-hidden absolute bg-panel rounded-tight [&::after]:absolute [&::after]:inset-0 [&::after]:rounded-[inherit] [&::after]:pointer-events-none [&.selected::after]:border-2 [&.selected::after]:border-solid [&.selected::after]:border-accent [&:focus-within::after]:border-2 [&:focus-within::after]:border-solid [&:focus-within::after]:border-accent [&.selecting_.gallery-image-button]:cursor-pointer [&.selecting_.gallery-image-button:disabled]:opacity-45 [&.selecting_.gallery-image-button:disabled]:cursor-wait [&:hover_.gallery-tile-caption]:opacity-100 [&:focus-within_.gallery-tile-caption]:opacity-100 [&.selected_.gallery-selection-check]:border-accent [&.selected_.gallery-selection-check]:bg-accent"
      classList={{ selected: props.selected, selecting: props.selecting }}
      onPointerEnter={(event) => setHovered(event.pointerType !== 'touch')}
      onPointerLeave={() => setHovered(false)}
      onPointerCancel={() => setHovered(false)}
      role="listitem"
      style={{
        top: `${props.top}px`,
        height: `${props.height}px`,
        left: `${props.cell.left}px`,
        width: `${props.cell.width}px`,
      }}
    >
      <button
        type="button"
        class="gallery-image-button border-clear rounded-[inherit] cursor-zoom-in grid place-items-center size-full overflow-hidden relative p-0 text-muted bg-clear [&:hover:not(:disabled)]:bg-clear [&_img]:block [&_img]:object-contain [&_img]:size-full"
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
            width={props.cell.item.media.width ?? undefined}
            height={props.cell.item.media.height ?? undefined}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
          />
        </Show>
        <Show when={props.preview && video()}>
          <GalleryVideoPreview url={props.cell.item.media!.url} audible={hovered()} />
        </Show>
        <Show when={video()}>
          <span
            class="gallery-video-badge pl-0.5 rounded-circle text-white pointer-events-none grid place-items-center absolute size-9.5 top-1/2 left-1/2"
            title="Video"
            aria-hidden="true"
          >
            <FontAwesomeIcon icon={faPlay} size={18} />
          </span>
        </Show>
        <Show when={props.selecting}>
          <span
            class="gallery-selection-check top-2 left-2 rounded-circle text-white grid place-items-center absolute size-5.5"
            aria-hidden="true"
          >
            <Show when={props.selected}>
              <Show when={props.selectionNumber} fallback={<FontAwesomeIcon icon={faCheck} size={12} />}>
                {props.selectionNumber}
              </Show>
            </Show>
          </span>
        </Show>
        <span
          class="gallery-tile-caption bottom-0 left-0 right-0 text-white opacity-0 pointer-events-none absolute text-xs text-left p-2 pt-5"
          aria-hidden="true"
        >
          <Show when={props.cell.item.characterName}>
            <span class="block truncate font-semibold">{props.cell.item.characterName}</span>
          </Show>
          <Show when={summary()}>
            <span class="block truncate">{summary()}</span>
          </Show>
          <span class="block truncate text-white/70" classList={{ 'pr-20': Boolean(props.onInspect) }}>
            {saved()}
          </span>
        </span>
      </button>
      <Show when={props.onInspect}>
        <button class="right-2 bottom-2 absolute" onClick={props.onInspect} aria-label={`View ${kind()} details`}>
          Details
        </button>
      </Show>
    </div>
  );
}

export default function GalleryGrid(props: {
  items: GalleryItem[];
  groups?: GalleryFolderGroup[];
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
    stageOffset = stage.getBoundingClientRect().top - scrollRoot().getBoundingClientRect().top + scrollRoot().scrollTop;
  };
  const [width, setWidth] = createSignal(0);
  const [view, setView] = createSignal({ top: 0, height: 600 });
  const [documentVisible, setDocumentVisible] = createSignal(!document.hidden);
  const [focusedId, setFocusedId] = createSignal<number | null>(null);
  const layout = createMemo(() =>
    props.groups
      ? layoutGalleryFolders(props.groups, width(), props.targetHeight)
      : layoutGallery(props.items, width(), props.targetHeight),
  );
  const renderedHeadings = createMemo(() => {
    const headings = layout().headings;
    const { start, end } = visibleGalleryRows(headings, view().top, view().height);
    return headings.slice(start, end);
  });
  const range = createMemo(() => visibleGalleryRows(layout().rows, view().top, view().height), undefined, {
    equals: (a, b) => a.start === b.start && a.end === b.end,
  });
  const renderedRows = createMemo(() => {
    const current = layout();
    const { start, end } = range();
    const rows = current.rows.slice(start, end);
    const focused = focusedId();
    const focusRow = focused == null ? undefined : current.rowById.get(focused);
    // A wheel scroll must not unmount the currently focused button.
    if (focusRow !== undefined && (focusRow < start || focusRow >= end)) rows.push(current.rows[focusRow]!);
    return rows;
  });
  // Keep tiles mounted by gallery ID even when their row or position changes.
  const renderedCells = createMemo(
    () =>
      new Map(
        renderedRows().flatMap((row) =>
          row.cells.map((cell) => [cell.item.id, { cell, top: row.top, height: row.height }] as const),
        ),
      ),
  );
  const previewRows = createMemo(
    () => {
      const visible = new Set<number>();
      if (props.hidden || props.active === false || !documentVisible()) return visible;
      const { top, height } = view();
      for (const row of renderedRows()) {
        if (height > 0 && row.top < top + height && row.top + row.height > top) visible.add(row.top);
      }
      return visible;
    },
    undefined,
    { equals: (a, b) => a.size === b.size && [...a].every((top) => b.has(top)) },
  );
  const updateViewport = () => {
    frame = 0;
    if (!props.hidden && props.active !== false) {
      returnTop = scrollTop();
      setView({ top: returnTop, height: scrollRoot().clientHeight });
    }
  };
  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(updateViewport);
  };
  const focusButton = (id: number | null) => {
    const button = id == null ? null : stage.querySelector<HTMLButtonElement>(`[data-gallery-id="${id}"]`);
    (button ?? viewport).focus({ preventScroll: true });
  };
  onMount(() => {
    const onVisibilityChange = () => {
      setDocumentVisible(!document.hidden);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    onCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange));
    const mobile = window.matchMedia('(max-width: 767px), (pointer: coarse) and (max-width: 1024px)');
    const measure = () => {
      if (props.hidden || props.active === false) return;
      cancelAnimationFrame(frame);
      frame = 0;
      const nextHost = mobile.matches ? (viewport.closest<HTMLElement>('.gallery-modal') ?? viewport) : viewport;
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
        if (!previous || previous.width !== width || (entry.target !== stage && previous.height !== height)) {
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
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const current = layout();
    if (!current.rows.length) return;
    const id = Number((event.target as HTMLElement).closest<HTMLButtonElement>('[data-gallery-id]')?.dataset.galleryId);
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
          Math.abs(entry.left + entry.width / 2 - center) < Math.abs(best.left + best.width / 2 - center)
            ? entry
            : best,
        ).index;
      }
    }
    event.preventDefault();
    const next = props.items[Math.max(0, Math.min(props.items.length - 1, index))]!;
    const nextRow = current.rows[current.rowById.get(next.id)!]!;
    setFocusedId(next.id);
    if (nextRow.top < scrollTop() || nextRow.top + nextRow.height > scrollTop() + scrollRoot().clientHeight)
      setScrollTop(nextRow.top);
    updateViewport();
    cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => focusButton(next.id));
  };

  return (
    <div
      ref={viewport}
      class="gallery-browser-scroll flex-1 min-h-0 overflow-auto p-4 pt-3 mobile:overflow-visible mobile:py-2 mobile:px-3"
      classList={{ hidden: props.hidden }}
      tabIndex={-1}
      aria-label="Saved images and videos; use arrow keys to browse"
      onKeyDown={onKeyDown}
    >
      <div
        ref={stage}
        class="w-full relative"
        role="list"
        aria-label="Saved images and videos"
        style={{ height: `${layout().height}px` }}
      >
        <For each={renderedHeadings()}>
          {(heading) => (
            <div
              class="absolute inset-x-0 flex items-center gap-3 text-dim"
              style={{ top: `${heading.top}px`, height: `${heading.height}px` }}
            >
              <h3 class="m-0 text-sm font-semibold text-foreground truncate">{heading.name}</h3>
              <span class="text-xs tabular-nums">{heading.count}</span>
              <span class="flex-1 border-t border-t-solid border-t-line" />
            </div>
          )}
        </For>
        <For each={[...renderedCells().keys()]}>
          {(id) => {
            const position = () => renderedCells().get(id)!;
            const cell = () => position().cell;
            return (
              <GalleryTile
                workflowName={cell().item.workflowName ?? undefined}
                top={position().top}
                height={position().height}
                cell={cell()}
                preview={previewRows().has(position().top)}
                onInspect={
                  props.onInspect
                    ? () => {
                        returnTop = scrollTop();
                        returnId = id;
                        props.onInspect!(cell().item);
                      }
                    : undefined
                }
                selectionNumber={props.selectionOrder?.includes(id) ? props.selectionOrder.indexOf(id) + 1 : undefined}
                count={props.items.length}
                selected={props.selectedIds.has(id)}
                selecting={props.selecting}
                tabStop={focusedId() === id || (focusedId() == null && cell().index === 0)}
                onFocus={() => setFocusedId(id)}
                onClick={() => {
                  if (props.selecting) props.onToggle(id);
                  else {
                    returnTop = scrollTop();
                    returnId = id;
                    props.onOpen(cell().item);
                  }
                }}
              />
            );
          }}
        </For>
      </div>
    </div>
  );
}
