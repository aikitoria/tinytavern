import { getSettings, putSettings } from '../../server/src/settings/settingsStore.ts';
import assert from 'node:assert/strict';
import { newRequestId } from '@tinytavern/shared';
import { databaseCase } from '../support/database.ts';
import { conversationFixture } from '../support/fixtures.ts';
import { createMediaJob } from '../../server/src/media/mediaJobs.ts';
import { requireMediaJob } from '../../server/src/media/mediaJobStore.ts';

databaseCase('variations distinguish explicit defaults from inherited selections', async () => {
  const settings = getSettings();
  putSettings({
    ...settings,
    mediaChatPrompts: {
      presets: [{ id: 'original-preset', name: 'Original', chatPrompt: 'Prompt' }],
      folders: [],
      defaultPresetId: null,
    },
    mediaRendering: {
      ...settings.mediaRendering,
      workflows: ['original-workflow', 'new-workflow'].map((id) => ({
        id,
        name: id,
        json: '{"output":{"inputs":{}}}',
        inputBindings: {},
        textOutputNodeId: null,
        standalonePromptPresetId: null,
        chatPromptPresetId: null,
      })),
    },
  });
  const stored = getSettings();
  const originalWorkflowId = stored.mediaRendering.workflows.find(
    (item) => item.name === 'original-workflow',
  )!.id;
  const newWorkflowId = stored.mediaRendering.workflows.find(
    (item) => item.name === 'new-workflow',
  )!.id;
  const conversationId = conversationFixture();
  const original = createMediaJob({
    requestKey: newRequestId(),
    workflowId: originalWorkflowId,
    presetId: stored.mediaChatPrompts.presets[0]!.id,
    contextConversationId: conversationId,
    destination: 'chat',
    reviewBeforeSave: true,
  });
  const inherited = createMediaJob({ requestKey: newRequestId() }, requireMediaJob(original.id));
  assert.equal(inherited.presetId, original.presetId);
  assert.equal(inherited.workflowId, original.workflowId);
  assert.equal(inherited.contextConversationId, conversationId);
  const reset = createMediaJob(
    {
      requestKey: newRequestId(),
      workflowId: null,
      presetId: null,
      contextConversationId: null,
      destination: 'gallery',
    },
    requireMediaJob(original.id),
  );
  assert.equal(reset.workflowId, null);
  assert.equal(reset.presetId, null);
  assert.equal(reset.contextConversationId, null);
  const switched = createMediaJob(
    {
      requestKey: newRequestId(),
      workflowId: newWorkflowId,
      presetId: null,
    },
    requireMediaJob(original.id),
  );
  assert.equal(switched.workflowId, newWorkflowId);
  assert.equal(switched.presetId, null);
});
