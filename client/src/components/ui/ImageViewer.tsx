import { createPanZoom } from '../../panZoom.ts';
import { onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { registerUiBack } from '../../state/uiBack.ts';

export default function ImageViewer(props: { src: string; onClose: () => void }) {
  let overlay!: HTMLDivElement;
  let img!: HTMLImageElement;
  const camera = { x: 0, y: 0, scale: 1 };
  let dragging = false;
  let pinching = false;
  let enteredFullscreen = false;
  let previouslyFocused: HTMLElement | null = null;
  const apply = () => {
    img.style.transform = `translate(-50%, -50%) translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
  };

  /** Zoom so the viewport point (cx, cy) stays fixed on the image. */
  const zoomAt = (cx: number, cy: number, next: number) => {
    const rect = img.getBoundingClientRect();
    const dx = cx - (rect.left + rect.width / 2);
    const dy = cy - (rect.top + rect.height / 2);
    const clamped = Math.min(10, Math.max(0.1, next));
    const delta = clamped - camera.scale;
    camera.x -= (dx * delta) / camera.scale;
    camera.y -= (dy * delta) / camera.scale;
    camera.scale = clamped;
    apply();
  };

  const gesture = createPanZoom(camera, apply, zoomAt);

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, camera.scale * (e.deltaY > 0 ? 1 / 1.15 : 1.15));
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    gesture.startPan(e);
    overlay.classList.add('dragging');
    e.preventDefault();
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!dragging) return;
    gesture.pan(e);
  };
  const onMouseUp = () => {
    dragging = false;
    overlay.classList.remove('dragging');
  };

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      pinching = true;
      dragging = false;
      gesture.startPinch(e.touches[0]!, e.touches[1]!);
      e.preventDefault();
    } else if (e.touches.length === 1) {
      pinching = false;
      dragging = true;
      gesture.startPan(e.touches[0]!);
    } else {
      pinching = false;
      dragging = false;
    }
  };
  const onTouchMove = (e: TouchEvent) => {
    if (pinching && e.touches.length === 2) {
      e.preventDefault();
      gesture.pinch(e.touches[0]!, e.touches[1]!);
    } else if (dragging && e.touches.length === 1) {
      e.preventDefault();
      gesture.pan(e.touches[0]!);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    // Capture before ChatView can swipe siblings and unmount the viewer's message.
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
      e.preventDefault();
      overlay.focus();
    }
  };

  /** fullscreenchange closes the viewer after native fullscreen exits. */
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
    camera.scale = 1;
    camera.x = 0;
    camera.y = 0;
    apply();
  };

  onMount(() => {
    registerUiBack(overlay, close);
    previouslyFocused = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    // Synchronous mount retains click activation; the fixed overlay handles refusal.
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
        class="image-viewer fixed inset-0 z-300 bg-black select-none overflow-hidden touch-none [&:focus]:outline-clear [&::backdrop]:bg-black [&_img]:absolute [&_img]:rounded-md [&_img]:cursor-grab [&.dragging_img]:cursor-grabbing [&:fullscreen]:w-screen [&:fullscreen]:h-dvh [&_img]:left-1/2 [&_img]:top-1/2 [&_img]:max-w-[92vw] [&_img]:max-h-[92dvh]"
        role="dialog"
        aria-modal="true"
        aria-label="Generated image viewer"
        tabIndex={-1}
        onClick={(e) => {
          if (e.target === overlay) close();
        }}
        onDblClick={reset}
        onWheel={onWheel}
        // Direct listeners allow preventDefault; Solid's delegated touch listeners are passive.
        on:touchstart={onTouchStart}
        on:touchmove={onTouchMove}
        on:touchend={onTouchStart}
        on:touchcancel={onTouchStart}
      >
        <img
          ref={img}
          src={props.src}
          alt="Generated image"
          draggable={false}
          onMouseDown={onMouseDown}
        />
      </div>
    </Portal>
  );
}
