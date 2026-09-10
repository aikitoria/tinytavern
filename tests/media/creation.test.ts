import assert from 'node:assert/strict';
import { newRequestId } from '@tinytavern/shared';
import { databaseCase } from '../support/database.ts';
import { conversationFixture } from '../support/fixtures.ts';
import { createMediaJob } from '../../server/src/media/mediaJobs.ts';
import { requireMediaJob } from '../../server/src/media/mediaJobStore.ts';

databaseCase('variations distinguish explicit defaults from inherited selections', async () => {
  const conversationId = conversationFixture();
  const original = createMediaJob({
    requestKey: newRequestId(),
    workflowId: 'original-workflow',
    presetId: 'original-preset',
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
      workflowId: 'new-workflow',
      presetId: null,
    },
    requireMediaJob(original.id),
  );
  assert.equal(switched.workflowId, 'new-workflow');
  assert.equal(switched.presetId, null);
});
