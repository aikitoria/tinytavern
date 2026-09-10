import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
interface EditorPage {
  chatId: number | null;
  viewMode?: string;
  modal: string;
  settingsTab: string;
  settingsEntity: number | string;
  settingsDetail: boolean;
}

test('entity reference edits target the precise editor without changing the selection', async () => {
  const opened: EditorPage[] = [];
  mock.module('../../client/src/state/store.ts', () => ({
    openDialog: (page: EditorPage) => opened.push(page),
  }));
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { hash: '#72/map+/settings/generation-settings' },
  });
  const path = '../../client/src/state/entityReferences.ts';
  const { entityOption, entityOptions } = await import(path);
  const items = [
    { id: 'workflow-10', name: 'Workflow 10' },
    { id: 'workflow-2', name: 'workflow 2' },
  ];
  const options = entityOptions('workflows', items);
  assert.deepEqual(
    options.map((item: { value: string }) => item.value),
    ['workflow-2', 'workflow-10'],
  );
  assert.equal(items[0]!.id, 'workflow-10', 'Option ordering does not reorder persisted entities');
  options[0]!.edit!();
  assert.deepEqual(opened.pop(), {
    chatId: 72,
    viewMode: 'map',
    modal: 'settings',
    settingsTab: 'workflows',
    settingsEntity: 'workflow-2',
    settingsDetail: true,
  });
  const option = entityOption('presets', { id: 42, name: 'Referenced item' }, '');
  option.edit!();
  assert.equal(opened.at(-1)!.settingsTab, 'system-prompts');
  assert.equal(opened.at(-1)!.settingsEntity, 42, 'A default choice edits the resolved entity');
  assert.equal(option.value, '', 'Editing never selects or activates an entity');
});
