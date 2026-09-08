import { readPageLocation, writePageLocation } from '../state/pageLocation.ts';
import { faCrosshairs, faExpand, faMinus, faPlus } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from 'solid-js';
import type { Message } from '@tinytavern/shared';
import { api } from '../state/api.ts';
import { activePath, childrenByParent, navigateTree, setState, state } from '../state/store.ts';
import MessageNode from './MessageNode.tsx';
import { highlightMapSearch } from './mapSearchHighlight.ts';
import {
  snippet,
  mapSearchQuery,
  matchesMapSearch,
  setMapSearchResults,
  mapSearchTarget,
  setMapSearchTarget,
} from './mapSearch.ts';
import '../styles/treemap.css';

// Fixed card slots keep layout independent of content and zoom.
const CARD_W = 640;
const CARD_H = 240;
const COL_GAP = 60;
const ROW_GAP = 24;
const COL_W = CARD_W + COL_GAP;
const ROW_H = CARD_H + ROW_GAP;

const MIN_SCALE = 0.05;
const MAX_SCALE = 2;
/** fit() may zoom further out than manual zoom so huge trees stay overviewable. */
const FIT_MIN_SCALE = 0.02;
/** Below this zoom, cards render as constant-screen-size snippets. */
const MINI_SCALE = 0.45;

interface Pos {
  x: number;
  y: number;
}

/** World-coordinate bezier and culling bounds. */
interface Edge {
  x1: number;
  y1: number;
  c1x: number;
  c2x: number;
  x2: number;
  y2: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  onPath: boolean;
}

export default function TreeMap() {
  let root!: HTMLDivElement;
  let content!: HTMLDivElement;
  let edgesCanvas!: HTMLCanvasElement;

  // Mirror the mutable camera into `view` once per frame for culling and snippet swaps.
  let scale = 1;
  let x = 0;
  let y = 0;
  const [view, setView] = createSignal({ x: 0, y: 0, scale: 1 });
  const [viewport, setViewport] = createSignal({ w: 0, h: 0 });
  let rafId = 0;

  // Key positions by id to preserve message references and avoid remounting cards.
  const layout = createMemo(() => {
    const byParent = childrenByParent();
    const positions = new Map<number, Pos>();
    const ordered: Message[] = [];
    let w = 0;
    let h = 0;
    let row = 0;
    const walk = (message: Message, depth: number): number => {
      ordered.push(message);
      const kids = byParent.get(message.id) ?? [];
      let y: number;
      if (kids.length === 0) {
        y = row++ * ROW_H;
      } else {
        let sum = 0;
        for (const kid of kids) sum += walk(kid, depth + 1);
        y = sum / kids.length;
      }
      const x = depth * COL_W;
      positions.set(message.id, { x, y });
      w = Math.max(w, x + CARD_W);
      h = Math.max(h, y + CARD_H);
      return y;
    };
    for (const rootMsg of byParent.get(-1) ?? []) walk(rootMsg, 0);
    return { positions, ordered, bounds: { w, h } };
  });
  const positions = () => layout().positions;
  const ordered = () => layout().ordered;

  const searchMatches = createMemo<Set<number> | null>((previous) => {
    const query = mapSearchQuery().trim().toLowerCase();
    if (!query) return null;
    const matches = new Set(
      ordered()
        .filter((message) => matchesMapSearch(message, query))
        .map((message) => message.id),
    );
    // Token updates within an existing match must not reset the user's camera.
    return previous &&
      previous.size === matches.size &&
      [...matches].every((id) => previous.has(id))
      ? previous
      : matches;
  });

  const searchParent = createMemo(() => {
    const matches = searchMatches();
    if (!matches?.size) return null;
    let parent: number | null | undefined;
    for (const id of matches) {
      const current = state.tree.messages[id]?.parentId ?? null;
      if (current === null || (parent !== undefined && parent !== current)) return null;
      parent = current;
    }
    return parent ?? null;
  });

  createEffect(
    on([mapSearchQuery, searchMatches], ([query, matches], previous) => {
      setMapSearchResults(matches ? [...matches] : []);
      const target = mapSearchTarget();
      if (query !== previous?.[0] || (target && !matches?.has(target.messageId))) {
        setMapSearchTarget(null);
      }
    }),
  );

  const activeIds = createMemo(() => new Set(activePath().map((message) => message.id)));

  const edges = createMemo<Edge[]>(() => {
    const pos = positions();
    const onPath = activeIds();
    const out: Edge[] = [];
    for (const message of ordered()) {
      if (message.parentId == null) continue;
      const p = pos.get(message.parentId);
      const c = pos.get(message.id);
      if (!p || !c) continue;
      const x1 = p.x + CARD_W;
      const y1 = p.y + CARD_H / 2;
      const x2 = c.x;
      const y2 = c.y + CARD_H / 2;
      const dx = Math.max(24, (x2 - x1) / 2);
      out.push({
        x1,
        y1,
        c1x: x1 + dx,
        c2x: x2 - dx,
        x2,
        y2,
        minX: Math.min(x1, x2),
        minY: Math.min(y1, y2),
        maxX: Math.max(x1, x2),
        maxY: Math.max(y1, y2),
        onPath: onPath.has(message.id) && onPath.has(message.parentId),
      });
    }
    return out;
  });

  /** Visible rectangle in world coordinates. */
  const visibleRect = createMemo(() => {
    const v = view();
    const vp = viewport();
    if (!vp.w || !vp.h) return null;
    return {
      x0: -v.x / v.scale,
      y0: -v.y / v.scale,
      x1: (-v.x + vp.w) / v.scale,
      y1: (-v.y + vp.h) / v.scale,
    };
  });

  // Keep one viewport of overscan to cover movement between frames.
  const visibleMessages = createMemo<Message[]>(() => {
    const rect = visibleRect();
    if (!rect) return ordered();
    const pos = positions();
    const mx = rect.x1 - rect.x0;
    const my = rect.y1 - rect.y0;
    return ordered().filter((message) => {
      const p = pos.get(message.id);
      if (!p) return false;
      return (
        p.x + CARD_W >= rect.x0 - mx &&
        p.x <= rect.x1 + mx &&
        p.y + CARD_H >= rect.y0 - my &&
        p.y <= rect.y1 + my
      );
    });
  });

  const apply = () => {
    content.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    scheduleFrame();
  };

  // A viewport-sized canvas avoids GPU texture limits on large trees.
  const drawEdges = () => {
    const vp = viewport();
    if (!edgesCanvas || !vp.w || !vp.h) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(vp.w * dpr);
    const h = Math.round(vp.h * dpr);
    if (edgesCanvas.width !== w || edgesCanvas.height !== h) {
      edgesCanvas.width = w;
      edgesCanvas.height = h;
    }
    const ctx = edgesCanvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vp.w, vp.h);
    const computed = getComputedStyle(edgesCanvas);
    const border = computed.getPropertyValue('--border').trim() || '#3a3a3a';
    const accent = computed.getPropertyValue('--accent').trim() || '#e18a24';
    // Normal edges first, then the active path on top.
    for (const pass of [false, true]) {
      ctx.strokeStyle = pass ? accent : border;
      ctx.lineWidth = pass ? 2 : 1.5;
      ctx.beginPath();
      for (const e of edges()) {
        if (e.onPath !== pass) continue;
        if (
          e.maxX * scale + x < 0 ||
          e.minX * scale + x > vp.w ||
          e.maxY * scale + y < 0 ||
          e.minY * scale + y > vp.h
        ) {
          continue;
        }
        ctx.moveTo(e.x1 * scale + x, e.y1 * scale + y);
        ctx.bezierCurveTo(
          e.c1x * scale + x,
          e.y1 * scale + y,
          e.c2x * scale + x,
          e.y2 * scale + y,
          e.x2 * scale + x,
          e.y2 * scale + y,
        );
      }
      ctx.stroke();
    }
  };

  const scheduleFrame = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      setView({ x, y, scale });
      drawEdges();
    });
  };

  // Pan/zoom schedules frames through apply(); layout and resize use this effect.
  createEffect(() => {
    edges();
    viewport();
    scheduleFrame();
  });

  /** Zoom so the viewport point (cx, cy) stays fixed in world space. */
  const zoomAt = (cx: number, cy: number, next: number) => {
    const rect = root.getBoundingClientRect();
    const px = cx - rect.left;
    const py = cy - rect.top;
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    x = px - ((px - x) * clamped) / scale;
    y = py - ((py - y) * clamped) / scale;
    scale = clamped;
    apply();
  };

  const zoomStep = (factor: number) => {
    const rect = root.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, scale * factor);
  };

  const fitBounds = (left: number, top: number, w: number, h: number, maxScale = MAX_SCALE) => {
    const vp = viewport();
    if (!vp.w || !vp.h || !w || !h) return;
    const pad = 40;
    scale = Math.min(
      maxScale,
      Math.max(FIT_MIN_SCALE, Math.min((vp.w - 2 * pad) / w, (vp.h - 2 * pad) / h)),
    );
    x = (vp.w - w * scale) / 2 - left * scale;
    y = (vp.h - h * scale) / 2 - top * scale;
    apply();
  };

  const fit = () => {
    const b = layout().bounds;
    fitBounds(0, 0, b.w, b.h);
  };

  const resetZoom = () => {
    const rect = root.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1);
  };

  const centerActive = () => {
    const p =
      state.tree.activeLeafId != null ? positions().get(state.tree.activeLeafId) : undefined;
    const vp = viewport();
    if (!p || !vp.w || !vp.h) return;
    x = vp.w / 2 - (p.x + CARD_W / 2) * scale;
    y = vp.h / 2 - (p.y + CARD_H / 2) * scale;
    apply();
  };

  const activate = async (message: Message): Promise<boolean> => {
    if (state.treeNavigationPending) return false;
    if (message.id === state.tree.activeLeafId) return true;
    return navigateTree(() => api.activate(message.id, state.tree));
  };

  const onCardClick = (message: Message, e: MouseEvent) => {
    if (panMoved) return;
    // Card controls must not also switch branches.
    if ((e.target as Element).closest('button, a, input, textarea, select')) return;
    void activate(message);
  };

  const onCardDblClick = (message: Message) => {
    if (panMoved) return;
    void activate(message).then((ok) => {
      if (ok) {
        setState('viewMode', 'chat');
        writePageLocation({ ...readPageLocation(), viewMode: undefined });
      }
    });
  };

  let panning = false;
  /** Set once a gesture has moved past the click threshold; suppresses card clicks. */
  let panMoved = false;
  let panClickResetTimer: number | undefined;
  let downX = 0;
  let downY = 0;
  let dragStartX = 0;
  let dragStartY = 0;
  let pinching = false;
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let lastMidX = 0;
  let lastMidY = 0;
  /** Vertical drags scroll cards within the map's touch-action:none surface. */
  let cardScroll: Element | null = null;
  let touchDecided = false;
  let cardScrolling = false;
  let lastScrollY = 0;

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    // Mouse pans from the background only; cards keep text selection/clicks.
    if ((e.target as Element).closest('.treemap-card, .treemap-toolbar')) return;
    clearTimeout(panClickResetTimer);
    panClickResetTimer = undefined;
    panning = true;
    panMoved = false;
    downX = e.clientX;
    downY = e.clientY;
    dragStartX = e.clientX - x;
    dragStartY = e.clientY - y;
    root.classList.add('treemap-panning');
    e.preventDefault();
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!panning) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) panMoved = true;
    x = e.clientX - dragStartX;
    y = e.clientY - dragStartY;
    apply();
  };
  const onMouseUp = () => {
    if (!panning) return;
    const moved = panMoved;
    panning = false;
    root.classList.remove('treemap-panning');
    if (moved) {
      // Defer reset past the synthetic click so ending a drag over a card cannot activate it.
      panClickResetTimer = window.setTimeout(() => {
        panMoved = false;
        panClickResetTimer = undefined;
      }, 0);
    } else {
      panMoved = false;
    }
  };

  const distance = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const midpoint = (a: Touch, b: Touch) => ({
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2,
  });

  const onTouchStart = (e: TouchEvent) => {
    if ((e.target as Element).closest('.treemap-toolbar')) return;
    if (e.touches.length === 2) {
      pinching = true;
      panning = false;
      cardScroll = null;
      panMoved = true; // a pinch must never end in a card click
      pinchStartDist = distance(e.touches[0]!, e.touches[1]!);
      pinchStartScale = scale;
      const mid = midpoint(e.touches[0]!, e.touches[1]!);
      lastMidX = mid.x;
      lastMidY = mid.y;
      e.preventDefault();
    } else if (e.touches.length === 1) {
      pinching = false;
      panning = true;
      panMoved = false;
      touchDecided = false;
      cardScrolling = false;
      downX = e.touches[0]!.clientX;
      downY = e.touches[0]!.clientY;
      dragStartX = downX - x;
      dragStartY = downY - y;
      lastScrollY = downY;
      const card = (e.target as Element).closest('.treemap-card:not(.treemap-card-mini)');
      const body = card?.querySelector('.msg-swipe');
      cardScroll = body && body.scrollHeight > body.clientHeight + 1 ? body : null;
    }
  };
  const onTouchMove = (e: TouchEvent) => {
    if (pinching && e.touches.length === 2) {
      e.preventDefault();
      const mid = midpoint(e.touches[0]!, e.touches[1]!);
      x += mid.x - lastMidX;
      y += mid.y - lastMidY;
      lastMidX = mid.x;
      lastMidY = mid.y;
      zoomAt(
        mid.x,
        mid.y,
        pinchStartScale * (distance(e.touches[0]!, e.touches[1]!) / pinchStartDist),
      );
    } else if (panning && e.touches.length === 1) {
      const touch = e.touches[0]!;
      const dx = touch.clientX - downX;
      const dy = touch.clientY - downY;
      if (!touchDecided) {
        if (Math.hypot(dx, dy) <= 8) return;
        touchDecided = true;
        cardScrolling = cardScroll !== null && Math.abs(dy) > Math.abs(dx) * 1.2;
        panMoved = true;
      }
      e.preventDefault();
      if (cardScrolling && cardScroll) {
        cardScroll.scrollTop -= (touch.clientY - lastScrollY) / scale;
        lastScrollY = touch.clientY;
        return;
      }
      x = touch.clientX - dragStartX;
      y = touch.clientY - dragStartY;
      apply();
    }
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length === 1) {
      // Pinch released into a single finger: continue as a pan from here.
      pinching = false;
      panning = true;
      cardScroll = null;
      touchDecided = true;
      downX = e.touches[0]!.clientX;
      downY = e.touches[0]!.clientY;
      dragStartX = downX - x;
      dragStartY = downY - y;
    } else if (e.touches.length === 0) {
      pinching = false;
      panning = false;
      cardScroll = null;
    }
  };

  const onWheel = (e: WheelEvent) => {
    // Keep ordinary wheel gestures inside full cards; background/modifier gestures zoom.
    if (
      !e.ctrlKey &&
      !e.metaKey &&
      (e.target as Element).closest('.treemap-card:not(.treemap-card-mini)')
    )
      return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, scale * (e.deltaY > 0 ? 1 / 1.15 : 1.15));
  };

  // Frame small trees in full; large trees open around the active branch.
  let initialCameraDone = false;
  createEffect(() => {
    if (initialCameraDone || !viewport().w || !viewport().h || positions().size === 0) return;
    initialCameraDone = true;
    const b = layout().bounds;
    const vp = viewport();
    const active =
      state.tree.activeLeafId != null ? state.tree.messages[state.tree.activeLeafId] : undefined;
    if (
      !active ||
      ordered().length <= 8 ||
      Math.min((vp.w - 80) / b.w, (vp.h - 80) / b.h) >= MINI_SCALE
    ) {
      fitBounds(0, 0, b.w, b.h, 1);
      return;
    }
    const neighbors = childrenByParent().get(active.parentId ?? -1) ?? [active];
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const include = (id: number) => {
      const p = positions().get(id);
      if (!p) return;
      left = Math.min(left, p.x);
      top = Math.min(top, p.y);
      right = Math.max(right, p.x + CARD_W);
      bottom = Math.max(bottom, p.y + CARD_H);
    };
    for (const message of neighbors) include(message.id);
    if (active.parentId != null) include(active.parentId);
    fitBounds(left, top, right - left, bottom - top, 1);
  });

  createEffect(
    on([mapSearchQuery, searchMatches, searchParent, viewport], ([, matches, parent, vp]) => {
      if (!matches?.size || !vp.w || !vp.h) return;
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      const include = (id: number) => {
        const p = positions().get(id);
        if (!p) return;
        left = Math.min(left, p.x);
        top = Math.min(top, p.y);
        right = Math.max(right, p.x + CARD_W);
        bottom = Math.max(bottom, p.y + CARD_H);
      };
      for (const id of matches) include(id);
      if (parent !== null) include(parent);
      if (Number.isFinite(left)) fitBounds(left, top, right - left, bottom - top, 1);
    }),
  );

  createEffect(
    on(mapSearchTarget, (target) => {
      if (!target) return;
      const p = positions().get(target.messageId);
      if (p) fitBounds(p.x, p.y, CARD_W, CARD_H, 1);
    }),
  );

  highlightMapSearch(() => content, mapSearchQuery);

  let resizeObserver: ResizeObserver | undefined;
  onMount(() => {
    resizeObserver = new ResizeObserver(() => {
      setViewport({ w: root.clientWidth, h: root.clientHeight });
    });
    resizeObserver.observe(root);
    setViewport({ w: root.clientWidth, h: root.clientHeight });
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
  onCleanup(() => {
    resizeObserver?.disconnect();
    setMapSearchResults([]);
    setMapSearchTarget(null);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    clearTimeout(panClickResetTimer);
    if (rafId) cancelAnimationFrame(rafId);
  });

  return (
    <div
      ref={root}
      class="treemap"
      onMouseDown={onMouseDown}
      // Direct listeners allow preventDefault; Solid delegates wheel/touch passively.
      on:wheel={onWheel}
      on:touchstart={onTouchStart}
      on:touchmove={onTouchMove}
      on:touchend={onTouchEnd}
      on:touchcancel={onTouchEnd}
    >
      <canvas ref={edgesCanvas} class="treemap-edges-canvas" aria-hidden="true" />
      <div ref={content} class="treemap-content">
        <For each={visibleMessages()}>
          {(message) => (
            <div
              class="treemap-card"
              data-message-id={message.id}
              classList={{
                'treemap-card-mini': view().scale < MINI_SCALE,
                'treemap-search-match': searchMatches()?.has(message.id) ?? false,
                'treemap-search-dimmed':
                  searchMatches() !== null &&
                  !searchMatches()!.has(message.id) &&
                  message.id !== searchParent(),
                'treemap-on-path': activeIds().has(message.id),
                'treemap-active-leaf': message.id === state.tree.activeLeafId,
              }}
              style={{
                left: `${positions().get(message.id)?.x ?? 0}px`,
                top: `${positions().get(message.id)?.y ?? 0}px`,
              }}
              onClick={(e) => onCardClick(message, e)}
              onDblClick={() => onCardDblClick(message)}
            >
              <Show
                when={view().scale >= MINI_SCALE}
                fallback={
                  // Inverse scaling keeps text readable without changing the card layout.
                  <div
                    class="treemap-mini"
                    style={{ 'font-size': `${Math.min(12 / view().scale, 240)}px` }}
                  >
                    <span class="treemap-mini-snippet">{snippet(message, mapSearchQuery())}</span>
                  </div>
                }
              >
                <MessageNode message={message} inMap />
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={ordered().length === 0}>
        <p class="treemap-empty hint">No messages yet.</p>
      </Show>
      <div class="treemap-toolbar">
        <button class="icon-btn" title="Zoom in" aria-label="Zoom in" onClick={() => zoomStep(1.3)}>
          <FontAwesomeIcon icon={faPlus} size={12} />
        </button>
        <button
          class="icon-btn"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => zoomStep(1 / 1.3)}
        >
          <FontAwesomeIcon icon={faMinus} size={12} />
        </button>
        <button
          class="icon-btn treemap-zoom"
          title="Reset zoom to 100%"
          aria-label="Reset zoom to 100%"
          onClick={resetZoom}
        >
          {Math.round(view().scale * 100)}%
        </button>
        <button
          class="icon-btn"
          title="Fit the whole tree"
          aria-label="Fit whole tree"
          onClick={fit}
        >
          <FontAwesomeIcon icon={faExpand} size={16} />
        </button>
        <button
          class="icon-btn"
          title="Center on the active message"
          aria-label="Center active message"
          onClick={centerActive}
        >
          <FontAwesomeIcon icon={faCrosshairs} size={16} />
        </button>
      </div>
    </div>
  );
}
