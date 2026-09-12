import assert from 'node:assert/strict';
import { newRequestId } from '@tinytavern/shared';
import { databaseCase } from '../support/database.ts';
import { testApi } from '../support/http.ts';
import { stmt } from '../../server/src/db/db.ts';
import { getSettings, putSettings } from '../../server/src/settings/settingsStore.ts';
import { saveMediaRecipe } from '../../server/src/media/mediaRecipes.ts';
import { parseMediaRendering } from '../../server/src/media/mediaSettings.ts';
import { createMediaJob, editMediaJob, startMediaJob } from '../../server/src/media/mediaJobs.ts';
import { requireMediaJob } from '../../server/src/media/mediaJobStore.ts';
import { conversationFixture } from '../support/fixtures.ts';
import '../../server/src/routes/mediaEntities.ts';

const graph = '{"output":{"inputs":{"prompt":"{{prompt}}","seed":0}}}';

databaseCase(
  'media CRUD uses server identities and revision guards without rewriting unrelated entities',
  async () => {
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
      await request(
        'DELETE',
        `/api/media_workflows/${first.id}`,
        { expectedRevision: current.revision },
        204,
      );
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
        String(
          stmt('SELECT configuration_json FROM media_recipes WHERE id = ?').get(recipe)!
            .configuration_json,
        ),
      );
      assert.equal(snapshot.workflowName, 'Original');
      assert.deepEqual(snapshot.workflowParameters, [{ label: 'Steps', value: 20 }]);
      assert.throws(
        () => stmt('UPDATE media_recipes SET workflow_id = 999999 WHERE id = ?').run(recipe),
        /FOREIGN KEY/,
      );
      const text = await request('POST', '/api/media_workflows', {
        name: 'Text',
        json: graph,
        textOutputNodeId: 'output',
      });
      assert.equal(text.textOutputNodeId, 'output');
      const stored = JSON.parse(
        String(stmt("SELECT value FROM settings WHERE key = 'app'").get()!.value),
      );
      assert.equal(stored.mediaRendering.workflows, undefined);
      assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
    } finally {
      await server.stop(true);
    }
  },
);

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
    assert.deepEqual(
      getSettings(),
      before,
      'Rejected updates must leave rows and revisions unchanged',
    );
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

databaseCase(
  'deleted presets do not block captured prompts while new selections remain validated',
  async () => {
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
  },
);
