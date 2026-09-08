import assert from 'node:assert/strict';
import type { GalleryItem } from '@tinytavern/shared';
import {
  filterGallery,
  indexGallery,
  layoutGallery,
  visibleGalleryRows,
} from '../client/src/galleryModel.ts';

const items: GalleryItem[] = Array.from({ length: 5000 }, (_, index) => ({
  id: index + 1,
  characters: index % 2 ? [{ id: 7, name: 'Ashina' }] : [],
  characterName: index % 2 ? 'Ashina' : 'Uploads',
  sourceMessageId: null,
  sourceConversationId: null,
  sourceImage: null,
  prompt: index % 3 ? 'Blue forest at night' : 'Warm sunlight',
  image: `/images/${index}.png`,
  imageWidth: [600, 1200, 1000, 2000][index % 4]!,
  imageHeight: 1000,
  createdAt: index,
  updatedAt: index,
}));
for (const width of [320, 768, 1920]) {
  for (const size of [140, 240, 320]) {
    const layout = layoutGallery(items, width, size);
    assert.equal(layout.rowById.size, items.length);
    assert.equal(layout.rows.flatMap((row) => row.cells).length, items.length);
    let end = -8;
    for (const [index, row] of layout.rows.entries()) {
      assert(row.height > 0);
      assert(Math.abs(row.top - (end + 8)) < 1e-7);
      end = row.top + row.height;
      let right = -8;
      for (const cell of row.cells) {
        assert(Math.abs(cell.left - (right + 8)) < 1e-7);
        assert(
          Math.abs(cell.width / row.height - cell.item.imageWidth! / cell.item.imageHeight!) < 1e-7,
        );
        assert.equal(layout.rowById.get(cell.item.id), index);
        right = cell.left + cell.width;
      }
      assert(right <= width + 1e-7, 'No row overflows the viewport');
      if (index < layout.rows.length - 1)
        assert(Math.abs(right - width) < 1e-7, 'Complete rows fill the width');
    }
    const visible = visibleGalleryRows(layout.rows, 20000, 700);
    assert(
      visible.end - visible.start < 35,
      'DOM work remains bounded independently of collection size',
    );
    assert(layout.rows[visible.start]!.top <= 20000);
    assert(Math.abs(layout.height - end) < 1e-7);
  }
}
assert.equal(layoutGallery([], 1000, 240).height, 0);
assert.equal(layoutGallery(items, 0, 240).height, 0);
assert(
  layoutGallery(
    items.slice(0, 100).map((item) => ({ ...item, imageWidth: 1, imageHeight: 100000 })),
    320,
    240,
  ).rows.every((row) => row.height > 0),
  'Extreme portrait dimensions never produce zero-height rows',
);
assert.equal(
  layoutGallery(items.slice(0, 1), 1920, 240).rows[0]!.height,
  240,
  'Sparse final rows do not balloon',
);
const index = indexGallery(items);
const filtered = filterGallery(index, 'NIGHT blue', 'id:7', true);
assert(
  filtered.every(
    (item) =>
      item.characters.some((character) => character.id === 7) &&
      item.prompt === 'Blue forest at night',
  ),
);
assert(filtered[0]!.id < filtered[1]!.id);
assert.equal(filterGallery(index, 'absent', 'all', false).length, 0);
assert.equal(filterGallery(index, '', 'name:Uploads', false).length, 2500);
console.log(
  'Gallery layout regressions passed: geometry, aspect ratios, culling, search, filters and ordering.',
);

const combined = {
  ...items[1]!,
  characters: [
    { id: 7, name: 'Ashina' },
    { id: 8, name: 'Haeun' },
  ],
  characterName: 'Ashina, Haeun',
};
const combinedIndex = indexGallery([combined]);
assert.equal(filterGallery(combinedIndex, '', 'id:7', false).length, 1);
assert.equal(filterGallery(combinedIndex, '', 'id:8', false).length, 1);
assert.equal(filterGallery(combinedIndex, '', 'id:9', false).length, 0);
