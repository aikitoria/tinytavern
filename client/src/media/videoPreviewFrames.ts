import type { MediaVideoPreview } from '@tinytavern/shared';

interface Bitmap {
  close(): void;
}

export interface VideoPreviewFrame<T extends Bitmap> {
  index: number;
  bitmap: T;
}

/** Eagerly decode received frames, then publish a complete available snapshot in one swap. */
export function createVideoPreviewFrames<T extends Bitmap>(
  decode: (source: string, signal: AbortSignal) => Promise<T>,
  publish: (frames: readonly VideoPreviewFrame<T>[]) => void,
) {
  interface Entry {
    source: string;
    controller: AbortController;
    settled: boolean;
    bitmap?: T;
  }
  const entries = new Map<string, Entry>();
  let desired = new Map<number, string>();
  let displayed: readonly VideoPreviewFrame<T>[] = [];
  let displayedSources = new Set<string>();
  let id = '';
  let active = false;
  let disposed = false;

  function release(entry: Entry) {
    entries.delete(entry.source);
    entry.controller.abort();
    entry.bitmap?.close();
  }

  function collect() {
    const wanted = active ? new Set(desired.values()) : new Set<string>();
    for (const entry of entries.values()) {
      if (!wanted.has(entry.source) && !displayedSources.has(entry.source)) release(entry);
    }
  }

  function commit() {
    if (!active || disposed) return;
    const next: VideoPreviewFrame<T>[] = [];
    const sources = new Set<string>();
    for (const [index, source] of desired) {
      const entry = entries.get(source);
      if (!entry?.settled) return;
      if (entry.bitmap) {
        next.push({ index, bitmap: entry.bitmap });
        sources.add(source);
      }
    }
    // A bad batch should not blank a usable preview. Changed sources can retry later.
    if (desired.size && !next.length) return;
    next.sort((a, b) => a.index - b.index);
    const changed =
      next.length !== displayed.length ||
      next.some(
        (frame, index) =>
          frame.index !== displayed[index]!.index || frame.bitmap !== displayed[index]!.bitmap,
      );
    displayed = next;
    displayedSources = sources;
    if (changed) publish(next);
    collect();
  }

  async function load(entry: Entry) {
    try {
      const bitmap = await decode(entry.source, entry.controller.signal);
      if (disposed || entries.get(entry.source) !== entry) {
        bitmap.close();
        return;
      }
      entry.bitmap = bitmap;
    } catch {
      // Malformed or cancelled frames never block the next usable snapshot.
    }
    if (disposed || entries.get(entry.source) !== entry) return;
    entry.settled = true;
    commit();
  }

  return {
    update(preview: MediaVideoPreview, enabled: boolean) {
      if (disposed) return;
      if (id !== preview.id) {
        for (const entry of entries.values()) release(entry);
        displayed = [];
        displayedSources.clear();
        id = preview.id;
        publish(displayed);
      }
      desired = new Map(
        Object.entries(preview.frames).flatMap(([key, source]) => {
          const index = Number(key);
          return source && Number.isInteger(index) && index >= 0 && index < preview.frameCount
            ? [[index, source] as const]
            : [];
        }),
      );
      active = enabled;
      collect();
      if (!active) return;
      const pending: Entry[] = [];
      for (const source of new Set(desired.values())) {
        if (entries.has(source)) continue;
        const entry = { source, controller: new AbortController(), settled: false };
        entries.set(source, entry);
        pending.push(entry);
      }
      // Start every new frame immediately, independently of playback and other decodes.
      // Identical JPEGs share one bitmap, including across successive snapshots.
      for (const entry of pending) void load(entry);
      commit();
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) release(entry);
      desired.clear();
      displayed = [];
      displayedSources.clear();
    },
  };
}
