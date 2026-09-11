import type { MediaVideoPreview } from '@tinytavern/shared';

interface Bitmap {
  close(): void;
}

export interface VideoPreviewSequence<T> {
  frames: readonly T[];
  frameRate: number;
  release(): void;
}

/** Decode arriving frames eagerly; only complete denoise sequences reach playback. */
export function createVideoPreviewFrames<T extends Bitmap>(
  decode: (source: string, signal: AbortSignal) => Promise<T>,
  publish: (sequence: VideoPreviewSequence<T>) => void,
) {
  interface Entry {
    source: string;
    controller: AbortController;
    settled: boolean;
    references: number;
    bitmap?: T;
  }
  const entries = new Map<string, Entry>();
  let desired = new Map<number, string>();
  let preview: MediaVideoPreview | undefined;
  let publishedId = '';
  let publishedSequence = '';
  let active = false;
  let disposed = false;

  function release(entry: Entry) {
    entries.delete(entry.source);
    entry.controller.abort();
    entry.bitmap?.close();
    entry.bitmap = undefined;
  }

  function collect() {
    const wanted = active ? new Set(desired.values()) : new Set<string>();
    for (const entry of entries.values()) {
      if (!wanted.has(entry.source) && !entry.references) release(entry);
    }
  }

  function commit() {
    if (!active || disposed || !preview || desired.size !== preview.frameCount) return;
    if (publishedId === preview.id && publishedSequence === preview.sequence) return;
    const frames: T[] = [];
    const retained = new Set<Entry>();
    for (let index = 0; index < preview.frameCount; index++) {
      const source = desired.get(index);
      const entry = source === undefined ? undefined : entries.get(source);
      // Failed or missing frames keep the previous complete sequence playing.
      if (!entry?.settled || !entry.bitmap) return;
      frames.push(entry.bitmap);
      retained.add(entry);
    }
    publishedId = preview.id;
    publishedSequence = preview.sequence;
    for (const entry of retained) entry.references++;
    let released = false;
    publish({
      frames,
      frameRate: preview.frameRate,
      release() {
        if (released) return;
        released = true;
        for (const entry of retained) entry.references--;
        collect();
      },
    });
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
      // A malformed or cancelled sequence cannot replace a usable preview.
    }
    if (disposed || entries.get(entry.source) !== entry) return;
    entry.settled = true;
    commit();
  }

  return {
    update(next: MediaVideoPreview, enabled: boolean) {
      if (disposed) return;
      preview = next;
      desired = new Map(
        Object.entries(next.frames).flatMap(([key, source]) => {
          const index = Number(key);
          return source && Number.isInteger(index) && index >= 0 && index < next.frameCount
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
        const entry = { source, controller: new AbortController(), settled: false, references: 0 };
        entries.set(source, entry);
        pending.push(entry);
      }
      // Identical JPEGs share one bitmap, including across the two fading sequences.
      for (const entry of pending) void load(entry);
      commit();
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) release(entry);
      desired.clear();
      preview = undefined;
    },
  };
}
