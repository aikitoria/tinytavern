import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
import { createRoot, createSignal } from 'solid-js';
import { ENTITY_FIELDS, type Endpoint } from '@tinytavern/shared';
import { endpointEditorSnapshot } from '../../client/src/state/endpointSync.ts';

test('model discovery preserves endpoint drafts without hiding configuration conflicts', async () => {
  Object.defineProperties(globalThis, {
    matchMedia: {
      configurable: true,
      value: () => ({ matches: false, addEventListener() {} }),
    },
    location: { configurable: true, value: { hash: '#' } },
    window: { configurable: true, value: { setTimeout: () => 0 } },
  });
  let isDirty!: () => boolean;
  mock.module('../../client/src/components/settings/SettingsGuard.tsx', () => ({
    useSettingsGuard: (actions: { isDirty: () => boolean }) => (isDirty = actions.isDirty),
    useSettingsNavigation: () => (action: () => void) => action(),
  }));
  const modulePath = '../../client/src/util.ts';
  const { createEntityEditor } = await import(modulePath);
  let dispose!: () => void;
  const endpoint: Endpoint = {
    ...ENTITY_FIELDS.endpoints,
    id: 1,
    createdAt: 1,
    name: 'Local',
    hasApiKey: false,
    models: [],
  };
  let draft = { name: '', model: null as string | null };
  let loads = 0;
  let writes = 0;
  const { editor, discover, configure } = createRoot((cleanup) => {
    dispose = cleanup;
    const [items, setItems] = createSignal([endpoint]);
    const discover = (models: string[]) => setItems(([item]) => [{ ...item!, models }]);
    const editor = createEntityEditor({
      items,
      snapshot: endpointEditorSnapshot,
      initialId: () => 1,
      load: (item: Endpoint | undefined) => {
        loads++;
        draft = { name: item?.name ?? '', model: item?.model ?? null };
      },
      data: () => ({ ...draft }),
      create: async () => endpoint,
      patch: async (_id: number, data: Partial<typeof draft>) => {
        writes++;
        // Discovery can also arrive while a save request is pending.
        discover(['model-a', 'model-b', 'model-c']);
        return { ...items()[0]!, ...data };
      },
      remove: async () => {},
      duplicate: async () => endpoint,
      deletePrompt: 'Delete endpoint?',
    });
    return {
      editor,
      discover,
      configure: () => setItems(([item]) => [{ ...item!, baseUrl: 'http://changed/v1' }]),
    };
  });
  try {
    const initialLoads = loads;
    discover(['model-a']);
    assert.equal(loads, initialLoads, 'Discovery must not rebuild a clean editor');
    assert.equal(draft.model, null, 'Discovery preserves the endpoint default');
    assert.equal(isDirty(), false, 'Fetching models must not make the page dirty');
    draft.name = 'Unsaved name';
    discover(['model-a', 'model-b']);
    assert.deepEqual(editor.selected()?.models, ['model-a', 'model-b']);
    assert.equal(loads, initialLoads, 'Discovery must not overwrite unsaved fields');
    assert.equal(draft.name, 'Unsaved name');
    assert.equal(isDirty(), true, 'Fetching models must preserve existing edits');
    assert.equal(editor.status(), '');
    assert.equal(await editor.save(), true, 'Cache updates must not block saving');
    assert.equal(writes, 1);
    assert.equal(draft.name, 'Unsaved name');

    draft.model = 'model-b';
    configure();
    assert.match(editor.status(), /changed on another device/);
    assert.equal(await editor.save(), false, 'Real configuration changes remain guarded');
    assert.equal(writes, 1);
    assert.equal(draft.model, 'model-b');
  } finally {
    dispose();
  }
});
