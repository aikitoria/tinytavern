import type { GalleryItem } from '@tinytavern/shared';

export function resolveGalleryFolder(
  key: string,
  folders: readonly { id: number }[],
  loaded: boolean,
): string {
  return loaded &&
    key !== 'all' &&
    key !== 'root' &&
    !folders.some((folder) => String(folder.id) === key)
    ? 'root'
    : key;
}

/** A moved item retains its old position between its remaining neighbors. */
export function adjacentGalleryIndex(
  position: number,
  previousPosition: number,
  direction: number,
  count: number,
): number {
  const next =
    position < 0
      ? Math.min(previousPosition, count) + (direction < 0 ? -1 : 0)
      : position + direction;
  return next >= 0 && next < count ? next : -1;
}

export const galleryCharacterKeys = (item: Pick<GalleryItem, 'characters' | 'characterName'>) =>
  item.characters.length
    ? item.characters.map((character) => `id:${character.id}`)
    : [`name:${item.characterName}`];

export function indexGallery(items: readonly GalleryItem[]) {
  return items
    .map((item) => ({
      item,
      characterKeys: galleryCharacterKeys(item),
      search: item.prompt.toLowerCase(),
    }))
    .sort((a, b) => b.item.createdAt - a.item.createdAt || b.item.id - a.item.id);
}

export function filterGallery(
  index: ReturnType<typeof indexGallery>,
  query: string,
  characterKey: string,
  oldestFirst: boolean,
  folderId?: number | null,
): GalleryItem[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const result = index
    .filter(
      (entry) =>
        (folderId === undefined || entry.item.folderId === folderId) &&
        (characterKey === 'all' || entry.characterKeys.includes(characterKey)) &&
        terms.every((term) => entry.search.includes(term)),
    )
    .map((entry) => entry.item);
  return oldestFirst ? result.reverse() : result;
}

export interface GalleryCell {
  item: GalleryItem;
  index: number;
  left: number;
  width: number;
}

export interface GalleryRow {
  top: number;
  height: number;
  cells: GalleryCell[];
}

export interface GalleryLayout {
  rows: GalleryRow[];
  height: number;
  rowById: Map<number, number>;
}

const aspectRatio = (item: GalleryItem) =>
  item.imageWidth && item.imageHeight && item.imageWidth > 0 && item.imageHeight > 0
    ? item.imageWidth / item.imageHeight
    : 1;

/** Greedy O(n) justified rows; keep sparse final rows near the requested size. */
export function layoutGallery(
  items: readonly GalleryItem[],
  width: number,
  targetHeight: number,
  gap = 8,
): GalleryLayout {
  const rows: GalleryRow[] = [];
  const rowById = new Map<number, number>();
  if (width <= 0 || targetHeight <= 0) return { rows, rowById, height: 0 };
  let start = 0;
  let sum = 0;
  let top = 0;
  const emit = (end: number, ratios: number, last = false) => {
    const count = end - start;
    const fittedHeight = (width - gap * (count - 1)) / ratios;
    const height = last && fittedHeight > targetHeight * 1.35 ? targetHeight : fittedHeight;
    let left = 0;
    const cells: GalleryCell[] = [];
    for (let index = start; index < end; index++) {
      const item = items[index]!;
      const cellWidth = aspectRatio(item) * height;
      cells.push({ item, index, left, width: cellWidth });
      rowById.set(item.id, rows.length);
      left += cellWidth + gap;
    }
    rows.push({ top, height, cells });
    top += height + gap;
    start = end;
  };
  for (let index = 0; index < items.length; index++) {
    const ratio = aspectRatio(items[index]!);
    // Extreme portrait ratios can otherwise fill the entire width with gaps.
    if (index > start && gap * (index - start) >= width) {
      emit(index, sum, true);
      sum = 0;
    }
    sum += ratio;
    const count = index - start + 1;
    if (sum * targetHeight + gap * (count - 1) < width) continue;
    const height = (width - gap * (count - 1)) / sum;
    const previousHeight = count > 1 ? (width - gap * (count - 2)) / (sum - ratio) : Infinity;
    if (
      previousHeight <= targetHeight * 1.35 &&
      Math.abs(previousHeight - targetHeight) < Math.abs(height - targetHeight)
    ) {
      emit(index, sum - ratio);
      sum = ratio;
    } else {
      emit(index + 1, sum);
      sum = 0;
    }
  }
  if (start < items.length) emit(items.length, sum, true);
  return { rows, rowById, height: Math.max(0, top - gap) };
}

/** First row whose bottom is below the given offset; shared by culling and anchoring. */
export function galleryRowAt(rows: readonly GalleryRow[], offset: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const row = rows[mid]!;
    if (row.top + row.height <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function visibleGalleryRows(
  rows: readonly GalleryRow[],
  top: number,
  height: number,
  overscan = 500,
) {
  return {
    start: galleryRowAt(rows, Math.max(0, top - overscan)),
    end: Math.min(rows.length, galleryRowAt(rows, top + height + overscan) + 1),
  };
}
