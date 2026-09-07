import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import { faCheck, faImage } from '@fortawesome/free-solid-svg-icons';
import type { GalleryItem } from '@tinytavern/shared';
import { galleryRowAt, layoutGallery, visibleGalleryRows } from '../galleryModel.ts';
import type { GalleryCell, GalleryLayout } from '../galleryModel.ts';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';

function GalleryTile(props: {
  cell: GalleryCell;
  count: number;
  selected: boolean;
  selecting: boolean;
  disabled: boolean;
  tabStop: boolean;
  onFocus: () => void;
  onClick: () => void;
}) {
  const [failed, setFailed] = createSignal(false);
  return (
    <div
      class="gallery-tile"
      classList={{ selected: props.selected, selecting: props.selecting }}
      role="listitem"
      style={{ left: `${props.cell.left}px`, width: `${props.cell.width}px` }}
    >
      <button
        type="button"
        class="gallery-image-button"
        data-gallery-id={props.cell.item.id}
        tabIndex={props.tabStop ? 0 : -1}
        disabled={props.disabled}
        aria-label={`${props.selecting ? (props.selected ? 'Deselect' : 'Select') : 'View'} image ${props.cell.index + 1} of ${props.count}: ${props.cell.item.characterName}`}
        aria-pressed={props.selecting ? props.selected : undefined}
        title={props.cell.item.prompt.slice(0, 240)}
        onFocus={props.onFocus}
        onClick={props.onClick}
      >
        <Show when={!failed()} fallback={<FontAwesomeIcon icon={faImage} size={24} />}>
          <img
            src={props.cell.item.image}
            alt={`Saved image for ${props.cell.item.characterName}`}
            width={props.cell.item.imageWidth ?? undefined}
            height={props.cell.item.imageHeight ?? undefined}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
          />
        </Show>
        <Show when={props.selecting}>
          <span class="gallery-selection-check" aria-hidden="true">
            <Show when={props.selected}>
              <FontAwesomeIcon icon={faCheck} size={12} />
            </Show>
          </span>
        </Show>
        <span class="gallery-tile-caption" aria-hidden="true">
          {props.cell.item.characterName}
        </span>
      </button>
    </div>
  );
}

export default function GalleryGrid(props: {
  items: GalleryItem[];
  targetHeight: number;
  resetKey: string;
  hidden: boolean;
  selecting: boolean;
  selectedIds: ReadonlySet<number>;
  blockedIds: ReadonlySet<number>;
  onOpen: (item: GalleryItem) => void;
  onToggle: (id: number) => void;
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
    if (!props.hidden) {
      returnTop = scrollTop();
      setView({ top: returnTop, height: scrollRoot().clientHeight });
    }
  };
  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(updateViewport);
  };
  const focusButton = (id: number | null) => {
    const button =
      id == null ? null : stage.querySelector<HTMLButtonElement>(`[data-gallery-id="${id}"]`);
    (button ?? viewport).focus({ preventScroll: true });
  };
  onMount(() => {
    const mobile = window.matchMedia('(max-width: 767px)');
    const measure = () => {
      const nextHost = mobile.matches
        ? (viewport.closest<HTMLElement>('.gallery-modal') ?? viewport)
        : viewport;
      if (nextHost !== scrollHost) {
        scrollHost?.removeEventListener('scroll', onScroll);
        scrollHost = nextHost;
        scrollHost.addEventListener('scroll', onScroll, { passive: true });
      }
      if (props.hidden) return;
      measureOffset();
      if (stage.clientWidth > 0) setWidth(stage.clientWidth);
      updateViewport();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(stage);
    observer.observe(viewport.closest('.gallery-modal') ?? viewport);
    mobile.addEventListener('change', measure);
    measure();
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
    untrack(() => {
      if (focusedId() != null && !next.rowById.has(focusedId()!)) setFocusedId(null);
      let top = props.hidden ? returnTop : scrollTop();
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
      if (!props.hidden) {
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
      aria-label="Saved images; use arrow keys to browse"
      onKeyDown={onKeyDown}
    >
      <div
        ref={stage}
        class="gallery-rows"
        role="list"
        aria-label="Saved images"
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
                    cell={cell}
                    count={props.items.length}
                    selected={
                      props.selectedIds.has(cell.item.id) && !props.blockedIds.has(cell.item.id)
                    }
                    selecting={props.selecting}
                    disabled={props.selecting && props.blockedIds.has(cell.item.id)}
                    tabStop={
                      focusedId() === cell.item.id || (focusedId() == null && cell.index === 0)
                    }
                    onFocus={() => setFocusedId(cell.item.id)}
                    onClick={() => {
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
