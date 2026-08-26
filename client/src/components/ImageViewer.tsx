import { createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';

/**
 * Fullscreen pan/zoom image viewer (interaction model borrowed from
 * SillyTavern's media modal): wheel zooms toward the cursor, pinch zooms
 * toward the touch midpoint, mouse or single-finger drag pans. Escape or a
 * backdrop click closes; double-click resets the view.
 */
export default function ImageViewer(props: { src: string; onClose: () => void }) {
  let overlay!: HTMLDivElement;
  let img!: HTMLImageElement;
  let scale = 1;
  let x = 0;
  let y = 0;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let pinching = false;
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let lastMidX = 0;
  let lastMidY = 0;
  let enteredFullscreen = false;
  let previouslyFocused: HTMLElement | null = null;
  const [zoomPercent, setZoomPercent] = createSignal(100);

  const apply = () => {
    img.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
  };

  /** Zoom so the viewport point (cx, cy) stays fixed on the image. */
  const zoomAt = (cx: number, cy: number, next: number) => {
    const rect = img.getBoundingClientRect();
    const dx = cx - (rect.left + rect.width / 2);
    const dy = cy - (rect.top + rect.height / 2);
    const clamped = Math.min(10, Math.max(0.1, next));
    const delta = clamped - scale;
    x -= (dx * delta) / scale;
    y -= (dy * delta) / scale;
    scale = clamped;
    setZoomPercent(Math.round(clamped * 100));
    apply();
  };
  const zoomStep = (factor: number) =>
    zoomAt(window.innerWidth / 2, window.innerHeight / 2, scale * factor);

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, scale * (e.deltaY > 0 ? 1 / 1.15 : 1.15));
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX - x;
    dragStartY = e.clientY - y;
    overlay.classList.add('dragging');
    e.preventDefault();
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!dragging) return;
    x = e.clientX - dragStartX;
    y = e.clientY - dragStartY;
    apply();
  };
  const onMouseUp = () => {
    dragging = false;
    overlay.classList.remove('dragging');
  };

  const distance = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const midpoint = (a: Touch, b: Touch) => ({
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2,
  });

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      pinching = true;
      dragging = false;
      pinchStartDist = distance(e.touches[0]!, e.touches[1]!);
      pinchStartScale = scale;
      const mid = midpoint(e.touches[0]!, e.touches[1]!);
      lastMidX = mid.x;
      lastMidY = mid.y;
      e.preventDefault();
    } else if (e.touches.length === 1) {
      pinching = false;
      dragging = true;
      dragStartX = e.touches[0]!.clientX - x;
      dragStartY = e.touches[0]!.clientY - y;
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
    } else if (dragging && e.touches.length === 1) {
      e.preventDefault();
      x = e.touches[0]!.clientX - dragStartX;
      y = e.touches[0]!.clientY - dragStartY;
      apply();
    }
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length === 1) {
      // Pinch released into a single finger: continue as a pan from here.
      pinching = false;
      dragging = true;
      dragStartX = e.touches[0]!.clientX - x;
      dragStartY = e.touches[0]!.clientY - y;
    } else if (e.touches.length === 0) {
      pinching = false;
      dragging = false;
    }
  };

  const onKey = (e: KeyboardEvent) => {
    // Captured before ChatView's document listener: the chat must not swipe
    // siblings (and unmount this very message) underneath the viewer.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      const controls = [
        ...overlay.querySelectorAll<HTMLElement>('button, [href], [tabindex]'),
      ].filter(
        (element) =>
          element !== overlay && !element.hasAttribute('disabled') && element.tabIndex >= 0,
      );
      if (controls.length === 0) {
        e.preventDefault();
        overlay.focus();
        return;
      }
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === overlay)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  /** Exit native fullscreen first; fullscreenchange owns the eventual close.
   * The fixed overlay remains a complete fallback when the API is unavailable. */
  const close = () => {
    if (document.fullscreenElement === overlay) {
      void document.exitFullscreen().catch(() => props.onClose());
    } else {
      props.onClose();
    }
  };

  const onFullscreenChange = () => {
    if (document.fullscreenElement === overlay) {
      enteredFullscreen = true;
    } else if (enteredFullscreen) {
      enteredFullscreen = false;
      props.onClose();
    }
  };

  const reset = () => {
    scale = 1;
    setZoomPercent(100);
    x = 0;
    y = 0;
    apply();
  };

  onMount(() => {
    previouslyFocused = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    // Mount happens synchronously from the image click, while transient user
    // activation is still available. If the browser refuses, the fixed
    // viewport overlay continues to work as before.
    if (overlay.requestFullscreen) {
      void overlay.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
    }
    overlay.focus();
  });
  onCleanup(() => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    if (document.fullscreenElement === overlay) {
      void document.exitFullscreen().catch(() => undefined);
    }
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
  });

  return (
    <Portal>
      <div
        ref={overlay}
        class="image-viewer"
        role="dialog"
        aria-modal="true"
        aria-label="Generated image viewer"
        tabIndex={-1}
        onClick={(e) => {
          if (e.target === overlay) close();
        }}
        onDblClick={reset}
        onWheel={onWheel}
        // on: attaches directly to the element (not Solid's delegated document
        // listener, which is passive for touch events and ignores preventDefault).
        on:touchstart={onTouchStart}
        on:touchmove={onTouchMove}
        on:touchend={onTouchEnd}
        on:touchcancel={onTouchEnd}
      >
        <img
          ref={img}
          src={props.src}
          alt="Generated image"
          draggable={false}
          onMouseDown={onMouseDown}
        />
        <div class="image-viewer-toolbar" role="toolbar" aria-label="Image viewer controls">
          <button
            class="icon-btn"
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => zoomStep(1 / 1.2)}
          >
            −
          </button>
          <button class="image-viewer-zoom" title="Reset zoom" onClick={reset}>
            {zoomPercent()}%
          </button>
          <button
            class="icon-btn"
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() => zoomStep(1.2)}
          >
            +
          </button>
          <span class="image-viewer-hint">Scroll or pinch to zoom · drag to pan</span>
          <button class="icon-btn" title="Close" aria-label="Close image viewer" onClick={close}>
            ✕
          </button>
        </div>
      </div>
    </Portal>
  );
}
