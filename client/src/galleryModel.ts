import type { GalleryItem } from '@tinytavern/shared';

export function resolveGalleryFolder(key: string, folders: readonly { id: number }[], loaded: boolean): string {
  return loaded && key !== 'all' && key !== 'root' && !folders.some((folder) => String(folder.id) === key)
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
  const next = position < 0 ? Math.min(previousPosition, count) + (direction < 0 ? -1 : 0) : position + direction;
  return next >= 0 && next < count ? next : -1;
}

export const galleryCharacterKeys = (item: Pick<GalleryItem, 'characters' | 'characterName'>) =>
  item.characters.length
    ? item.characters.map((character) => `id:${character.id}`)
    : item.characterName
      ? [`name:${item.characterName}`]
      : [];

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
  headings: GalleryFolderHeading[];
}

export interface GalleryFolderGroup {
  id: number | null;
  name: string;
  items: GalleryItem[];
}

export interface GalleryFolderHeading {
  id: number | null;
  name: string;
  count: number;
  top: number;
  height: number;
}

const folderCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Preserve the selected date order within each folder, with unfiled media last. */
export function groupGalleryByFolder(
  items: readonly GalleryItem[],
  folders: readonly { id: number; name: string }[],
): GalleryFolderGroup[] {
  const names = new Map(folders.map((folder) => [folder.id, folder.name]));
  const groups = new Map<number | null, GalleryFolderGroup>();
  for (const item of items) {
    let group = groups.get(item.folderId);
    if (!group) {
      group = {
        id: item.folderId,
        name: item.folderId === null ? 'Unfiled' : (names.get(item.folderId) ?? 'Folder'),
        items: [],
      };
      groups.set(item.folderId, group);
    }
    group.items.push(item);
  }
  return [...groups.values()].sort((a, b) =>
    a.id === null ? 1 : b.id === null ? -1 : folderCollator.compare(a.name, b.name) || a.id - b.id,
  );
}

/** Each folder has its own justified rows; headings share the grid's viewport culling. */
export function layoutGalleryFolders(
  groups: readonly GalleryFolderGroup[],
  width: number,
  targetHeight: number,
  gap = 8,
): GalleryLayout {
  const result: GalleryLayout = { rows: [], rowById: new Map(), headings: [], height: 0 };
  if (width <= 0 || targetHeight <= 0) return result;
  let itemOffset = 0;
  for (const group of groups) {
    if (!group.items.length) continue;
    const top = result.height + (result.headings.length ? 16 : 0);
    const headingHeight = 40;
    result.headings.push({
      id: group.id,
      name: group.name,
      count: group.items.length,
      top,
      height: headingHeight,
    });
    const section = layoutGallery(group.items, width, targetHeight, gap);
    const rowOffset = result.rows.length;
    for (const row of section.rows) {
      row.top += top + headingHeight;
      for (const cell of row.cells) cell.index += itemOffset;
      result.rows.push(row);
    }
    for (const [id, row] of section.rowById) result.rowById.set(id, row + rowOffset);
    itemOffset += group.items.length;
    result.height = top + headingHeight + section.height;
  }
  return result;
}

const aspectRatio = (item: GalleryItem) =>
  item.media.width && item.media.height && item.media.width > 0 && item.media.height > 0
    ? item.media.width / item.media.height
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
  if (width <= 0 || targetHeight <= 0) return { rows, rowById, headings: [], height: 0 };
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
  return { rows, rowById, headings: [], height: Math.max(0, top - gap) };
}

/** First row whose bottom is below the given offset; shared by culling and anchoring. */
export function galleryRowAt(rows: readonly Pick<GalleryRow, 'top' | 'height'>[], offset: number): number {
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
  rows: readonly Pick<GalleryRow, 'top' | 'height'>[],
  top: number,
  height: number,
  overscan = 500,
) {
  return {
    start: galleryRowAt(rows, Math.max(0, top - overscan)),
    end: Math.min(rows.length, galleryRowAt(rows, top + height + overscan) + 1),
  };
}
