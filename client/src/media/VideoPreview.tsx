import { createEffect, onCleanup } from 'solid-js';
import type { MediaVideoPreview } from '@tinytavern/shared';
import { createVideoPreviewFrames, type VideoPreviewFrame } from './videoPreviewFrames.ts';

/** Playback reads decoded snapshots; frame arrival never waits for the playback cursor. */
export default function VideoPreview(props: { preview: MediaVideoPreview; active: boolean }) {
  let canvas!: HTMLCanvasElement;
  let frames: readonly VideoPreviewFrame<ImageBitmap>[] = [];
  let frameRate = 1;
  let cursor = -1;
  let lastDraw = 0;
  let animation = 0;
  let active = false;

  function draw(bitmap: ImageBitmap) {
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  }

  function animate(now: number) {
    animation = 0;
    if (!active || !frames.length) return;
    const interval = 1000 / frameRate;
    const advance = Math.floor((now - lastDraw) / interval);
    if (advance > 0) {
      cursor = (cursor + advance) % frames.length;
      draw(frames[cursor]!.bitmap);
      lastDraw += advance * interval;
    }
    animation = requestAnimationFrame(animate);
  }

  function resume() {
    if (!active || !frames.length) {
      cancelAnimationFrame(animation);
      animation = 0;
    } else if (!animation) {
      lastDraw = performance.now();
      animation = requestAnimationFrame(animate);
    }
  }

  const buffer = createVideoPreviewFrames(
    async (source, signal) => {
      // Frames are data URLs from the WebSocket; this converts their bytes to a Blob.
      const response = await fetch(source, { signal });
      if (!response.ok) throw new Error('Preview frame unavailable');
      const blob = await response.blob();
      signal.throwIfAborted();
      return createImageBitmap(blob);
    },
    (next) => {
      const index = frames[cursor]?.index;
      frames = next;
      cursor = frames.findIndex((frame) => frame.index === index);
      if (frames.length && cursor < 0) {
        cursor = 0;
        draw(frames[0]!.bitmap);
      } else if (!frames.length) {
        canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      }
      resume();
    },
  );

  const update = () => {
    active = props.active && !document.hidden;
    frameRate = props.preview.frameRate;
    buffer.update(props.preview, active);
    resume();
  };
  createEffect(update);
  document.addEventListener('visibilitychange', update);
  onCleanup(() => {
    cancelAnimationFrame(animation);
    document.removeEventListener('visibilitychange', update);
    buffer.dispose();
  });

  return (
    <canvas
      ref={canvas}
      class="media-result block object-contain w-full max-h-[100cqh]"
      role="img"
      aria-label="Generation video preview"
    />
  );
}
