import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { Message } from '@minitavern/shared';
import { api } from '../state/api.ts';
import {
  activePath,
  childrenByParent,
  navigateTree,
  personasEnabled,
  selectedCharacter,
  selectedPersona,
  setState,
  state,
} from '../state/store.ts';
import MessageNode from './MessageNode.tsx';
import '../styles/treemap.css';

// Fixed card slots: the map never measures content and never relayouts, so
// positions are stable at every zoom level (no layout jumps). Below
// MINI_SCALE a card swaps its MessageNode for a snippet whose font scales
// inversely with the zoom, keeping the text a constant screen size.
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

/** A parent→child bezier in world coordinates, with a bounding box for
 * culling. Drawn onto a viewport-sized canvas in screen space (no giant SVG
 * layer — those blow past GPU texture limits on large trees). */
interface Edge {
  id: number;
  x1: number;
  y1: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  x2: number;
  y2: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  onPath: boolean;
}

/** Mirrors MessageNode's name resolution (same duplication as TreeView). */
function speakerName(message: Message): string {
  if (message.role === 'user') {
    return (personasEnabled() ? selectedPersona() : null)?.name ?? 'You';
  }
  if (message.role === 'tool') return message.name ?? 'Tool';
  if (message.role === 'system') return message.name ?? 'System';
  return message.name ?? selectedCharacter()?.name ?? 'Assistant';
}

function snippet(message: Message): string {
  const text = message.content.replace(/\s+/g, ' ').trim();
  if (text) return text.length > 500 ? text.slice(0, 500) : text;
  if (message.images.length > 0 || message.imagePending) return '[image]';
  return '(empty)';
}

/**
 * Zoomable 2D map of the whole message tree. Pan/zoom follows ImageViewer's
 * model (plain mutable transform written straight to the element); cards are
 * viewport-culled and swap between full MessageNodes and constant-screen-size
 * snippet tiles depending on zoom — the layout itself never changes, so
 * zooming is jump-free. Opens centered on the active leaf at full zoom.
 * Click activates a branch and stays in the map; double-click activates and
 * returns to the chat.
 */
export default function TreeMap() {
  let root!: HTMLDivElement;
  let content!: HTMLDivElement;
  let edgesCanvas!: HTMLCanvasElement;

  // Mutable camera; the `view` signal mirrors it (rAF-throttled) to drive
  // viewport culling and the snippet swap without re-rendering per event.
  let scale = 1;
  let x = 0;
  let y = 0;
  const [view, setView] = createSignal({ x: 0, y: 0, scale: 1 });
  const [viewport, setViewport] = createSignal({ w: 0, h: 0 });
  let rafId = 0;

  /** DFS layout: leaves take successive row slots, parents sit at the mean of
   * their children's rows; x = depth. Positions keyed by id so cards keyed by
   * message reference never remount on relayout. */
  const positions = createMemo(() => {
    const byParent = childrenByParent();
    const map = new Map<number, Pos>();
    let row = 0;
    const walk = (message: Message, depth: number): number => {
      const kids = byParent.get(message.id) ?? [];
      let y: number;
      if (kids.length === 0) {
        y = row++ * ROW_H;
      } else {
        let sum = 0;
        for (const kid of kids) sum += walk(kid, depth + 1);
        y = sum / kids.length;
      }
      map.set(message.id, { x: depth * COL_W, y });
      return y;
    };
    for (const rootMsg of byParent.get(-1) ?? []) walk(rootMsg, 0);
    return map;
  });

  /** Messages in DFS order; stable references keep <For> from remounting cards. */
  const ordered = createMemo<Message[]>(() => {
    const byParent = childrenByParent();
    const out: Message[] = [];
    const walk = (message: Message) => {
      out.push(message);
      for (const kid of byParent.get(message.id) ?? []) walk(kid);
    };
    for (const rootMsg of byParent.get(-1) ?? []) walk(rootMsg);
    return out;
  });

  /** Ids on the active path, root -> active leaf. */
  const activeIds = createMemo(() => new Set(activePath().map((message) => message.id)));

  /** Cubic bezier per parent->child link, from the parent's right edge to the
   * child's left edge, plus a bounding box for culling. */
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
        id: message.id,
        x1,
        y1,
        c1x: x1 + dx,
        c1y: y1,
        c2x: x2 - dx,
        c2y: y2,
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

  /** World-space size of the laid-out tree; sizes the SVG layer. */
  const bounds = createMemo(() => {
    let w = 0;
    let h = 0;
    for (const p of positions().values()) {
      w = Math.max(w, p.x + CARD_W);
      h = Math.max(h, p.y + CARD_H);
    }
    return { w, h };
  });

  /** Visible rectangle in world coordinates (null until the pane is measured). */
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

  /** Cards/edges intersecting the visible rect plus one viewport of margin. */
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

  /** Draws the visible edges in screen space onto the viewport-sized canvas.
   * World layers are gone — nothing here can exceed texture limits. */
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
          e.c1y * scale + y,
          e.c2x * scale + x,
          e.c2y * scale + y,
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

  // Redraw edges when the layout or the pane size changes (pan/zoom frames
  // come through apply → scheduleFrame).
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

  /** Scale/translate so the whole laid-out tree fits the viewport. */
  const fit = () => {
    const vp = viewport();
    const b = bounds();
    if (!vp.w || !vp.h || !b.w || !b.h) return;
    const pad = 40;
    scale = Math.min(
      MAX_SCALE,
      Math.max(FIT_MIN_SCALE, Math.min((vp.w - 2 * pad) / b.w, (vp.h - 2 * pad) / b.h)),
    );
    x = (vp.w - b.w * scale) / 2;
    y = (vp.h - b.h * scale) / 2;
    apply();
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

  /** Like TreeView's activate(), but stays in the map — the active-path
   * highlight updates live off the resulting treePatch. */
  const activate = async (message: Message): Promise<boolean> => {
    if (state.treeNavigationPending) return false;
    if (message.id === state.tree.activeLeafId) return true;
    return navigateTree(() =>
      api.activate(message.id, state.tree.activeLeafId, state.tree.mutationRevision),
    );
  };

  const onCardClick = (message: Message, e: MouseEvent) => {
    if (panMoved) return;
    // Interactive elements inside the card (reasoning chip, plugin controls)
    // keep their own behavior instead of triggering a branch switch.
    if ((e.target as Element).closest('button, a, input, textarea, select')) return;
    void activate(message);
  };

  const onCardDblClick = (message: Message) => {
    if (panMoved) return;
    void activate(message).then((ok) => {
      if (ok) setState('viewMode', 'chat');
    });
  };

  // ---- Pan/zoom input ----

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
  /** One-finger touch on a scrollable card may become a native card scroll. */
  let cardScroll: Element | null = null;
  let touchDecided = false;

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
      // Keep suppression through the synthetic click that immediately follows
      // this mouseup, then allow the next independent card click. A synchronous
      // reset could activate a card when a background drag ends over one.
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
      downX = e.touches[0]!.clientX;
      downY = e.touches[0]!.clientY;
      dragStartX = downX - x;
      dragStartY = downY - y;
      const card = (e.target as Element).closest('.treemap-card');
      cardScroll = card && card.scrollHeight > card.clientHeight + 1 ? card : null;
    }
  };
  const onTouchMove = (e: TouchEvent) => {
    if (pinching && e.touches.length === 2) {
      e.preventDefault();
      const mid = midpoint(e.touches[0]!, e.touches[1]!);
      // Pan by the midpoint travel, then zoom toward the midpoint.
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
        // A mostly-vertical drag on a scrollable card scrolls the card instead.
        if (cardScroll && Math.abs(dy) > Math.abs(dx) * 1.2) {
          panning = false;
          return;
        }
        panMoved = true;
      }
      e.preventDefault();
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
    // The wheel always zooms the map — even over cards (their content scrolls
    // via the scrollbar or a vertical touch drag instead).
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, scale * (e.deltaY > 0 ? 1 / 1.15 : 1.15));
  };

  // First render with a laid-out tree opens readable: centered on the active
  // leaf at full zoom (fit only as a fallback when there is no leaf yet).
  let initialCameraDone = false;
  createEffect(() => {
    if (initialCameraDone || !viewport().w || positions().size === 0) return;
    initialCameraDone = true;
    if (state.tree.activeLeafId != null && positions().has(state.tree.activeLeafId)) {
      centerActive();
    } else {
      fit();
    }
  });

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
      // on: attaches directly to the element (Solid's delegated listeners are
      // passive for wheel/touch and can't preventDefault).
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
              classList={{
                'treemap-card-mini': view().scale < MINI_SCALE,
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
                  // Inverse font scaling keeps the tile text a constant screen
                  // size at any zoom (capped); the fixed slot clips the rest.
                  <div
                    class="treemap-mini"
                    style={{ 'font-size': `${Math.min(12 / view().scale, 240)}px` }}
                  >
                    <div class="treemap-mini-head">
                      <span class={`treemap-role role-indicator role-color-${message.role}`} />
                      <span class="treemap-mini-name">{speakerName(message)}</span>
                    </div>
                    <span class="treemap-mini-snippet">{snippet(message)}</span>
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
        <button class="icon-btn" title="Zoom in" onClick={() => zoomStep(1.3)}>
          +
        </button>
        <button class="icon-btn" title="Zoom out" onClick={() => zoomStep(1 / 1.3)}>
          −
        </button>
        <button class="icon-btn" title="Fit the whole tree" onClick={fit}>
          ⛶
        </button>
        <button class="icon-btn" title="Center on the active message" onClick={centerActive}>
          ◎
        </button>
      </div>
    </div>
  );
}
