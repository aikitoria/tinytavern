import { createEffect, onCleanup } from 'solid-js';
import type { MediaVideoPreview } from '@tinytavern/shared';
import { createVideoPreviewFrames } from './videoPreviewFrames.ts';
import { createVideoPreviewPlayback } from './videoPreviewPlayback.ts';

export default function VideoPreview(props: { preview: MediaVideoPreview; active: boolean }) {
  const canvases: HTMLCanvasElement[] = [];
  const contexts: (CanvasRenderingContext2D | null)[] = [];
  let animation = 0;
  let active = false;
  let ready = false;
  let transitionId = 0;

  const playback = createVideoPreviewPlayback<ImageBitmap>({
    now: () => performance.now(),
    draw(layer, bitmap) {
      const canvas = canvases[layer]!;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      const context = (contexts[layer] ??= canvas.getContext('2d'));
      context?.drawImage(bitmap, 0, 0);
    },
    show(layer, fade, finished) {
      const id = ++transitionId;
      const front = canvases[layer]!;
      const back = canvases[1 - layer]!;
      front.style.display = 'block';
      front.style.zIndex = '1';
      back.style.zIndex = '0';
      front.style.opacity = '1';
      if (!fade) {
        back.style.display = 'none';
        return;
      }
      back.style.display = 'block';
      const transition = front.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 300,
        easing: 'ease-out',
        fill: 'forwards',
      });
      void transition.finished
        .then(() => {
          if (id !== transitionId) return;
          back.style.display = 'none';
          transition.cancel();
          finished();
        })
        .catch(() => {});
      return () => {
        transitionId++;
        transition.cancel();
      };
    },
  });

  function animate(now: number) {
    animation = 0;
    if (!active || !ready) return;
    playback.tick(now);
    animation = requestAnimationFrame(animate);
  }

  function resume() {
    if (!active || !ready) {
      cancelAnimationFrame(animation);
      animation = 0;
    } else if (!animation) {
      animation = requestAnimationFrame(animate);
    }
  }

  const buffer = createVideoPreviewFrames(
    async (source, signal) => {
      const response = await fetch(source, { signal });
      if (!response.ok) throw new Error('Preview frame unavailable');
      const blob = await response.blob();
      signal.throwIfAborted();
      return createImageBitmap(blob);
    },
    (sequence) => {
      playback.present(sequence);
      ready = true;
      resume();
    },
  );

  const update = () => {
    active = props.active && !document.hidden;
    playback.setActive(active);
    buffer.update(props.preview, active);
    resume();
  };
  createEffect(update);
  document.addEventListener('visibilitychange', update);
  onCleanup(() => {
    cancelAnimationFrame(animation);
    document.removeEventListener('visibilitychange', update);
    playback.dispose();
    buffer.dispose();
  });

  return (
    <span
      class="media-result video-preview grid isolate w-full min-h-0 max-h-[100cqh]"
      role="img"
      aria-label="Generation video preview"
    >
      <canvas
        ref={(canvas) => {
          canvases[0] = canvas;
        }}
        aria-hidden="true"
      />
      <canvas
        ref={(canvas) => {
          canvases[1] = canvas;
        }}
        aria-hidden="true"
      />
    </span>
  );
}
