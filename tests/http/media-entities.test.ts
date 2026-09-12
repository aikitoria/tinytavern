import assert from 'node:assert/strict';
import { newRequestId } from '@tinytavern/shared';
import { databaseCase } from '../support/database.ts';
import { testApi } from '../support/http.ts';
import { stmt } from '../../server/src/db/db.ts';
import { getSettings, putSettings } from '../support/settings.ts';
import { saveMediaRecipe } from '../../server/src/media/mediaRecipes.ts';
import { parseMediaRendering } from '../../server/src/media/mediaSettings.ts';
import { createMediaJob, editMediaJob, startMediaJob } from '../../server/src/media/mediaJobs.ts';
import { requireMediaJob } from '../../server/src/media/mediaJobStore.ts';
import { conversationFixture } from '../support/fixtures.ts';
import '../../server/src/routes/mediaEntities.ts';

const graph = '{"output":{"inputs":{"prompt":"{{prompt}}","seed":0}}}';

databaseCase('media CRUD uses server identities and revision guards without rewriting unrelated entities', async () => {
  const { server, request } = await testApi();
  try {
    const folder = await request('POST', '/api/media_workflow_folders', { name: 'Images' });
    const first = await request('POST', '/api/media_workflows', {
      id: '9000000',
      name: 'Original',
      json: graph,
      folderId: String(folder.id),
    });
    assert.notEqual(String(first.id), '9000000');
    const second = await request('POST', '/api/media_workflows', {
      name: 'Unrelated',
      json: graph,
    });
    const preset = await request('POST', '/api/media_chat_prompts', {
      name: 'Chat preset',
      chatPrompt: 'Describe the scene',
    });
    await request('POST', '/api/media_favorites', {
      name: 'Favorite',
      workflowId: String(first.id),
      presetId: String(preset.id),
    });
    await request('POST', '/api/media_shortcuts', {
      name: 'Shortcut',
      workflowId: String(first.id),
    });
    const before = stmt('SELECT * FROM media_workflows WHERE id = ?').get(second.id);
    const settings = getSettings();
    settings.mediaRendering.defaultWorkflowId = String(first.id);
    putSettings(settings);
    const recipe = saveMediaRecipe(
      {
        comfyUrl: '',
        timeoutSeconds: 60,
        workflowId: String(first.id),
        workflowName: 'Original',
        workflowParameters: [{ label: 'Steps', value: 20 }],
      },
      [],
      'Prompt',
      { seed: 0 },
    );
    const changed = await request('PATCH', `/api/media_workflows/${first.id}`, {
      name: 'Renamed',
      expectedRevision: first.revision,
    });
    assert.deepEqual(stmt('SELECT * FROM media_workflows WHERE id = ?').get(second.id), before);
    await request(
      'PATCH',
      `/api/media_workflows/${first.id}`,
      { name: 'Stale', expectedRevision: first.revision },
      409,
    );
    await request('DELETE', `/api/media_workflow_folders/${folder.id}`, undefined, 204);
    const moved = await request('GET', `/api/media_workflows`);
    const current = moved.find((item: { id: number }) => item.id === first.id);
    assert.equal(current.folderId, null);
    assert(current.revision > changed.revision);
    await request('DELETE', `/api/media_workflows/${first.id}`, { expectedRevision: current.revision }, 204);
    assert.equal(getSettings().mediaRendering.defaultWorkflowId, null);
    assert.deepEqual(getSettings().mediaFavorites, []);
    assert.deepEqual(getSettings().mediaRendering.shortcuts, []);
    const replacement = await request('POST', '/api/media_workflows', {
      id: first.id,
      name: 'Original',
      json: graph,
    });
    assert(replacement.id > second.id);
    assert.deepEqual(stmt('SELECT workflow_id FROM media_recipes WHERE id = ?').get(recipe), {
      workflow_id: first.id,
    });
    const snapshot = JSON.parse(
      String(stmt('SELECT configuration_json FROM media_recipes WHERE id = ?').get(recipe)!.configuration_json),
    );
    assert.equal(snapshot.workflowName, 'Original');
    assert.deepEqual(snapshot.workflowParameters, [{ label: 'Steps', value: 20 }]);
    assert.throws(() => stmt('UPDATE media_recipes SET workflow_id = 999999 WHERE id = ?').run(recipe), /FOREIGN KEY/);
    const text = await request('POST', '/api/media_workflows', {
      name: 'Text',
      json: graph,
      textOutputNodeId: 'output',
    });
    assert.equal(text.textOutputNodeId, 'output');
    const stored = JSON.parse(String(stmt("SELECT value FROM settings WHERE key = 'app'").get()!.value));
    assert.equal(stored.mediaRendering.workflows, undefined);
    assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
  } finally {
    await server.stop(true);
  }
});

databaseCase('workflow edits preserve every selected workflow requirement', async () => {
  const { server, request } = await testApi();
  try {
    const workflow = await request('POST', '/api/media_workflows', {
      name: 'Description',
      json: graph,
      textOutputNodeId: 'output',
    });
    for (const purpose of ['default', 'avatar', 'description'] as const) {
      const settings = getSettings();
      settings.mediaRendering[`${purpose}WorkflowId`] = String(workflow.id);
      putSettings(settings);
      const response = await request(
        'PATCH',
        `/api/media_workflows/${workflow.id}`,
        {
          json: '',
          expectedRevision: workflow.revision,
        },
        400,
      );
      assert.match(response.error, /Choose a configured/);
      settings.mediaRendering[`${purpose}WorkflowId`] = null;
      putSettings(settings);
    }
    const settings = getSettings();
    settings.mediaRendering.descriptionWorkflowId = String(workflow.id);
    putSettings(settings);
    const before = getSettings();
    const response = await request(
      'PATCH',
      `/api/media_workflows/${workflow.id}`,
      {
        textOutputNodeId: null,
        expectedRevision: workflow.revision,
      },
      400,
    );
    assert.match(response.error, /text output binding/);
    assert.deepEqual(getSettings(), before, 'Rejected updates must leave rows and revisions unchanged');
    assert.doesNotThrow(() => parseMediaRendering(getSettings().mediaRendering));
    settings.mediaRendering.descriptionWorkflowId = null;
    putSettings(settings);
    const shortcut = await request('POST', '/api/media_shortcuts', {
      name: 'Describe',
      workflowId: String(workflow.id),
    });
    await request(
      'PATCH',
      `/api/media_workflows/${workflow.id}`,
      {
        json: '',
        expectedRevision: workflow.revision,
      },
      400,
    );
    await request(
      'DELETE',
      `/api/media_shortcuts/${shortcut.id}`,
      {
        expectedRevision: shortcut.revision,
      },
      204,
    );
    await request('PATCH', `/api/media_workflows/${workflow.id}`, {
      json: '',
      textOutputNodeId: null,
      expectedRevision: workflow.revision,
    });
    await request(
      'POST',
      '/api/media_shortcuts',
      {
        name: 'Unconfigured',
        workflowId: String(workflow.id),
      },
      400,
    );
  } finally {
    await server.stop(true);
  }
});

databaseCase('deleted presets do not block captured prompts while new selections remain validated', async () => {
  const { server, request } = await testApi();
  try {
    const workflow = await request('POST', '/api/media_workflows', {
      name: 'Render',
      json: graph,
    });
    for (const chat of [false, true]) {
      const table = chat ? 'media_chat_prompts' : 'media_standalone_prompts';
      const preset = await request('POST', `/api/${table}`, {
        name: 'Old preset',
        chatPrompt: 'Describe the scene',
        userMessage: 'Describe the scene',
      });
      const contextConversationId = chat ? conversationFixture() : null;
      const job = createMediaJob({
        requestKey: newRequestId(),
        workflowId: String(workflow.id),
        presetId: String(preset.id),
        prompt: 'An already captured prompt',
        contextConversationId,
      });
      await request(
        'DELETE',
        `/api/${table}/${preset.id}`,
        {
          expectedRevision: preset.revision,
        },
        204,
      );
      const historical = requireMediaJob(job.id);
      const variation = createMediaJob({ requestKey: newRequestId() }, historical);
      assert.equal(variation.presetId, null);
      assert.equal(variation.prompt, job.prompt);
      assert.equal(
        requireMediaJob(job.id).preset_id,
        String(preset.id),
        'Creating a variation must preserve its source history',
      );
      const edited = editMediaJob(historical, { seedOverride: 42, presetId: String(preset.id) });
      assert.equal(edited.presetId, null);
      assert.equal(edited.prompt, job.prompt);
      assert.throws(
        () =>
          createMediaJob({
            requestKey: newRequestId(),
            presetId: String(preset.id),
            contextConversationId,
          }),
        /preset is unavailable/,
      );
      assert.throws(
        () =>
          editMediaJob(requireMediaJob(job.id), {
            presetId: String(preset.id),
          }),
        /preset is unavailable/,
      );
      const rendering = startMediaJob(requireMediaJob(job.id), {}, false);
      assert.equal(rendering.seed, 42);
      assert.equal(rendering.prompt, job.prompt);
    }
  } finally {
    await server.stop(true);
  }
});

databaseCase(
  'settings batches allocate explicit IDs and roll back invalid rows without touching unrelated libraries',
  async () => {
    await import('../../server/src/routes/settings.ts');
    const { server, request } = await testApi();
    try {
      const unrelated = await request('POST', '/api/media_workflows', { name: 'Unrelated', json: graph });
      const before = stmt('SELECT * FROM media_workflows WHERE id = ?').get(unrelated.id);
      const saved = await request('PUT', '/api/settings', {
        expectedRevision: getSettings().revision,
        mediaChanges: [
          { table: 'media_workflow_folders', id: 'new-folder', create: true, fields: { name: 'Batch' } },
          {
            table: 'media_workflows',
            id: 'new-workflow',
            create: true,
            fields: {
              name: 'Batch workflow',
              json: graph,
              folderId: 'new-folder',
            },
          },
          {
            table: 'media_shortcuts',
            id: 'first',
            create: true,
            fields: {
              name: 'Render',
              workflowId: 'new-workflow',
              position: 0,
            },
          },
          {
            table: 'media_shortcuts',
            id: 'second',
            create: true,
            fields: {
              name: 'Render',
              workflowId: 'new-workflow',
              position: 1,
            },
          },
        ],
        mediaRendering: { defaultWorkflowId: 'new-workflow' },
      });
      const workflowId = saved.assigned.media_workflows['new-workflow'];
      assert.equal(saved.settings.mediaRendering.defaultWorkflowId, workflowId);
      assert.notEqual(saved.assigned.media_shortcuts.first, saved.assigned.media_shortcuts.second);
      assert.equal(
        stmt('SELECT folder_id FROM media_workflows WHERE id = ?').get(workflowId)!.folder_id,
        Number(saved.assigned.media_workflow_folders['new-folder']),
      );
      assert.deepEqual(stmt('SELECT * FROM media_workflows WHERE id = ?').get(unrelated.id), before);
      const snapshot = getSettings();
      await request(
        'PUT',
        '/api/settings',
        {
          expectedRevision: snapshot.revision,
          mediaChanges: [
            { table: 'media_workflows', id: workflowId, revision: 0, fields: { name: 'Rolled back' } },
            {
              table: 'media_shortcuts',
              id: 'invalid',
              create: true,
              fields: { name: 'Invalid', workflowId: 'missing' },
            },
          ],
        },
        400,
      );
      assert.deepEqual(
        getSettings(),
        snapshot,
        'A later validation error rolls back every prior row and cached projection',
      );
      await request(
        'PUT',
        '/api/settings',
        {
          expectedRevision: snapshot.revision,
          mediaChanges: [{ table: 'media_workflows', id: workflowId, revision: -1, fields: { name: 'Stale' } }],
        },
        409,
      );
      stmt(`CREATE TRIGGER reject_library_write BEFORE UPDATE ON media_workflows
      BEGIN SELECT RAISE(ABORT, 'Scalar save touched a workflow'); END`).run();
      try {
        await request('PUT', '/api/settings', {
          expectedRevision: snapshot.revision,
          galleryThumbnailSize: 256,
        });
      } finally {
        stmt('DROP TRIGGER reject_library_write').run();
      }
      assert.deepEqual(stmt('SELECT * FROM media_workflows WHERE id = ?').get(unrelated.id), before);
    } finally {
      server.stop(true);
    }
  },
);

databaseCase(
  'settings batches retarget retained shortcuts and favorites before deleting obsolete dependencies',
  async () => {
    await import('../../server/src/routes/settings.ts');
    const { server, request } = await testApi();
    try {
      const workflow = await request('POST', '/api/media_workflows', { name: 'Replace workflow', json: graph });
      const preset = await request('POST', '/api/media_chat_prompts', {
        name: 'Replace preset',
        chatPrompt: 'Describe the scene',
      });
      const shortcut = await request('POST', '/api/media_shortcuts', {
        name: 'Retain shortcut',
        workflowId: String(workflow.id),
      });
      const favorite = await request('POST', '/api/media_favorites', {
        name: 'Retain favorite',
        workflowId: String(workflow.id),
        presetId: String(preset.id),
      });
      await request('POST', '/api/media_shortcuts', {
        name: 'Remove shortcut',
        workflowId: String(workflow.id),
      });
      await request('POST', '/api/media_favorites', {
        name: 'Remove favorite',
        workflowId: String(workflow.id),
        presetId: String(preset.id),
      });
      const snapshot = getSettings();
      const changes = [
        { table: 'media_workflows', id: String(workflow.id), revision: workflow.revision, fields: null },
        { table: 'media_chat_prompts', id: String(preset.id), revision: preset.revision, fields: null },
        {
          table: 'media_workflows',
          id: 'replacement-workflow',
          create: true,
          fields: { name: workflow.name, json: graph },
        },
        {
          table: 'media_chat_prompts',
          id: 'replacement-preset',
          create: true,
          fields: { name: preset.name, chatPrompt: 'New instruction' },
        },
        {
          table: 'media_shortcuts',
          id: String(shortcut.id),
          revision: shortcut.revision,
          fields: { workflowId: 'replacement-workflow' },
        },
        {
          table: 'media_favorites',
          id: String(favorite.id),
          revision: favorite.revision,
          fields: { workflowId: 'replacement-workflow', presetId: 'replacement-preset' },
        },
      ];
      await request(
        'PUT',
        '/api/settings',
        { expectedRevision: snapshot.revision, mediaChanges: changes, galleryThumbnailSize: -1 },
        400,
      );
      assert.deepEqual(getSettings(), snapshot, 'A later failure restores both deleted and retargeted rows');
      const saved = await request('PUT', '/api/settings', {
        expectedRevision: snapshot.revision,
        mediaChanges: changes,
        mediaRendering: { defaultWorkflowId: 'replacement-workflow' },
        mediaChatPrompts: { defaultPresetId: 'replacement-preset' },
      });
      const workflowId = saved.assigned.media_workflows['replacement-workflow'];
      const presetId = saved.assigned.media_chat_prompts['replacement-preset'];
      assert.equal(saved.settings.mediaRendering.defaultWorkflowId, workflowId);
      assert.equal(saved.settings.mediaChatPrompts.defaultPresetId, presetId);
      assert.deepEqual(
        saved.settings.mediaRendering.shortcuts.map((item: { id: string; workflowId: string }) => ({
          id: item.id,
          workflowId: item.workflowId,
        })),
        [{ id: String(shortcut.id), workflowId }],
      );
      assert.deepEqual(
        saved.settings.mediaFavorites.map((item: { id: string; workflowId: string; presetId: string }) => ({
          id: item.id,
          workflowId: item.workflowId,
          presetId: item.presetId,
        })),
        [{ id: String(favorite.id), workflowId, presetId }],
      );
      assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
    } finally {
      server.stop(true);
    }
  },
);

databaseCase(
  'settings refresh transmits only changed native collections and versions roll back atomically',
  async () => {
    await import('../../server/src/routes/settings.ts');
    const { server, request } = await testApi();
    try {
      const initial = await request('GET', '/api/settings/snapshot');
      const query = () => new URLSearchParams({ epoch: initial.epoch, versions: JSON.stringify(initial.versions) });
      const scalar = await request('PUT', `/api/settings?snapshot=1&${query()}`, {
        expectedRevision: initial.preferences.revision,
        galleryThumbnailSize: 256,
      });
      assert.equal(scalar.settings, undefined, 'Normal saves return the same delta contract as reads');
      assert.deepEqual(scalar.collections, {}, 'A scalar change does not transfer any library');
      assert.equal(scalar.preferences.galleryThumbnailSize, 256);
      const folder = await request('POST', '/api/media_workflow_folders', { name: 'Only this folder collection' });
      const changed = await request('GET', `/api/settings/snapshot?${query()}`);
      assert.deepEqual(Object.keys(changed.collections), ['media_workflow_folders']);
      assert.equal(changed.collections.media_workflow_folders[0].id, String(folder.id));
      const wrongEpoch = await request(
        'GET',
        `/api/settings/snapshot?epoch=old&versions=${encodeURIComponent(JSON.stringify(changed.versions))}`,
      );
      assert.equal(Object.keys(wrongEpoch.collections).length, Object.keys(initial.collections).length);
      await request(
        'PUT',
        '/api/settings',
        {
          expectedRevision: getSettings().revision,
          mediaChanges: [
            {
              table: 'media_chat_prompts',
              id: 'new',
              create: true,
              fields: { name: 'Rollback', chatPrompt: 'Prompt' },
            },
          ],
          galleryThumbnailSize: -1,
        },
        400,
      );
      const after = await request('GET', '/api/settings/snapshot');
      assert.deepEqual(after.versions, changed.versions, 'Rejected batches roll back collection versions too');
      assert.deepEqual(after.collections.media_chat_prompts, initial.collections.media_chat_prompts);
      const saved = await request(
        'PUT',
        `/api/settings?snapshot=1&epoch=${after.epoch}&versions=${encodeURIComponent(JSON.stringify(after.versions))}`,
        {
          expectedRevision: after.preferences.revision,
          mediaChanges: [
            {
              table: 'media_chat_prompts',
              id: 'new',
              create: true,
              fields: { name: 'Assigned', chatPrompt: 'Prompt' },
            },
          ],
          mediaChatPrompts: { defaultPresetId: 'new' },
        },
      );
      assert.deepEqual(Object.keys(saved.collections), ['media_chat_prompts']);
      const assignedId = saved.assigned.media_chat_prompts.new;
      assert.equal(saved.collections.media_chat_prompts[0].id, assignedId);
      assert.equal(saved.preferences.mediaChatPrompts.defaultPresetId, assignedId);
      await request(
        'PUT',
        `/api/settings?snapshot=1&epoch=${after.epoch}&versions=invalid`,
        {
          expectedRevision: saved.preferences.revision,
          galleryThumbnailSize: 512,
        },
        400,
      );
      assert.equal(
        getSettings().galleryThumbnailSize,
        256,
        'Invalid snapshot metadata rejects the save before mutation',
      );
    } finally {
      server.stop(true);
    }
  },
);
