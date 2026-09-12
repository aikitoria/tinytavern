import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
import { DEFAULT_SETTINGS, type MediaWorkflow, type Settings } from '@tinytavern/shared';
import { reconcileMediaDraft } from '../../client/src/state/mediaDraftIds.ts';

const workflow: MediaWorkflow = {
  id: 'draft-1',
  name: 'Workflow',
  json: '',
  inputBindings: {},
  standalonePromptPresetId: null,
  chatPromptPresetId: null,
  textOutputNodeId: null,
  folderId: null,
  revision: 2,
};

test('assigned IDs reach in-flight edits and every dependent generation draft reference', () => {
  const submitted = structuredClone(DEFAULT_SETTINGS);
  submitted.mediaRendering.workflows = [workflow];
  submitted.mediaRendering.folders = [
    { id: 'folder-draft', name: 'Folder', workflowIds: [workflow.id] },
  ];
  submitted.mediaRendering.shortcuts = [
    { id: 'shortcut-draft', name: 'Shortcut', workflowId: workflow.id },
  ];
  submitted.mediaFavorites = [
    { id: 'favorite-draft', name: 'Favorite', workflowId: workflow.id, presetId: '3' },
  ];
  submitted.mediaRendering.defaultWorkflowId = workflow.id;
  submitted.imageGeneration.promptPresets = {
    avatar: {
      presets: [{ id: 'avatar-draft', name: 'Portrait', prompt: 'Original', context: '' }],
      active: 'Portrait',
      activeId: 'avatar-draft',
    },
  };
  const saved = structuredClone(submitted);
  saved.mediaRendering.workflows[0]!.id = '21';
  saved.mediaRendering.workflows[0]!.revision = 3;
  saved.mediaRendering.workflows[0]!.folderId = '22';
  saved.mediaRendering.defaultWorkflowId = '21';
  saved.mediaRendering.folders[0]!.workflowIds = ['21'];
  saved.mediaRendering.shortcuts[0]!.workflowId = '21';
  saved.mediaFavorites[0]!.workflowId = '21';
  saved.imageGeneration.promptPresets!.avatar!.activeId = '25';
  saved.mediaRendering.folders[0]!.id = '22';
  saved.mediaRendering.shortcuts[0]!.id = '23';
  saved.mediaFavorites[0]!.id = '24';
  saved.imageGeneration.promptPresets!.avatar!.presets[0]!.id = '25';
  const current = structuredClone(submitted);
  current.mediaRendering.workflows[0]!.name = 'Renamed while saving';
  current.imageGeneration.promptPresets!.avatar!.presets[0]!.prompt = 'Edited while saving';
  const adopted = reconcileMediaDraft(current, submitted, saved);
  assert.equal(adopted.mediaRendering.workflows[0]!.id, '21');
  assert.equal(adopted.mediaRendering.workflows[0]!.revision, 3);
  assert.equal(adopted.mediaRendering.workflows[0]!.folderId, '22');
  assert.equal(adopted.mediaRendering.workflows[0]!.name, 'Renamed while saving');
  assert.equal(adopted.mediaRendering.defaultWorkflowId, '21');
  assert.deepEqual(adopted.mediaRendering.folders[0], {
    id: '22',
    name: 'Folder',
    workflowIds: ['21'],
  });
  assert.equal(adopted.mediaRendering.shortcuts[0]!.workflowId, '21');
  assert.equal(adopted.mediaFavorites[0]!.workflowId, '21');
  assert.equal(adopted.imageGeneration.promptPresets!.avatar!.activeId, '25');
  assert.equal(
    adopted.imageGeneration.promptPresets!.avatar!.presets[0]!.prompt,
    'Edited while saving',
  );
  assert.equal(submitted.mediaRendering.workflows[0]!.id, 'draft-1');
});

test('entity saves use the draft revision and fetch intervening settings changes', async () => {
  let settings = structuredClone(DEFAULT_SETTINGS);
  settings.mediaRendering.workflows = [{ ...workflow, id: '1', revision: 5 }];
  let sent: Record<string, unknown> | undefined;
  let refreshes = 0;
  mock.module('../../client/src/state/store.ts', () => ({
    state: {
      get settings() {
        return settings;
      },
    },
    applySettings(value: Settings) {
      settings = value;
    },
  }));
  mock.module('../../client/src/state/api.ts', () => ({
    api: {
      async mediaEntity(
        _table: string,
        _method: string,
        _id: string,
        body: Record<string, unknown>,
      ) {
        sent = body;
        return {
          ...settings.mediaRendering.workflows[0],
          ...body,
          id: 1,
          revision: 6,
          settingsRevision: settings.revision + 2,
        };
      },
      async settings() {
        refreshes++;
        return { ...settings, revision: settings.revision + 2, galleryThumbnailSize: 320 };
      },
    },
  }));
  const path = '../../client/src/state/mediaEntityEditor.ts';
  const { mediaEntityEditor } = await import(path);
  const editor = mediaEntityEditor('workflows', () =>
    settings.mediaRendering.workflows.map((item) => ({ ...item, folderId: null })),
  );
  await editor.patch('1', { name: 'Draft edit', revision: 2 });
  assert.equal(
    sent!.expectedRevision,
    2,
    'A newer store row cannot authorize overwriting the older draft',
  );
  assert.equal(
    refreshes,
    1,
    'A response that skips a settings revision requires fetching intervening changes',
  );
  assert.equal(settings.galleryThumbnailSize, 320);
});

test('same-name shortcuts keep distinct assigned IDs across edits, deletion and insertion during save', () => {
  const submitted = structuredClone(DEFAULT_SETTINGS);
  submitted.mediaRendering.shortcuts = [
    { id: '1', name: 'Render', workflowId: '10' },
    { id: '2', name: 'Render', workflowId: '11' },
  ];
  const saved = structuredClone(submitted);
  saved.mediaRendering.shortcuts = [
    { ...submitted.mediaRendering.shortcuts[0]!, id: '2', revision: 1 },
    { ...submitted.mediaRendering.shortcuts[1]!, id: '3', revision: 1 },
  ];
  const current = structuredClone(submitted);
  current.mediaRendering.jobTimeoutSeconds = 180;
  let result = reconcileMediaDraft(current, submitted, saved);
  assert.deepEqual(result.mediaRendering.shortcuts, saved.mediaRendering.shortcuts);
  current.mediaRendering.shortcuts = [
    { ...submitted.mediaRendering.shortcuts[1]!, name: 'Edited during save' },
    { id: 'new-draft', name: 'New shortcut', workflowId: '10' },
  ];
  result = reconcileMediaDraft(current, submitted, saved);
  assert.deepEqual(result.mediaRendering.shortcuts, [
    { ...saved.mediaRendering.shortcuts[1]!, name: 'Edited during save' },
    current.mediaRendering.shortcuts[1],
  ]);
});
