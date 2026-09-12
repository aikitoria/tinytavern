import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { insertFixture } from '../support/fixtures.ts';
import { newRequestId, type MediaWorkflow } from '@tinytavern/shared';

test('media conversations preserve complete prompt branches, captured templates and render provenance', async () => {
  const { stmt } = await import('../../server/src/db/db.ts');
  const { getSettings, putSettings } = await import('../support/settings.ts');
  const { createMediaJob, startMediaJob, deleteMediaJob } = await import('../../server/src/media/mediaJobs.ts');
  const { startMediaConversation } = await import('../../server/src/media/mediaConversations.ts');
  const { requireMediaJob, mediaDraft } = await import('../../server/src/media/mediaJobStore.ts');
  const { finishMediaJob } = await import('../../server/src/media/mediaJobResults.ts');
  const { getConversation } = await import('../../server/src/conversations/conversationStore.ts');
  const { appendMessage, getActivePath, activateMessage } = await import('../../server/src/conversations/tree.ts');
  const { buildChatMessages } = await import('../../server/src/generation/prompt.ts');
  const { copyConversation } = await import('../../server/src/conversations/conversationCopies.ts');
  const { exportPortableConversation, importPortableConversation } =
    await import('../../server/src/routes/conversationTransfer.ts');
  const endpoint = insertFixture('endpoints', {
    name: 'Media',
    base_url: 'http://unused.invalid',
    created_at: 1,
  });
  const template = insertFixture('templates', {
    name: 'Wrong template',
    content: 'NEVER INCLUDE GLOBAL CHAT TEMPLATE',
    prefix_names: 1,
    created_at: 1,
  });
  const workflow: MediaWorkflow = {
    id: 'media-conversation',
    name: 'Video prompt',
    inputBindings: {},
    textOutputNodeId: null,
    json: '{"1":{"inputs":{"prompt":"{{prompt}}","seed":0}}}',
    standalonePromptPresetId: 'media-preset',
    chatPromptPresetId: null,
  };
  putSettings({
    ...getSettings(),
    activeEndpointId: endpoint,
    defaultTemplateId: template,
    mediaRendering: {
      ...getSettings().mediaRendering,
      workflows: [workflow],
      defaultWorkflowId: workflow.id,
    },
    mediaStandalonePrompts: {
      folders: [],
      defaultPresetId: null,
      presets: [
        {
          id: 'media-preset',
          name: 'Media',
          systemPrompt: 'Write video prompts. {{workflow}}',
          userMessage: 'Task: {{instruction}}',
          reasoningPrefill: 'Media reasoning',
          messagePrefill: 'Scene: ',
        },
      ],
    },
  });
  const job = createMediaJob({
    requestKey: newRequestId(),
    workflowId: workflow.id,
    instruction: 'Slow camera',
    prompt: 'First prompt',
    reviewBeforeSave: true,
  });
  const conversation = startMediaConversation(requireMediaJob(job.id), {
    expectedDraftRevision: job.draft!.revision,
  });
  assert.equal(conversation.promptMode, 'media');
  assert.equal(mediaDraft(job.draft!.id).conversationId, conversation.id);
  assert.equal(
    startMediaConversation(requireMediaJob(job.id), {}).id,
    conversation.id,
    'Repeated starts allocate only one tree',
  );
  const initial = getActivePath(conversation.id);
  assert.deepEqual(
    initial.map((m) => m.content),
    ['Task: Slow camera', 'First prompt'],
  );
  const original = initial[1]!;
  const followup = appendMessage(conversation.id, 'user', 'Less head movement', original.id);
  const revised = appendMessage(conversation.id, 'assistant', 'Keep her head still', followup.id);
  const alternate = appendMessage(conversation.id, 'assistant', 'Alternate camera', initial[0]!.id);
  activateMessage(original.id);
  assert.equal(
    getConversation(conversation.id).activeLeafId,
    revised.id,
    'Returning to an old swipe restores its full descendant branch',
  );
  const built = buildChatMessages(getConversation(conversation.id), getActivePath(conversation.id));
  assert.deepEqual(
    built.messages.map((m) => m.content),
    [
      'Write video prompts. Video prompt',
      'Task: Slow camera',
      'First prompt',
      'Less head movement',
      'Keep her head still',
    ],
  );
  assert.equal(built.reasoningPrefill, 'Media reasoning');
  assert.equal(built.messagePrefill, 'Scene: ');
  assert.equal(built.namePrefill, null);
  putSettings({
    ...getSettings(),
    mediaStandalonePrompts: { folders: [], presets: [], defaultPresetId: null },
  });
  assert.deepEqual(
    buildChatMessages(getConversation(conversation.id), getActivePath(conversation.id)),
    built,
    'Later preset changes do not rewrite a conversation prefix',
  );

  const renderGuard = {
    promptMessageId: revised.id,
    expectedPromptLeafId: revised.id,
    expectedPromptRevision: getConversation(conversation.id).mutationRevision,
  };
  assert.throws(() => startMediaJob(requireMediaJob(job.id), { ...renderGuard, expectedPromptRevision: 0 }, false), {
    status: 409,
  });
  startMediaJob(requireMediaJob(job.id), renderGuard, false);
  assert.equal(requireMediaJob(job.id).prompt, revised.content);
  assert.equal(requireMediaJob(job.id).prompt_message_id, revised.id);
  activateMessage(alternate.id);
  stmt('UPDATE messages SET content = ? WHERE id = ?').run('Edited later', revised.id);
  assert.equal(
    requireMediaJob(job.id).prompt,
    'Keep her head still',
    'Render snapshot survives edits and branch switching',
  );
  const variation = createMediaJob({ requestKey: newRequestId(), prompt: 'Next render' }, requireMediaJob(job.id));
  assert.equal(variation.draft?.conversationId, conversation.id);
  const codeReply = appendMessage(
    conversation.id,
    'assistant',
    'Use this scene:\n> ```text\n> Blue sky\n> Still camera\n> ```\nExtra explanation.',
    alternate.id,
  );
  const excerptGuard = {
    promptMessageId: codeReply.id,
    promptExcerpt: 'Blue sky\nStill camera',
    expectedPromptLeafId: getConversation(conversation.id).activeLeafId,
    expectedPromptRevision: getConversation(conversation.id).mutationRevision,
  };
  assert.throws(
    () => startMediaJob(requireMediaJob(variation.id), { ...excerptGuard, promptExcerpt: 'Unrelated text' }, false),
    { status: 409 },
  );
  startMediaJob(requireMediaJob(variation.id), excerptGuard, false);
  activateMessage(alternate.id);
  const inherited = createMediaJob({ requestKey: newRequestId() }, requireMediaJob(variation.id));
  assert.equal(
    inherited.promptMessageId,
    codeReply.id,
    'A rerun retains the selected reply rather than the active leaf',
  );
  assert.equal(inherited.prompt, excerptGuard.promptExcerpt, 'A rerun retains the exact selected excerpt');
  deleteMediaJob(requireMediaJob(inherited.id));
  assert.equal(requireMediaJob(variation.id).prompt, excerptGuard.promptExcerpt);
  assert.equal(requireMediaJob(variation.id).prompt_message_id, codeReply.id);

  const conversationCount = () => stmt('SELECT count(*) AS n FROM conversations').get()!.n;
  const beforeCopy = conversationCount();
  assert.throws(() => exportPortableConversation(conversation.id), { status: 409 });
  assert.throws(() => copyConversation(getConversation(conversation.id), ' copy', () => assert.fail('No copy')), {
    status: 409,
  });
  const chatId = insertFixture('conversations', {
    title: 'Portable chat',
    created_at: 1,
    updated_at: 1,
  });
  const importedMedia = {
    ...exportPortableConversation(chatId),
    conversation: {
      ...exportPortableConversation(chatId).conversation,
      promptContext: { messages: [], reasoningPrefill: '', messagePrefill: '' },
    },
  };
  assert.throws(() => importPortableConversation(importedMedia), { status: 400 });
  assert.equal(conversationCount(), Number(beforeCopy) + 1, 'Rejected copies/imports create no orphan');

  finishMediaJob(job.id, 'cancelled');
  deleteMediaJob(requireMediaJob(job.id));
  assert.equal(
    mediaDraft(variation.draft!.id).conversationId,
    conversation.id,
    'Deleting one attempt retains the shared discussion',
  );
  finishMediaJob(variation.id, 'cancelled');
  deleteMediaJob(requireMediaJob(variation.id));
  assert.throws(
    () => getConversation(conversation.id),
    { status: 404 },
    'Removing the last attempt releases its owned conversation',
  );
  assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
});

test('review variations own saved prompt conversations without modifying historical jobs or requiring an endpoint', async () => {
  const { stmt } = await import('../../server/src/db/db.ts');
  const { getSettings, putSettings } = await import('../support/settings.ts');
  const { createMediaJob, createMediaJobFromAsset, deleteMediaJob } =
    await import('../../server/src/media/mediaJobs.ts');
  const { requireMediaJob } = await import('../../server/src/media/mediaJobStore.ts');
  const { getActivePath } = await import('../../server/src/conversations/tree.ts');
  const { getConversation } = await import('../../server/src/conversations/conversationStore.ts');
  const { buildChatMessages } = await import('../../server/src/generation/prompt.ts');
  const { saveMediaRecipe } = await import('../../server/src/media/mediaRecipes.ts');
  const workflow: MediaWorkflow = {
    id: 'legacy-video',
    name: 'Legacy video',
    inputBindings: {},
    textOutputNodeId: null,
    json: '{"1":{"inputs":{"prompt":"{{prompt}}","seed":0}}}',
    standalonePromptPresetId: 'legacy-preset',
    chatPromptPresetId: null,
  };
  putSettings({
    ...getSettings(),
    activeEndpointId: null,
    mediaRendering: {
      ...getSettings().mediaRendering,
      workflows: [workflow],
      defaultWorkflowId: workflow.id,
    },
    mediaStandalonePrompts: {
      folders: [],
      defaultPresetId: null,
      presets: [
        {
          id: 'legacy-preset',
          name: 'Legacy',
          systemPrompt: 'Refine media prompts.',
          userMessage: 'Task: {{instruction}}',
          reasoningPrefill: '',
          messagePrefill: '',
        },
      ],
    },
  });
  const fullPrompt = 'A full saved prompt.\nPreserve every line.';
  // Old completed jobs can predate review drafts and retain a historical template snapshot.
  const old = createMediaJob({
    requestKey: newRequestId(),
    workflowId: workflow.id,
    instruction: 'Slow camera',
    prompt: fullPrompt,
  });
  stmt(`UPDATE media_jobs SET state = 'succeeded', started_at = 123, seed = 42,
    submission_id = 'old-submission', context_json = ? WHERE id = ?`).run(
    JSON.stringify({
      messages: [
        { role: 'system', content: 'Historical system' },
        { role: 'user', content: 'Historical task' },
      ],
      template: {
        systemPrompt: 'Historical system',
        userMessage: 'Historical task',
        reasoningPrefill: '',
        messagePrefill: '',
      },
    }),
    old.id,
  );
  const before = requireMediaJob(old.id);
  const reviewKey = newRequestId();
  const migrated = createMediaJob({ requestKey: reviewKey, reviewBeforeSave: true }, before);
  const id = migrated.draft!.conversationId!;
  assert.deepEqual(
    getActivePath(id).map((message) => [message.role, message.content, message.status]),
    [
      ['user', 'Historical task', 'done'],
      ['assistant', fullPrompt, 'done'],
    ],
  );
  assert.equal(buildChatMessages(getConversation(id), getActivePath(id)).messages[0]!.content, 'Historical system');
  assert.equal(getConversation(id).endpointId, null);
  const after = requireMediaJob(migrated.id);
  assert.deepEqual(requireMediaJob(old.id), before, 'Opening a review variation preserves the historical job');
  assert.equal(after.prompt, before.prompt);
  assert.equal(after.prompt_message_id, getActivePath(id)[1]!.id);
  assert.equal(createMediaJob({ requestKey: reviewKey, reviewBeforeSave: true }, before).id, migrated.id);
  assert.equal(getActivePath(id).length, 2, 'Retrying creation does not append duplicate messages');

  // Reruns still work after job history is gone: recipes retain the instruction and final prompt.
  const recipeId = saveMediaRecipe({ workflowId: workflow.id, comfyUrl: '', timeoutSeconds: 30 }, [], fullPrompt, {
    instruction: 'Slow camera',
  });
  const assetId = insertFixture('media_assets', {
    kind: 'video',
    path: 'legacy.webm',
    mime: 'video/webm',
    width: 1,
    height: 1,
    byte_size: 1,
    recipe_id: recipeId,
    created_at: 1,
  });
  stmt("INSERT INTO media_owners (asset_id, owner_type, owner_id, slot) VALUES (?, 'gallery', '99999', 'media')").run(
    assetId,
  );
  const rerun = createMediaJobFromAsset(assetId, {
    requestKey: newRequestId(),
    reviewBeforeSave: true,
  });
  const rerunMigrated = rerun;
  assert.deepEqual(
    getActivePath(rerunMigrated.draft!.conversationId!).map((message) => [
      message.role,
      message.content,
      message.status,
    ]),
    [
      ['user', 'Task: Slow camera', 'done'],
      ['assistant', fullPrompt, 'done'],
    ],
  );
  assert.equal(rerunMigrated.state, 'draft');
  assert.equal(rerunMigrated.startedAt, null);
  deleteMediaJob(requireMediaJob(old.id));
  assert.equal(getConversation(id).id, id, 'The review variation owns its discussion independently');
  deleteMediaJob(requireMediaJob(migrated.id));
  assert.throws(() => getConversation(id), { status: 404 });
  deleteMediaJob(requireMediaJob(rerun.id));
  assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
});

test('saved review prompts can render during a chat reply while fresh preparation waits for completion', async () => {
  const { controlledStream, mockFetch } = await import('../support/streams.ts');
  const { getSettings, putSettings } = await import('../support/settings.ts');
  const { createMediaJob, startMediaJob } = await import('../../server/src/media/mediaJobs.ts');
  const { startMediaConversation } = await import('../../server/src/media/mediaConversations.ts');
  const { requireMediaJob } = await import('../../server/src/media/mediaJobStore.ts');
  const { getConversation } = await import('../../server/src/conversations/conversationStore.ts');
  const { appendMessage, getActivePath } = await import('../../server/src/conversations/tree.ts');
  const { startGeneration, stopAllGenerations, hasActiveNonToolGeneration } =
    await import('../../server/src/generation/generation.ts');
  const endpoint = insertFixture('endpoints', {
    name: 'Streaming chat',
    base_url: 'http://streaming.invalid',
    created_at: 1,
  });
  const settings = getSettings();
  putSettings({
    ...settings,
    activeEndpointId: endpoint,
    mediaRendering: {
      ...settings.mediaRendering,
      workflows: [
        {
          id: 'manual-prompt',
          name: 'Manual prompt',
          json: '{"output":{"inputs":{"prompt":"{{prompt}}","seed":0}}}',
          inputBindings: {},
          textOutputNodeId: null,
          standalonePromptPresetId: null,
          chatPromptPresetId: null,
        },
      ],
    },
  });
  const workflowId = getSettings().mediaRendering.workflows[0]!.id;
  const chatId = insertFixture('conversations', {
    title: 'Chat in progress',
    endpoint_id: endpoint,
    created_at: 1,
    updated_at: 1,
  });
  const user = appendMessage(chatId, 'user', 'Continue the scene', null);
  const assistant = appendMessage(chatId, 'assistant', '', user.id, 'streaming');
  const stream = controlledStream();
  const originalFetch = globalThis.fetch;
  mockFetch(() => new Response(stream.body));
  try {
    startGeneration(getConversation(chatId), assistant.id);
    assert.equal(hasActiveNonToolGeneration(chatId), true);
    const manual = createMediaJob({
      requestKey: newRequestId(),
      workflowId,
      contextConversationId: chatId,
      destination: 'chat',
      reviewBeforeSave: true,
      prompt: 'An already finished prompt',
    });
    assert.equal(getActivePath(manual.draft!.conversationId!).at(-1)!.content, manual.prompt);
    assert.equal(startMediaJob(requireMediaJob(manual.id), {}, false).state, 'submitting');
    const fresh = createMediaJob({
      requestKey: newRequestId(),
      workflowId,
      contextConversationId: chatId,
      reviewBeforeSave: true,
    });
    const chat = getConversation(chatId);
    assert.throws(
      () =>
        startMediaConversation(requireMediaJob(fresh.id), {
          expectedDraftRevision: fresh.draft!.revision,
          expectedActiveLeafId: chat.activeLeafId,
          expectedMutationRevision: chat.mutationRevision,
        }),
      { status: 409, message: 'Wait for the current chat reply to finish before preparing a media prompt' },
    );
  } finally {
    stopAllGenerations();
    stream.close();
    globalThis.fetch = originalFetch;
  }
});

test('review prompt automation renders complete replies and ignores stopped, truncated or superseded attempts', async () => {
  const { controlledStream, mockFetch, upstreamFrame } = await import('../support/streams.ts');
  const { getSettings, putSettings } = await import('../support/settings.ts');
  const { createMediaJob, editMediaJob } = await import('../../server/src/media/mediaJobs.ts');
  const { startMediaConversation } = await import('../../server/src/media/mediaConversations.ts');
  const { requireMediaJob, mediaDraft } = await import('../../server/src/media/mediaJobStore.ts');
  const { getActivePath, appendMessage } = await import('../../server/src/conversations/tree.ts');
  const { stopGeneration, stopAllGenerations } = await import('../../server/src/generation/generation.ts');
  const { observeInvalidation } = await import('../../server/src/realtime/events.ts');
  const { stopMediaWorker } = await import('../../server/src/media/mediaWorker.ts');
  stopMediaWorker();
  const endpoint = insertFixture('endpoints', {
    name: 'Automation',
    base_url: 'http://automation.invalid',
    created_at: 1,
  });
  const settings = getSettings();
  putSettings({
    ...settings,
    activeEndpointId: endpoint,
    mediaRendering: {
      ...settings.mediaRendering,
      workflows: [
        {
          id: 'automation',
          name: 'Automation',
          json: '{"output":{"inputs":{"prompt":"{{prompt}}","seed":0}}}',
          inputBindings: {},
          textOutputNodeId: null,
          standalonePromptPresetId: null,
          chatPromptPresetId: null,
        },
      ],
    },
  });
  const workflowId = getSettings().mediaRendering.workflows[0]!.id;
  const originalFetch = globalThis.fetch;
  try {
    for (const scenario of ['complete', 'truncated', 'stopped', 'edited', 'branch-changed'] as const) {
      const stream = controlledStream();
      mockFetch(() => new Response(stream.body));
      const job = createMediaJob({
        requestKey: newRequestId(),
        workflowId,
        instruction: 'Write a scene',
        reviewBeforeSave: true,
      });
      const conversation = startMediaConversation(requireMediaJob(job.id), {
        expectedDraftRevision: job.draft!.revision,
        autoRender: true,
      });
      const reply = getActivePath(conversation.id).at(-1)!;
      assert.equal(reply.status, 'streaming');
      assert.equal(
        requireMediaJob(job.id).state,
        'ready',
        'Review prompts use conversation state instead of job preparation',
      );
      assert.equal(mediaDraft(job.draft!.id).conversationId, conversation.id);
      if (scenario === 'edited') editMediaJob(requireMediaJob(job.id), { instruction: 'Changed while writing' });
      if (scenario === 'branch-changed') appendMessage(conversation.id, 'user', 'Use another branch', reply.id);
      const finished = new Promise<void>((resolve) => {
        const dispose = observeInvalidation((entity) => {
          if (
            entity !== 'conversations' ||
            getActivePath(conversation.id).some((message) => message.status === 'streaming')
          )
            return;
          dispose();
          resolve();
        });
      });
      if (scenario === 'stopped') {
        stopGeneration(reply.id);
        stream.close();
      } else {
        stream.write(upstreamFrame({ content: 'A complete scene' }, scenario === 'truncated' ? 'length' : 'stop'));
        stream.write('data: [DONE]\n\n');
        stream.close();
      }
      await finished;
      // Finalization schedules the guarded render callback after publishing the terminal message.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const current = requireMediaJob(job.id);
      if (scenario === 'complete') {
        assert.equal(current.state, 'submitting');
        assert.equal(current.prompt, 'A complete scene');
        assert.equal(current.prompt_message_id, reply.id);
      } else {
        assert.equal(
          current.state,
          scenario === 'edited' ? 'draft' : 'ready',
          `${scenario}: no automatic render may start`,
        );
        assert.equal(current.prompt_message_id, null);
      }
    }
  } finally {
    stopAllGenerations();
    globalThis.fetch = originalFetch;
  }
});
