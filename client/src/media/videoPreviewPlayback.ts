import type { VideoPreviewSequence } from './videoPreviewFrames.ts';

type Layer = 0 | 1;

/** Both canvas layers use one clock and frame index; fades never restart playback. */
export function createVideoPreviewPlayback<T>(options: {
  now(): number;
  draw(layer: Layer, frame: T): void;
  show(layer: Layer, fade: boolean, finished: () => void): (() => void) | undefined;
}) {
  let current: { sequence: VideoPreviewSequence<T>; layer: Layer } | undefined;
  let previous: typeof current;
  let pending: VideoPreviewSequence<T> | undefined;
  let cancelFade: (() => void) | undefined;
  let cursor = 0;
  let lastDraw = 0;
  let active = false;
  let disposed = false;

  function draw() {
    if (previous) {
      options.draw(previous.layer, previous.sequence.frames[cursor % previous.sequence.frames.length]!);
    }
    if (current) options.draw(current.layer, current.sequence.frames[cursor]!);
  }

  function tick(now: number) {
    if (!active || !current) return;
    const interval = 1000 / current.sequence.frameRate;
    const advance = Math.floor((now - lastDraw) / interval);
    if (advance > 0) {
      cursor = (cursor + advance) % current.sequence.frames.length;
      lastDraw += advance * interval;
      draw();
    }
  }

  function finishFade() {
    cancelFade = undefined;
    previous?.sequence.release();
    previous = undefined;
    const next = pending;
    pending = undefined;
    if (next) present(next);
  }

  function present(sequence: VideoPreviewSequence<T>) {
    if (disposed) {
      sequence.release();
      return;
    }
    if (previous) {
      // Finish the visible blend without snapping; only the latest waiting update is needed.
      pending?.release();
      pending = sequence;
      return;
    }
    tick(options.now());
    previous = current;
    current = { sequence, layer: current?.layer === 0 ? 1 : 0 };
    cursor %= sequence.frames.length;
    if (!previous) lastDraw = options.now();
    draw();
    const fade = active && previous !== undefined;
    cancelFade = options.show(current.layer, fade, finishFade);
    if (!fade) finishFade();
  }

  return {
    present,
    tick,
    setActive(enabled: boolean) {
      if (active === enabled) return;
      active = enabled;
      if (active) {
        lastDraw = options.now();
      } else if (previous && current) {
        cancelFade?.();
        options.show(current.layer, false, finishFade);
        finishFade();
      }
    },
    dispose() {
      disposed = true;
      cancelFade?.();
      previous?.sequence.release();
      current?.sequence.release();
      pending?.release();
      previous = current = undefined;
      pending = undefined;
    },
  };
}
