import { createEffect, onCleanup } from 'solid-js';
import type { MediaVideoPreview } from '@tinytavern/shared';

/** VHS sends individually updated JPEG frames; play them without re-encoding a video. */
export default function VideoPreview(props: { preview: MediaVideoPreview; active: boolean }) {
  let canvas!: HTMLCanvasElement;
  const frames = new Map<number, { source: string; bitmap: ImageBitmap }>();
  let sources: MediaVideoPreview['frames'] = {};
  let clipId = '';
  let frameCount = 0;
  let frameRate = 1;
  let cursor = -1;
  let lastDraw = 0;
  let animation = 0;
  let decoding = false;
  let disposed = false;
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
    if (!active || document.hidden || !frames.size) return;
    if (now - lastDraw >= 1000 / frameRate) {
      for (let offset = 1; offset <= frameCount; offset++) {
        const index = (cursor + offset) % frameCount;
        const frame = frames.get(index);
        if (frame) {
          cursor = index;
          draw(frame.bitmap);
          lastDraw = now;
          break;
        }
      }
    }
    animation = requestAnimationFrame(animate);
  }

  function resume() {
    if (disposed || !active || document.hidden) {
      cancelAnimationFrame(animation);
      animation = 0;
      return;
    }
    if (!animation && frames.size) animation = requestAnimationFrame(animate);
    void decode();
  }

  async function decode() {
    if (decoding || disposed || !active || document.hidden) return;
    decoding = true;
    try {
      // Decode serially, taking the newest source for each index and ignoring replaced clips.
      for (const [key, source] of Object.entries(sources)) {
        if (disposed || !active || document.hidden) break;
        if (sources[key] !== source) continue;
        const index = Number(key);
        if (!source || frames.get(index)?.source === source) continue;
        const id = clipId;
        let bitmap: ImageBitmap | undefined;
        try {
          const blob = await (await fetch(source)).blob();
          bitmap = await createImageBitmap(blob);
          if (disposed || id !== clipId || sources[key] !== source) {
            bitmap.close();
            bitmap = undefined;
            continue;
          }
          frames.get(index)?.bitmap.close();
          frames.set(index, { source, bitmap });
          if (cursor < 0 && active && !document.hidden) {
            cursor = index;
            draw(bitmap);
            lastDraw = performance.now();
          }
          bitmap = undefined; // The frame cache now owns it.
          if (!animation && active && !document.hidden) animation = requestAnimationFrame(animate);
        } catch {
          bitmap?.close();
          // A malformed preview must not affect the job or its finished video.
          if (id === clipId && sources[key] === source) delete sources[key];
        }
        if (disposed || !active || document.hidden) break;
      }
    } finally {
      decoding = false;
      // Frames may have arrived while decoding the previous batch.
      if (
        !disposed &&
        active &&
        !document.hidden &&
        Object.entries(sources).some(
          ([key, source]) => source && frames.get(Number(key))?.source !== source,
        )
      )
        void decode();
    }
  }

  createEffect(() => {
    const preview = props.preview;
    active = props.active;
    frameCount = preview.frameCount;
    frameRate = preview.frameRate;
    if (clipId !== preview.id) {
      for (const frame of frames.values()) frame.bitmap.close();
      frames.clear();
      clipId = preview.id;
      cursor = -1;
    }
    sources = { ...preview.frames };
    for (const [index, frame] of frames) {
      if (!sources[index]) {
        frame.bitmap.close();
        frames.delete(index);
      }
    }
    resume();
  });

  document.addEventListener('visibilitychange', resume);
  onCleanup(() => {
    disposed = true;
    cancelAnimationFrame(animation);
    document.removeEventListener('visibilitychange', resume);
    for (const frame of frames.values()) frame.bitmap.close();
    frames.clear();
  });

  return (
    <canvas ref={canvas} class="media-result" role="img" aria-label="Generation video preview" />
  );
}
