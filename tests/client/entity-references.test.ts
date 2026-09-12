import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '@tinytavern/shared';
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
  const settings = structuredClone(DEFAULT_SETTINGS);
  mock.module('../../client/src/state/store.ts', () => ({
    openDialog: (page: EditorPage) => opened.push(page),
    state: {
      settings,
      characterFolders: [{ id: 1, name: 'Characters' }],
      presetFolders: [{ id: 3, name: 'Writing styles' }],
    },
  }));
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { hash: '#72/map+/settings/generation-settings' },
  });
  const path = '../../client/src/state/entityReferences.ts';
  const { entityOption, entityOptions } = await import(path);
  type Option = { value: string; group?: string };
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

  settings.mediaRendering.folders = [
    { id: '10', name: 'Folder 10' },
    { id: '2', name: 'Folder 2' },
    { id: 'empty', name: 'Empty' },
  ];
  const grouped = entityOptions('workflows', [
    ...items.map((item) => ({ ...item, folderId: item.id === 'workflow-2' ? '2' : '10' })),
    { id: 'root', name: 'Root item' },
  ]);
  assert.deepEqual(
    grouped.map(({ value, group }: Option) => [value, group]),
    [
      ['root', undefined],
      ['workflow-2', 'Folder 2'],
      ['workflow-10', 'Folder 10'],
    ],
    'Root entries and populated folders retain natural order after filtering',
  );
  grouped[1]!.edit!();
  assert.equal(opened.pop()!.settingsEntity, 'workflow-2');
  for (const kind of ['mediaChatPrompts', 'mediaStandalonePrompts'] as const) {
    settings[kind].folders = [{ id: 'prompts', name: 'Prompts' }];
    assert.equal(
      entityOptions(
        kind,
        items.map((item) => ({ ...item, folderId: item.id === 'workflow-2' ? 'prompts' : null })),
      ).at(-1)!.group,
      'Prompts',
    );
    settings[kind].folders = [];
    assert(
      entityOptions(
        kind,
        items.map((item) => ({ ...item, folderId: item.id === 'workflow-2' ? 'prompts' : null })),
      ).every((option: Option) => option.group === undefined),
    );
  }
  assert.equal(entityOptions('presets', [{ id: 42, name: 'Style', folderId: 3 }])[0]!.group, 'Writing styles');
  assert.deepEqual(
    entityOptions('characters', [
      { id: 1, name: 'Member', folderId: 1 },
      { id: 2, name: 'Missing folder', folderId: 99 },
    ]).map(({ value, group }: Option) => [value, group]),
    [
      ['2', undefined],
      ['1', 'Characters'],
    ],
  );
});
