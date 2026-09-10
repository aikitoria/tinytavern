import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  ENTITY_FIELDS,
  settingsFields,
  settingsReference,
  settingsCollection,
  settingsText,
  exportSettingsSection,
  importSettingsSection,
} from '@tinytavern/shared';
import { moveCollectionItem } from '../../client/src/state/collectionOrder.ts';

test('section imports validate atomically and retain unrelated draft fields', () => {
  const schema = {
    ...settingsFields(ENTITY_FIELDS.presets),
    'template.reasoningPrefill': settingsText,
  };
  const draft = {
    name: 'Unsaved name',
    content: 'Original',
    apiKey: 'private draft',
    template: { reasoningPrefill: 'Before', messagePrefill: 'Keep' },
  };
  const section = ['content', 'template.reasoningPrefill'];
  assert.deepEqual(exportSettingsSection(schema, section, draft), {
    content: 'Original',
    reasoningPrefill: 'Before',
  });
  const next = importSettingsSection(
    schema,
    section,
    { content: 'Imported', reasoningPrefill: 'After' },
    draft,
  );
  assert.deepEqual(next, {
    ...draft,
    content: 'Imported',
    template: { reasoningPrefill: 'After', messagePrefill: 'Keep' },
  });
  assert.equal(draft.content, 'Original');
  assert.equal(draft.template.reasoningPrefill, 'Before');
  assert.throws(
    () =>
      importSettingsSection(
        schema,
        section,
        { content: 'Would change', reasoningPrefill: false },
        draft,
      ),
    /Expected string/,
  );
  assert.equal(draft.content, 'Original');
  assert.throws(
    () => importSettingsSection(schema, section, { apiKey: 'injected' }, draft),
    /Unknown settings field/,
  );
  assert.throws(
    () =>
      importSettingsSection(schema, section, JSON.parse('{"__proto__":{"polluted":true}}'), draft),
    /Unknown settings field/,
  );
});

test('ordered section collections resolve names to local IDs and preserve unimported entries', () => {
  const local = [
    { id: '42', name: 'Portrait' },
    { id: '43', name: 'Landscape' },
  ];
  const codec = settingsCollection(
    { name: settingsText, workflowId: settingsReference(() => local, false) },
    () => ({ name: '', workflowId: '' }),
  );
  const schema = { shortcuts: codec };
  const items = [
    { id: '1', name: 'First', workflowId: '42' },
    { id: '2', name: 'Second', workflowId: '43' },
    { id: '3', name: 'Keep', workflowId: '42' },
  ];
  const moved = moveCollectionItem(items, '2', -1);
  assert.equal(moved[0], items[1]);
  assert.equal(items[0]!.id, '1');
  assert.equal(moveCollectionItem(moved, '2', -1), moved);
  assert.equal(moveCollectionItem(moved, 'missing', 1), moved);
  const exported = exportSettingsSection(schema, ['shortcuts'], { shortcuts: moved.slice(0, 2) });
  assert.deepEqual(exported, {
    shortcuts: [
      { name: 'Second', workflowId: 'Landscape' },
      { name: 'First', workflowId: 'Portrait' },
    ],
  });
  const imported = importSettingsSection(schema, ['shortcuts'], exported, { shortcuts: items })
    .shortcuts as typeof items;
  assert.deepEqual(
    imported.map((item) => item.id),
    ['2', '1', '3'],
  );
  const added = codec.decode(
    [
      { name: 'New one', workflowId: 'Portrait' },
      { name: 'New two', workflowId: 'Landscape' },
    ],
    items,
  ) as typeof items;
  assert.equal(new Set(added.map((item) => item.id)).size, 5);
  assert.throws(() => codec.decode([{ name: 'Bad', workflowId: '42' }], items), /unavailable/);
  assert.throws(() => codec.decode([{ name: 'Bad', workflowId: null }], items), /unavailable/);
  assert.throws(() => codec.decode([{ name: 'Bad' }], items), /Missing settings field/);
  const duplicates = [
    { id: '1', name: 'Repeated', workflowId: '42' },
    { id: '2', name: 'Repeated', workflowId: '43' },
    { id: '3', name: 'repeated', workflowId: '42' },
  ];
  const portable = codec.encode(duplicates);
  assert.deepEqual(codec.decode(portable, duplicates), duplicates);
  const copied = codec.decode(portable, []) as typeof duplicates;
  assert.equal(new Set(copied.map((item) => item.id)).size, duplicates.length);
  assert.deepEqual(codec.encode(copied), portable);
  assert.deepEqual(
    codec.decode([{ name: 'Repeated', workflowId: 'Landscape' }], duplicates),
    [{ ...duplicates[0], workflowId: '43' }, ...duplicates.slice(1)],
    'An import updates one occurrence and retains other local occurrences',
  );
  const ambiguous = settingsReference(() => [
    { id: 1, name: 'Same' },
    { id: 2, name: 'Same' },
  ]);
  assert.throws(() => ambiguous.decode('Same', null), /ambiguous/);
  assert.throws(() => ambiguous.encode(1), /ambiguous/);
});
