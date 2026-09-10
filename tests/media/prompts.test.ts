import { insertFixture, conversationFixture, messageFixture } from '../support/fixtures.ts';
import { mockFetch, controlledStream, upstreamFrame } from '../support/streams.ts';
import { testRequestKey } from '../support/requestKey.ts';
import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('media prompts', async () => {
  const { DEFAULT_SETTINGS } = await import('@tinytavern/shared');

  const { setTimeout: sleep } = await import('node:timers/promises');

  const { requireTestIsolation } = await import('../support/isolation.ts');

  type MediaJob = import('@tinytavern/shared').MediaJob;
  type MediaWorkflow = import('@tinytavern/shared').MediaWorkflow;

  requireTestIsolation();
  process.env.COMFY_POLL_MS = '5';
  const { stmt, toConversation } = await import('../../server/src/db/db.ts');
  const { buildToolPrompt } = await import('../../server/src/generation/prompt.ts');
  const { getActivePath } = await import('../../server/src/conversations/tree.ts');
  const { getSettings, putSettings } = await import('../../server/src/settings/settingsStore.ts');
  const { createMediaJob, editMediaJob, startMediaJob, cancelMediaJob, runMediaFavorite } =
    await import('../../server/src/media/mediaJobs.ts');
  const { requireMediaJob, mediaLive, mediaJobDto } =
    await import('../../server/src/media/mediaJobStore.ts');
  const { initMediaWorker, stopMediaWorker, tickMediaWorker } =
    await import('../../server/src/media/mediaWorker.ts');
  const { treeSnapshot } = await import('../../server/src/realtime/sync.ts');

  const endpointId = insertFixture('endpoints', {
    name: 'Captured',
    base_url: 'http://endpoint.invalid/v1',
    api_key: 'private-key',
    model: 'original-model',
    prefill_mode: 'vllm',
    gen_params_json: JSON.stringify({ temperature: 0.2, maxTokens: 1000 }),
    system_prompt_prefix: 'Endpoint prefix\n',
    system_prompt_suffix: '\nEndpoint suffix',
    reasoning_prefill_prefix: 'Endpoint reasoning\n',
    created_at: 1,
  });
  const workflow: MediaWorkflow = {
    id: 'video',
    name: 'Video',
    inputBindings: {},
    textOutputNodeId: null,
    json: '{"1":{"inputs":{"prompt":"{{prompt}}","seed":{{seed}}}}}',
    standalonePromptPresetId: 'formatted',
    chatPromptPresetId: 'formatted',
  };
  const templateId = insertFixture('templates', {
    name: 'Chat',
    content: 'Original chat system context',
    reasoning_prefill: 'Chat reasoning',
    message_prefill: 'Character reply: ',
    prefix_names: 1,
    created_at: 1,
  });
  putSettings({
    ...getSettings(),
    activeEndpointId: endpointId,
    defaultTemplateId: templateId,
    mediaRendering: {
      ...getSettings().mediaRendering,
      comfyUrl: 'http://comfy.invalid',
      workflows: [workflow],
      defaultWorkflowId: workflow.id,
      avatarWorkflowId: null,
      jobTimeoutSeconds: 60,
    },
    mediaChatPrompts: {
      folders: [],
      presets: [
        {
          id: 'formatted',
          name: 'Formatted',
          chatPrompt: 'Chat video formatting\nTask: {{instruction}}',
        },
      ],
      defaultPresetId: null,
    },
    mediaStandalonePrompts: {
      folders: [],
      presets: [
        {
          id: 'formatted',
          name: 'Formatted',
          systemPrompt: 'Use these exact video instructions',
          userMessage: '\nTask: {{instruction}}',
          reasoningPrefill: 'Think carefully',
          messagePrefill: 'Scene: ',
        },
      ],
      defaultPresetId: null,
    },
  });

  const conversationId = conversationFixture({ title: 'Context' });
  const userId = messageFixture(conversationId, { role: 'user', content: 'A sunset by the lake' });
  const assistantId = messageFixture(conversationId, {
    parent_id: userId,
    content: 'The lake reflects orange light.',
    reasoning: 'Original assistant reasoning',
    created_at: 2,
  });
  stmt('UPDATE messages SET active_child_id = ? WHERE id = ?').run(assistantId, userId);
  stmt('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run(assistantId, conversationId);

  const originalFetch = globalThis.fetch;
  let wire: Record<string, unknown> = {};
  let finishReason = 'stop';
  let holdStream = false;
  let pauseReasoning = false;
  let releaseContent: (() => void) | undefined;
  let releaseCompletion: (() => void) | undefined;
  let requestSignal: AbortSignal | undefined;

  mockFetch((url, options) => {
    assert.equal(url, 'http://endpoint.invalid/v1/chat/completions');
    assert.equal(new Headers(options!.headers).get('authorization'), 'Bearer private-key');
    wire = JSON.parse(String(options!.body));
    const frames = [
      upstreamFrame({ content: 'A camera glides across the lake' }),
      upstreamFrame({}, finishReason),
      'data: [DONE]\n\n',
    ];
    if (!pauseReasoning && !holdStream) return new Response(frames.join(''));
    requestSignal = options!.signal!;
    const stream = controlledStream(requestSignal);
    if (pauseReasoning) {
      stream.write(upstreamFrame({ reasoning: 'Considering camera movement' }));
      releaseContent = () => stream.write(frames[0]!);
      releaseCompletion = () => {
        stream.write(frames.slice(1).join(''));
        stream.close();
      };
    } else stream.write(frames[0]!);
    return new Response(stream.body);
  });

  async function waitFor(id: number, state: MediaJob['state']) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      tickMediaWorker();
      if (requireMediaJob(id).state === state) {
        return requireMediaJob(id);
      }
      await sleep(10);
    }
    assert.fail(`Job did not reach ${state}: ${JSON.stringify(requireMediaJob(id))}`);
  }

  try {
    const favoriteChat = conversationFixture({ title: 'Favorite chat' });
    const favoriteRoot = messageFixture(favoriteChat, {
      role: 'user',
      content: 'Favorite context',
    });
    stmt('UPDATE conversations SET active_leaf_id=? WHERE id=?').run(favoriteRoot, favoriteChat);
    const favorite = {
      id: 'quick',
      name: 'Quick scene',
      presetId: 'formatted',
      workflowId: workflow.id,
    };
    putSettings({ ...getSettings(), mediaFavorites: [favorite] });
    const favoriteBefore = stmt(
      'SELECT active_leaf_id,mutation_revision FROM conversations WHERE id=?',
    ).get(favoriteChat)!;
    const favoriteBody = {
      requestKey: testRequestKey('favorite'),
      contextConversationId: favoriteChat,
      expectedActiveLeafId: favoriteBefore.active_leaf_id,
      expectedMutationRevision: favoriteBefore.mutation_revision,
    };
    const quick = runMediaFavorite(favorite.id, favoriteBody);
    assert.equal(quick.workflowId, workflow.id);
    assert.equal(quick.presetId, 'formatted');
    assert.equal(quick.state, 'preparing');
    assert.equal(requireMediaJob(quick.id).auto_render, 1);
    const quickContext = JSON.parse(requireMediaJob(quick.id).context_json!);
    assert(
      quickContext.messages.some((message: { content: string }) =>
        message.content.includes('Favorite context'),
      ),
    );
    assert(quickContext.messages.at(-1).content.includes('Chat video formatting'));
    assert.equal(
      runMediaFavorite(favorite.id, favoriteBody).id,
      quick.id,
      'A retried favorite does not append another tool message or job',
    );
    const jobsBeforeConflict = stmt('SELECT count(*) AS n FROM media_jobs').get()!.n;
    assert.throws(
      () =>
        runMediaFavorite(favorite.id, {
          ...favoriteBody,
          requestKey: testRequestKey('stale-favorite'),
        }),
      /changed|conflict|stale/i,
    );
    assert.equal(
      stmt('SELECT count(*) AS n FROM media_jobs').get()!.n,
      jobsBeforeConflict,
      'Stale favorite creation rolls back atomically',
    );
    cancelMediaJob(requireMediaJob(quick.id));
    initMediaWorker();
    const expected = buildToolPrompt(
      toConversation(stmt('SELECT * FROM conversations WHERE id = ?').get(conversationId)!),
      getActivePath(conversationId),
      '<system_instruction>\nChat video formatting\nTask: Use literal {{context}} in the title\n</system_instruction>',
    );
    const job = createMediaJob({
      requestKey: testRequestKey('snapshot'),
      workflowId: 'video',
      instruction: 'Use literal {{context}} in the title',
      contextConversationId: conversationId,
      destination: 'chat',
    });
    startMediaJob(
      requireMediaJob(job.id),
      { expectedActiveLeafId: assistantId, expectedMutationRevision: 0 },
      true,
    );
    const captured = requireMediaJob(job.id);
    assert.equal(captured.deadline, null, 'Comfy timeout does not run during prompt preparation');
    assert.deepEqual(
      JSON.parse(captured.context_json!).messages,
      expected.messages,
      'Chat media uses exactly the original image tool prefix and trailing steering turn',
    );
    assert(!captured.endpoint_json!.includes('private-key'), 'Saved requests exclude credentials');
    stmt(`UPDATE endpoints SET model = 'changed-model', gen_params_json = '{}',
      system_prompt_prefix = '', system_prompt_suffix = '', reasoning_prefill_prefix = '' WHERE id = ?`).run(
      endpointId,
    );
    stmt("UPDATE messages SET content = 'Changed conversation' WHERE id = ?").run(userId);
    const ready = await waitFor(job.id, 'ready');
    assert.equal(ready.deadline, null, 'A prepared prompt has no running render deadline');
    assert.equal(wire.model, 'original-model');
    assert.equal(wire.temperature, 0.2);
    assert.equal(wire.continue_final_message, true);
    const messages = wire.messages as {
      role: string;
      content: string;
      reasoning_content?: string;
    }[];
    assert.deepEqual(
      messages.slice(0, -1),
      expected.messages.map((message) =>
        message.role === 'system'
          ? { ...message, content: `Endpoint prefix\n${message.content}\nEndpoint suffix` }
          : message,
      ),
      'The wire composes captured endpoint additions with the original structured chat prefix',
    );
    assert.equal(
      messages[0]!.content,
      'Endpoint prefix\nOriginal chat system context\nEndpoint suffix',
    );
    assert(messages[1]!.content.includes('A sunset by the lake'));
    assert.equal(messages[2]!.reasoning_content, 'Original assistant reasoning');
    assert(messages[3]!.content.includes('Use literal {{context}} in the title'));
    assert(!messages[1]!.content.includes('Changed conversation'));
    assert.deepEqual(messages.at(-1), {
      role: 'assistant',
      content: '',
      reasoning_content: 'Endpoint reasoning\nChat reasoning',
    });
    assert.equal(ready.prompt, 'A camera glides across the lake');
    assert.equal(
      stmt('SELECT content FROM messages WHERE id = ?').get(ready.message_id!)!.content,
      ready.prompt,
    );
    assert.equal(ready.submission_id, null, 'Preparation alone never submits to Comfy');

    const replacementWorkflow = {
      ...workflow,
      id: 'replacement',
      name: 'Replacement video workflow',
    };
    const settings = getSettings();
    putSettings({
      ...settings,
      mediaRendering: {
        ...settings.mediaRendering,
        workflows: [...settings.mediaRendering.workflows, replacementWorkflow],
      },
    });
    editMediaJob(requireMediaJob(job.id), { workflowId: replacementWorkflow.id });
    startMediaJob(requireMediaJob(job.id), {}, true);
    const revised = await waitFor(job.id, 'ready');
    const recipe = stmt('SELECT configuration_json, prompt FROM media_recipes WHERE id = ?').get(
      job.id,
    )!;
    assert.equal(
      JSON.parse(String(recipe.configuration_json)).workflow.id,
      replacementWorkflow.id,
      'Changing the workflow before submission updates the same message recipe',
    );
    assert.equal(
      recipe.prompt,
      revised.prompt,
      'Prepared recipes retain the completed prompt before any image or video exists',
    );

    finishReason = 'length';
    const truncated = createMediaJob({
      requestKey: testRequestKey('truncated'),
      workflowId: 'video',
      instruction: 'Move slowly',
    });
    startMediaJob(requireMediaJob(truncated.id), { autoRender: true }, true);
    const failed = await waitFor(truncated.id, 'failed');
    const galleryMessages = wire.messages as { role: string; content: string }[];
    assert.equal(galleryMessages[0]!.content, 'Use these exact video instructions');
    assert.equal(galleryMessages[1]!.content, '\nTask: Move slowly');
    assert(!JSON.stringify(galleryMessages).includes('Original chat system context'));
    assert.match(failed.error!, /truncated/);
    assert.equal(failed.prompt, 'Scene: A camera glides across the lake');
    assert.equal(
      failed.submission_id,
      null,
      'Truncated prompts cannot trigger automatic rendering',
    );

    holdStream = true;
    const interrupted = createMediaJob({
      requestKey: testRequestKey('cancel-prompt'),
      workflowId: 'video',
      instruction: 'Move slowly',
      contextConversationId: conversationId,
      destination: 'chat',
    });
    const conversation = stmt(
      'SELECT active_leaf_id, mutation_revision FROM conversations WHERE id = ?',
    ).get(conversationId)!;
    startMediaJob(
      requireMediaJob(interrupted.id),
      {
        expectedActiveLeafId: conversation.active_leaf_id,
        expectedMutationRevision: conversation.mutation_revision,
        autoRender: true,
      },
      true,
    );
    const deadline = Date.now() + 2000;
    while (!mediaLive.get(interrupted.id)?.prompt && Date.now() < deadline) {
      tickMediaWorker();
      await sleep(10);
    }
    const streaming = requireMediaJob(interrupted.id);
    const liveMessage = treeSnapshot(conversationId).messages.find(
      (message) => message.id === streaming.message_id,
    )!;
    assert.equal(
      liveMessage.content,
      'A camera glides across the lake',
      'Resync includes the live prompt buffer',
    );
    assert.equal(
      stmt('SELECT content FROM messages WHERE id = ?').get(streaming.message_id!)!.content,
      '',
      'Streaming text is not periodically written to SQLite',
    );
    cancelMediaJob(streaming);
    tickMediaWorker();
    await sleep(30);
    assert(requestSignal?.aborted, 'Cancellation aborts the upstream prompt request');
    const cancelled = requireMediaJob(interrupted.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.prompt, liveMessage.content);
    assert.equal(cancelled.submission_id, null);
    assert.equal(
      stmt('SELECT content FROM messages WHERE id = ?').get(cancelled.message_id!)!.content,
      liveMessage.content,
    );

    holdStream = false;
    finishReason = 'stop';
    const imageWorkflow: MediaWorkflow = {
      ...workflow,
      id: 'image',
      name: 'Image',
      standalonePromptPresetId: 'gallery-image',
      chatPromptPresetId: 'chat-image',
    };
    const editWorkflow: MediaWorkflow = {
      ...imageWorkflow,
      id: 'edit',
      name: 'Edit',
      inputBindings: {},
      textOutputNodeId: null,
      json: '{"1":{"inputs":{"prompt":"{{prompt}}","image":"{{input1}}"}}}',
      standalonePromptPresetId: 'gallery-edit',
      chatPromptPresetId: 'reference-style',
    };
    putSettings({
      ...getSettings(),
      mediaChatPrompts: {
        folders: [],
        defaultPresetId: null,
        presets: [
          {
            id: 'chat-image',
            name: 'Image',
            chatPrompt:
              '{{#if instruction}}[System Note]\nMy directed style for {{char}}: {{instruction}}{{/if}}{{#if no_instruction}}[System Note]\nMy character style for {{char}}{{/if}}',
          },
          {
            id: 'portrait',
            name: 'My portrait',
            chatPrompt: 'My portrait style for {{char}}: {{instruction}}',
          },
          {
            id: 'reference-style',
            name: 'Reference style',
            chatPrompt:
              'Reference style for {{char}}: {{instruction}}\n{{#if input1_prompt}}Source: {{input1_prompt}}{{/if}}',
          },
        ],
      },
      mediaRendering: {
        ...getSettings().mediaRendering,
        workflows: [imageWorkflow, editWorkflow],
        defaultWorkflowId: 'image',
      },
      mediaStandalonePrompts: {
        folders: [],
        defaultPresetId: null,
        presets: [
          {
            id: 'gallery-image',
            name: 'Gallery image only',
            systemPrompt: 'Gallery-only system',
            userMessage: 'Gallery: {{instruction}}',
            reasoningPrefill: '',
            messagePrefill: '',
          },
          {
            id: 'gallery-edit',
            name: 'Edit only',
            systemPrompt: 'Edit-only system',
            userMessage: 'Edit: {{instruction}}',
            reasoningPrefill: '',
            messagePrefill: '',
          },
        ],
      },
    });
    const portrait = getSettings().mediaChatPrompts.presets.find(
      (preset) => preset.id === 'portrait',
    )!;
    const prepareImage = async (
      key: string,
      context: number | null,
      presetId?: string,
      instruction = 'Evening with literal {{prompt}}',
    ) => {
      const draft = createMediaJob({
        requestKey: testRequestKey(key),
        contextConversationId: context,
        reviewBeforeSave: true,
        destination: context === null ? 'gallery' : 'chat',
        instruction,
        presetId,
      });
      startMediaJob(requireMediaJob(draft.id), {}, true);
      return waitFor(draft.id, 'ready');
    };
    const chatImage = await prepareImage('chat-image-selection', conversationId, portrait.id);
    const expectedPortrait = buildToolPrompt(
      toConversation(stmt('SELECT * FROM conversations WHERE id = ?').get(conversationId)!),
      getActivePath(conversationId),
      'My portrait style for {{char}}: Evening with literal {{prompt}}',
    );
    assert.deepEqual(
      JSON.parse(chatImage.context_json!).messages,
      expectedPortrait.messages,
      'Chat image selection uses the existing portrait preset and the exact chat prefix',
    );
    const chatDefault = await prepareImage('chat-image-default', conversationId);
    assert(
      JSON.parse(chatDefault.context_json!).messages.at(-1).content.includes('My directed style'),
      'The workflow selects the chat preset independently of standalone defaults',
    );
    assert(!chatDefault.context_json!.includes('MUST NOT USE'));
    assert.equal(
      JSON.parse(chatDefault.context_json!)
        .messages.at(-1)
        .content.match(/<system_instruction>/g)?.length,
      1,
      'Conditional chat presets retain one instruction wrapper',
    );
    const blankInstruction = await prepareImage(
      'chat-image-blank',
      conversationId,
      undefined,
      '   ',
    );
    assert(
      JSON.parse(blankInstruction.context_json!)
        .messages.at(-1)
        .content.includes('My character style'),
      'An empty or whitespace-only instruction uses the preset without instruction',
    );
    const standalone = await prepareImage('gallery-image-default', null);
    assert.deepEqual(
      JSON.parse(standalone.context_json!).messages,
      [
        { role: 'system', content: 'Gallery-only system' },
        { role: 'user', content: 'Gallery: Evening with literal {{prompt}}' },
      ],
      'Gallery uses only its standalone preset set',
    );
    for (const [key, context, presetId] of [
      ['wrong-chat-preset', conversationId, 'gallery-image'],
      ['wrong-instruction-type', conversationId, 'chat-image/describe'],
      ['wrong-gallery-preset', null, portrait.id],
    ] as const) {
      const invalid = createMediaJob({
        requestKey: testRequestKey(key),
        contextConversationId: context,
        reviewBeforeSave: true,
        instruction: 'Test',
        presetId,
      });
      assert.throws(
        () => startMediaJob(requireMediaJob(invalid.id), {}, true),
        { status: 400 },
        'Chat and gallery preset selections cannot cross modes',
      );
    }
    stmt(`INSERT INTO gallery_items(character_name, prompt, image, created_at, updated_at)
    VALUES ('Test', 'Source description', '/images/prompt-source.png', 1, 1)`).run();
    const sourceId = Number(
      stmt("SELECT id FROM media_assets WHERE path = '/images/prompt-source.png'").get()!.id,
    );
    const edit = createMediaJob({
      requestKey: testRequestKey('edit-with-chat-destination'),
      contextConversationId: conversationId,
      destination: 'chat',
      reviewBeforeSave: true,
      instruction: 'Change the lighting',
    });
    editMediaJob(requireMediaJob(edit.id), {
      workflowId: 'edit',
      presetId: null,
      inputs: [{ assetId: sourceId, slot: 'input1' }],
    });
    startMediaJob(requireMediaJob(edit.id), {}, true);
    const editReady = await waitFor(edit.id, 'ready');
    const expectedEdit = buildToolPrompt(
      toConversation(stmt('SELECT * FROM conversations WHERE id = ?').get(conversationId)!),
      getActivePath(conversationId),
      'Reference style for {{char}}: Change the lighting\nSource: Source description',
    );
    assert.deepEqual(
      JSON.parse(editReady.context_json!).messages,
      expectedEdit.messages,
      'Switching from chat image creation to references keeps the exact chat prefix and uses the active reference prompt',
    );
    assert.equal(JSON.parse(editReady.context_json!).template.reasoningPrefill, 'Chat reasoning');
    assert(
      getSettings().mediaChatPrompts.presets.some((preset) => preset.id === 'reference-style'),
    );
    const standaloneEdit = createMediaJob({
      requestKey: testRequestKey('edit-with-gallery-destination'),
      workflowId: 'edit',
      reviewBeforeSave: true,
      instruction: 'Change the lighting',
      inputs: [{ assetId: sourceId, slot: 'input1' }],
    });
    startMediaJob(requireMediaJob(standaloneEdit.id), {}, true);
    const standaloneEditReady = await waitFor(standaloneEdit.id, 'ready');
    assert.deepEqual(
      JSON.parse(standaloneEditReady.context_json!).messages,
      [
        { role: 'system', content: 'Edit-only system' },
        { role: 'user', content: 'Edit: Change the lighting' },
      ],
      'Gallery reference images retain standalone instructions',
    );
    putSettings({
      ...getSettings(),
      mediaRendering: {
        ...getSettings().mediaRendering,
        workflows: [{ ...workflow, chatPromptPresetId: null }],
      },
    });
    pauseReasoning = true;
    const thinking = createMediaJob({
      requestKey: testRequestKey('thinking-preview'),
      workflowId: workflow.id,
      contextConversationId: conversationId,
      destination: 'chat',
      instruction: 'Camera movement',
    });
    const chat = stmt(
      'SELECT active_leaf_id, mutation_revision FROM conversations WHERE id = ?',
    ).get(conversationId)!;
    startMediaJob(
      requireMediaJob(thinking.id),
      {
        expectedActiveLeafId: chat.active_leaf_id,
        expectedMutationRevision: chat.mutation_revision,
      },
      true,
    );
    const reasoningDeadline = Date.now() + 3000;
    while (
      !mediaLive.get(thinking.id)?.reasoning?.includes('Considering camera movement') &&
      Date.now() < reasoningDeadline
    ) {
      tickMediaWorker();
      await sleep(10);
    }
    const thinkingRow = requireMediaJob(thinking.id);
    const thinkingSnapshot = mediaJobDto(thinkingRow);
    assert.equal(
      thinkingSnapshot.reasoning,
      'Chat reasoningConsidering camera movement',
      'Job reopen includes live reasoning and its prefill',
    );
    assert.equal(thinkingSnapshot.prompt, '');
    assert.equal(
      treeSnapshot(conversationId).messages.find(
        (message) => message.id === thinkingRow.message_id,
      )!.reasoning,
      thinkingSnapshot.reasoning,
      'Chat resync includes media prompt reasoning',
    );
    assert.equal(
      stmt('SELECT reasoning FROM messages WHERE id = ?').get(thinkingRow.message_id!)!.reasoning,
      null,
      'Reasoning remains transient',
    );
    releaseContent!();
    await sleep(20);
    assert.equal(
      mediaJobDto(requireMediaJob(thinking.id)).reasoning,
      '',
      'The first prompt delta clears reasoning',
    );
    assert.equal(
      treeSnapshot(conversationId).messages.find(
        (message) => message.id === thinkingRow.message_id,
      )!.reasoning,
      null,
    );
    releaseCompletion!();
    const thought = await waitFor(thinking.id, 'ready');
    assert.equal(mediaJobDto(thought).reasoning, undefined);
    assert.equal(thought.prompt, 'A camera glides across the lake');
    assert.equal(
      stmt('SELECT reasoning FROM messages WHERE id = ?').get(thinkingRow.message_id!)!.reasoning,
      null,
    );
  } finally {
    stopMediaWorker();
    await sleep(30);
    globalThis.fetch = originalFetch;
  }
});
