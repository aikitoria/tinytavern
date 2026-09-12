import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
import { createRoot, createSignal } from 'solid-js';
import { DEFAULT_SETTINGS, type Settings, type MediaSettingsChange } from '@tinytavern/shared';
import type { SettingsSectionActions } from '../../client/src/state/settingsSubmission.ts';

test('generation sections share validation, revision guards and edits made during saving', async () => {
  const clone = <T>(value: T): T => structuredClone(value);
  const [settings, setSettings] = createSignal(clone(DEFAULT_SETTINGS));
  let guard!: SettingsSectionActions;
  let request: (Partial<Settings> & { mediaChanges: MediaSettingsChange[] }) | undefined;
  let resolve!: (value: Settings) => void;
  let submittedRevision = -1;
  mock.module('../../client/src/state/store.ts', () => ({
    state: {
      get settings() {
        return settings();
      },
    },
    applySettings: (value: Settings) => setSettings(value),
  }));
  mock.module('../../client/src/state/api.ts', () => ({
    api: {
      saveMediaSettings: (value: Partial<Settings> & { mediaChanges: MediaSettingsChange[] }, revision: number) => {
        request = clone(value);
        submittedRevision = revision;
        if (revision !== settings().revision)
          return Promise.reject(Object.assign(new Error('Settings changed'), { status: 409 }));
        return new Promise<{ settings: Settings; assigned: {} }>((done) => {
          resolve = (settings) => done({ settings, assigned: {} });
        });
      },
    },
  }));
  mock.module('../../client/src/util.ts', () => ({
    createSavedFlash: () => [() => false, () => {}],
  }));
  mock.module('../../client/src/components/settings/SettingsGuard.tsx', () => ({
    useSettingsGuard: (actions: SettingsSectionActions) => {
      guard = actions;
    },
  }));
  mock.module('../../client/src/components/settings/SettingsActions.tsx', () => ({
    default: () => null,
  }));
  mock.module('../../client/src/components/settings/SettingsTransferButtons.tsx', () => ({
    default: () => null,
  }));
  // Only the draft controller is exercised; action components stay unmounted.
  mock.module('react/jsx-dev-runtime', () => ({
    jsxDEV: () => {
      throw new Error('Unexpected JSX rendering');
    },
    Fragment: Symbol('Fragment'),
  }));
  const path = '../../client/src/components/settings/tabs/mediaSettingsDraft.tsx';
  const { mediaSettingsDraft } = await import(path);
  let dispose!: () => void;
  let fields = clone(settings().imageGeneration);
  let invalid = false;
  const form = createRoot((cleanup) => {
    dispose = cleanup;
    const form = mediaSettingsDraft();
    form.setImageFields({
      get value() {
        return fields;
      },
      set value(value: Settings['imageGeneration']) {
        fields = clone(value);
      },
      validate() {
        if (invalid) throw new Error('Invalid revision template');
      },
    });
    return form;
  });
  try {
    assert.equal(guard.isDirty(), false);
    form.setDraft((current: Settings['mediaRendering']) => ({
      ...current,
      jobTimeoutSeconds: 120,
    }));
    form.setFavorites(() => [{ id: 'favorite', name: 'Portrait', presetId: 'prompt', workflowId: 'workflow' }]);
    fields = { ...fields, promptRevisionTemplate: 'Before saving: {{instruction}}' };
    // A section import enters the same draft without dropping edits in another section.
    form.writeDraft({
      ...form.readDraft(),
      mediaRendering: { ...form.draft(), comfyUrl: 'http://imported' },
    });
    assert.equal(fields.promptRevisionTemplate, 'Before saving: {{instruction}}');
    assert.equal(form.favorites()[0]!.name, 'Portrait');
    setSettings((current) => ({
      ...current,
      revision: current.revision + 1,
      mediaRendering: {
        ...current.mediaRendering,
        workflows: [
          {
            id: 'workflow',
            name: 'Edited in child',
            revision: 0,
            folderId: null,
            json: '{}',
            inputBindings: {},
            textOutputNodeId: null,
            chatPromptPresetId: null,
            standalonePromptPresetId: null,
          },
        ],
      },
    }));
    assert.equal(form.draft().workflows[0]!.name, 'Edited in child');
    assert.equal(form.draft().jobTimeoutSeconds, 120);
    assert.equal(form.favorites()[0]!.name, 'Portrait');
    invalid = true;
    assert.equal(await guard.save(), false);
    assert.equal(request == null, true, 'Any invalid section prevents the entire submission');
    invalid = false;
    form.setDraft((current: Settings['mediaRendering']) => ({
      ...current,
      workflows: current.workflows.map((item: import('@tinytavern/shared').MediaWorkflow) => ({
        ...item,
        name: 'Renamed by generation import',
      })),
    }));
    const saving = guard.save();
    assert.equal(request!.mediaRendering!.jobTimeoutSeconds, 120);
    assert.equal(request!.mediaRendering!.comfyUrl, 'http://imported');
    assert.equal(request!.mediaChanges.find((change) => change.table === 'media_favorites')!.fields!.name, 'Portrait');
    assert.equal(request!.imageGeneration!.promptRevisionTemplate, fields.promptRevisionTemplate);
    assert.equal(submittedRevision, settings().revision);
    const submitted = clone(form.readDraft());
    fields = { ...fields, promptRevisionTemplate: 'Edited during save: {{instruction}}' };
    resolve({
      ...settings(),
      ...submitted,
      revision: settings().revision + 1,
      mediaRendering: {
        ...submitted.mediaRendering,
        workflows: submitted.mediaRendering.workflows.map((item: import('@tinytavern/shared').MediaWorkflow) => ({
          ...item,
          revision: 1,
          folderId: null,
        })),
      },
    });
    assert.equal(await saving, false, 'New edits keep the page guarded after the response');
    assert.equal(guard.isDirty(), true);
    assert.match(fields.promptRevisionTemplate, /Edited during save/);
    setSettings((current) => ({
      ...current,
      revision: current.revision + 1,
      mediaRendering: {
        ...current.mediaRendering,
        workflows: current.mediaRendering.workflows.map((item: import('@tinytavern/shared').MediaWorkflow) => ({
          ...item,
          name: 'Renamed in child',
          revision: 2,
        })),
      },
    }));
    assert.equal(
      form.draft().workflows[0]!.name,
      'Renamed in child',
      'A remote workflow rename must merge with unrelated edits made during saving',
    );
    guard.discard();
    assert.equal(guard.isDirty(), false);
    assert.match(fields.promptRevisionTemplate, /Before saving/);
    assert.equal(form.favorites()[0]!.name, 'Portrait');
    form.setDraft((current: Settings['mediaRendering']) => ({
      ...current,
      jobTimeoutSeconds: 180,
    }));
    const baselineRevision = settings().revision;
    setSettings((current) => ({
      ...current,
      revision: current.revision + 1,
      mediaRendering: { ...current.mediaRendering, jobTimeoutSeconds: 240 },
    }));
    assert.equal(await guard.save(), false, 'Overlapping edits still require conflict resolution');
    assert.equal(submittedRevision, baselineRevision);
    assert.equal(form.draft().jobTimeoutSeconds, 180);
  } finally {
    dispose();
  }
});
