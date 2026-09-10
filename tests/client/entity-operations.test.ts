import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
import { createRoot, createSignal } from 'solid-js';
import { createSettingsNavigation } from '../../client/src/state/settingsSubmission.ts';
import { avatarEditorSnapshot } from '../../client/src/state/editorSync.ts';
import { pendingConfirmation, settleConfirmation } from '../../client/src/state/confirm.ts';

Object.defineProperties(globalThis, {
  matchMedia: { configurable: true, value: () => ({ matches: false, addEventListener() {} }) },
  location: { configurable: true, value: { hash: '#' } },
  window: { configurable: true, value: { setTimeout: () => 0 } },
});
let navigation = createSettingsNavigation();
mock.module('../../client/src/components/settings/SettingsGuard.tsx', () => ({
  useSettingsGuard: (actions: Parameters<typeof navigation.register>[0]) =>
    navigation.register(actions),
  useSettingsNavigation: () => navigation.navigate,
}));
const modulePath = '../../client/src/util.ts';
const { createEntityEditor } = await import(modulePath);

test('imports guard dirty drafts and late entity operations cannot replace a newer draft', async () => {
  navigation = createSettingsNavigation();
  let draft = { name: '' };
  let finishDuplicate!: (item: { id: string; name: string }) => void;
  let finishDelete!: () => void;
  let dispose!: () => void;
  const { editor, items, setItems } = createRoot((cleanup) => {
    dispose = cleanup;
    const [items, setItems] = createSignal([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]);
    const editor = createEntityEditor({
      items,
      initialId: () => 'a',
      load: (item: { id: string; name: string } | undefined) => {
        draft = { name: item?.name ?? '' };
      },
      data: () => ({ ...draft }),
      create: async (data: typeof draft) => ({ id: 'created', ...data }),
      patch: async (id: string, data: Partial<typeof draft>) => {
        const item = { ...items().find((item) => item.id === id)!, ...data };
        setItems((current) => current.map((value) => (value.id === id ? item : value)));
        return item;
      },
      remove: () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
      duplicate: () =>
        new Promise<{ id: string; name: string }>((resolve) => {
          finishDuplicate = resolve;
        }),
      deletePrompt: 'Delete?',
    });
    return { editor, items, setItems };
  });
  try {
    const imported = { id: 'imported', name: 'Imported' };
    setItems([...items(), imported]);
    draft.name = 'Unsaved A';
    editor.adopt(imported);
    assert.equal(navigation.promptOpen(), true);
    assert.equal(editor.selectedId(), 'a');
    navigation.cancel();
    assert.equal(draft.name, 'Unsaved A');
    editor.adopt(imported);
    await navigation.save();
    assert.equal(items().find((item) => item.id === 'a')!.name, 'Unsaved A');
    assert.equal(editor.selectedId(), 'imported');

    editor.select('a');
    editor.duplicate();
    editor.select('b');
    draft.name = 'Unsaved B';
    const copy = { id: 'copy', name: 'A copy' };
    setItems([...items(), copy]);
    finishDuplicate(copy);
    await Promise.resolve();
    assert.equal(editor.selectedId(), 'b');
    assert.equal(draft.name, 'Unsaved B');
    assert.equal(
      navigation.promptOpen(),
      false,
      'An old operation cannot prompt a different editor',
    );

    editor.discard();
    editor.select('a');
    const deleting = editor.remove();
    assert.equal(pendingConfirmation()?.confirmLabel, 'Delete');
    assert.equal(typeof finishDelete, 'undefined', 'Ordinary deletes wait for confirmation');
    settleConfirmation(true);
    await Promise.resolve();
    editor.select('b');
    draft.name = 'Still unsaved B';
    setItems(items().filter((item) => item.id !== 'a'));
    finishDelete();
    await deleting;
    assert.equal(editor.selectedId(), 'b');
    assert.equal(draft.name, 'Still unsaved B');

    editor.discard();
    const localDelete = editor.remove({ shiftKey: true });
    await Promise.resolve();
    assert.equal(pendingConfirmation(), null, 'Shift-click skips individual delete confirmation');
    setItems(items().filter((item) => item.id !== 'b'));
    assert.equal(editor.selectedId(), 'b', 'Our pending deletion owns the selection transition');
    assert.equal(editor.status(), '', 'Our own settings update is not a remote deletion');
    finishDelete();
    await localDelete;
    assert.equal(editor.selectedId(), 'new');
    assert.equal(editor.status(), '');
    editor.select('imported');
    editor.duplicate();
    finishDuplicate(copy);
    await Promise.resolve();
    assert.equal(editor.selectedId(), 'copy');
  } finally {
    dispose();
  }
});

test('avatar updates preserve text drafts while actual text conflicts remain guarded', async () => {
  navigation = createSettingsNavigation();
  let draft = { name: '' };
  let writes = 0;
  let dispose!: () => void;
  const { editor, setItems } = createRoot((cleanup) => {
    dispose = cleanup;
    const [items, setItems] = createSignal([
      { id: 1, name: 'Character', avatar: 'old.png', avatarThumbnail: 'old-thumb.png' },
    ]);
    const editor = createEntityEditor({
      items,
      initialId: () => 1,
      snapshot: avatarEditorSnapshot,
      load: (
        item: { id: number; name: string; avatar: string; avatarThumbnail: string } | undefined,
      ) => {
        draft = { name: item?.name ?? '' };
      },
      data: () => ({ ...draft }),
      create: async () => items()[0]!,
      patch: async (_id: number, data: Partial<typeof draft>) => {
        writes++;
        const item = { ...items()[0]!, ...data };
        setItems([item]);
        return item;
      },
      remove: async () => {},
      duplicate: async () => items()[0]!,
      deletePrompt: 'Delete?',
    });
    return { editor, setItems };
  });
  try {
    draft.name = 'Unsaved name';
    setItems((current) => [
      { ...current[0]!, avatar: 'new.png', avatarThumbnail: 'new-thumb.png' },
    ]);
    assert.equal(editor.status(), '');
    assert.equal(await editor.save(), true);
    assert.equal(draft.name, 'Unsaved name');
    assert.equal(editor.selected()!.avatar, 'new.png');
    draft.name = 'Later edit';
    setItems((current) => [{ ...current[0]!, name: 'Remote name' }]);
    assert.equal(await editor.save(), false);
    assert.equal(writes, 1);
    assert.equal(draft.name, 'Later edit');
  } finally {
    dispose();
  }
});
