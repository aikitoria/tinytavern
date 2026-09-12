import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
import { createRoot } from 'solid-js';
import type { GalleryItem, MediaAsset } from '@tinytavern/shared';

test('gallery picker reveals details and releases deleted selections', async () => {
  Object.defineProperties(globalThis, {
    localStorage: {
      configurable: true,
      value: { getItem: (key: string) => (key === 'tinytavern.gallery.details' ? '0' : null) },
    },
    document: {
      configurable: true,
      value: { addEventListener() {}, removeEventListener() {} },
    },
    window: { configurable: true, value: { setTimeout: () => 0 } },
    matchMedia: { configurable: true, value: () => ({ matches: false, addEventListener() {} }) },
    cancelAnimationFrame: { configurable: true, value: () => {} },
  });
  let toggle!: (id: number) => void;
  let confirm!: () => void;
  let detailsVisible: unknown;
  mock.module('react/jsx-dev-runtime', () => ({
    Fragment: Symbol('Fragment'),
    jsxDEV: (_type: unknown, props: Record<string, unknown>) => {
      if (props.onToggle) toggle = props.onToggle as typeof toggle;
      if (props.class === 'primary-btn') confirm = props.onClick as typeof confirm;
      if (props.class === 'gallery-details-toggle') detailsVisible = props['aria-expanded'];
      return null;
    },
  }));
  const storePath = '../../client/src/state/store.ts';
  const { setState } = await import(storePath);
  const componentPath = '../../client/src/components/gallery/GalleryModal.tsx';
  const { default: GalleryModal } = await import(componentPath);
  const items: GalleryItem[] = [1, 2, 3].map((id) => ({
    id,
    folderId: null,
    characterName: 'Uploads',
    characters: [],
    sourceMessageId: null,
    sourceConversationId: null,
    sourceImage: null,
    prompt: '',
    createdAt: id,
    updatedAt: id,
    media: { id, kind: 'image', url: `/images/${id}.png`, width: 10, height: 10 } as MediaAsset,
  }));
  setState('gallery', items);
  let selected: number[] = [];
  let dispose!: () => void;
  createRoot((cleanup) => {
    dispose = cleanup;
    GalleryModal({
      picker: {
        maximum: 2,
        selectedAssetIds: [1, 2],
        onConfirm: (items: GalleryItem[]) => {
          selected = items.map((item) => item.id);
        },
        onCancel() {},
      },
    });
  });
  try {
    assert.equal(detailsVisible, true, 'Picker details remain available after hiding gallery details');
    setState('gallery', items.slice(1));
    toggle(3);
    confirm();
    assert.deepEqual(selected, [2, 3], 'A deleted image releases its slot and preserves selection order');
  } finally {
    dispose();
    mock.restore();
  }
});
