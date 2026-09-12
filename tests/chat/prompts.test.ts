import assert from 'node:assert/strict';
import { databaseCase } from '../support/database.ts';

databaseCase('chat prompt', async () => {
  const original = 'A sign reading {{instruction}} and $&';
  const instruction = 'Make it blue; keep {{prompt}} literal';

  const { systemNote } = await import('@tinytavern/shared');

  type BuiltPrompt = import('../../server/src/generation/prompt.ts').BuiltPrompt;
  type ChatMessage = import('../../server/src/generation/prompt.ts').ChatMessage;
  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const { appendChatMessage, withDisabledPrefillSpeakerNote } = await import('../../server/src/generation/prompt.ts');

  const messages: ChatMessage[] = [];
  appendChatMessage(messages, { role: 'user', content: 'first' });
  appendChatMessage(messages, { role: 'user', content: 'second' });
  appendChatMessage(messages, { role: 'assistant', content: 'reply', reasoning_content: 'one' });
  appendChatMessage(messages, { role: 'assistant', content: 'more', reasoning_content: 'two' });
  appendChatMessage(messages, { role: 'system', content: 'late system context' });

  assert.deepEqual(
    messages.map((message) => message.role),
    ['system', 'user', 'assistant'],
  );
  assert.equal(messages[1]?.content, 'first\n\nsecond');
  assert.equal(messages[2]?.content, 'reply\n\nmore');
  assert.equal(messages[2]?.reasoning_content, 'one\n\ntwo');

  const rootPrompt: BuiltPrompt = {
    messages: [{ role: 'system', content: 'system' }],
    reasoningPrefill: null,
    messagePrefill: null,
    namePrefill: 'Guest:',
    speakerHandoff: '<Note: Reply as Guest>',
    charName: 'Assistant',
    userName: 'User',
  };
  const rootWithNote = withDisabledPrefillSpeakerNote(rootPrompt);
  assert.deepEqual(
    rootWithNote.map((message) => message.role),
    ['system', 'user'],
  );
  assert.equal(rootWithNote.at(-1)?.content, '<system_instruction>\n<Note: Reply as Guest>\n</system_instruction>');
  assert.equal(systemNote('[System Note]\nCustom'), '<system_instruction>\nCustom\n</system_instruction>');
  assert.equal(systemNote(''), '');
  const wrapped = '<system_instruction>\nCustom\n</system_instruction>';
  assert.equal(systemNote(wrapped), wrapped);
  assert.equal(systemNote('[IMAGE PROMPT TASK]\nCustom'), '<system_instruction>\nCustom\n</system_instruction>');
  assert.equal(
    systemNote('[System Note]\n[IMAGE PROMPT TASK]\nCustom'),
    '<system_instruction>\nCustom\n</system_instruction>',
  );

  const { stmt, toConversation } = await import('../../server/src/db/db.ts');
  const { getSettings, putSettings } = await import('../support/settings.ts');
  const { buildChatMessages } = await import('../../server/src/generation/prompt.ts');
  const characterId = Number(
    stmt(
      "INSERT INTO characters(name, personality, created_at) VALUES ('Layout character', 'Visible personality', 1)",
    ).run().lastInsertRowid,
  );
  const conversationId = Number(
    stmt("INSERT INTO conversations(title, character_id, created_at, updated_at) VALUES ('Layout test', ?, 1, 1)").run(
      characterId,
    ).lastInsertRowid,
  );
  const conversation = toConversation(stmt('SELECT * FROM conversations WHERE id = ?').get(conversationId)!);
  assert(
    buildChatMessages(conversation, []).messages[0]?.content.includes('Visible personality'),
    'Fresh installations select a normal seeded template',
  );
  const templateId = getSettings().defaultTemplateId!;
  for (const content of ['', '   ']) {
    stmt('UPDATE templates SET content = ? WHERE id = ?').run(content, templateId);
    assert.deepEqual(buildChatMessages(conversation, []).messages, [], 'Empty saved layouts stay empty');
  }
  stmt('UPDATE templates SET content = ?, user_prologue = ? WHERE id = ?').run('{{system}}', 'Prologue', templateId);
  assert.equal(buildChatMessages(conversation, []).messages[0]?.role, 'system');
  stmt('UPDATE characters SET custom_template = ? WHERE id = ?').run(JSON.stringify({ content: '' }), characterId);
  assert.deepEqual(
    buildChatMessages(conversation, []).messages,
    [],
    'Empty inline layouts override the global saved layout',
  );
  stmt('UPDATE characters SET custom_template = NULL WHERE id = ?').run(characterId);
  putSettings({ ...getSettings(), defaultTemplateId: null });
  assert.deepEqual(buildChatMessages(conversation, []).messages, [], 'No selection does not introduce a hidden layout');
  putSettings({ ...getSettings(), defaultTemplateId: templateId });
  stmt("UPDATE templates SET content = '' WHERE id = ?").run(templateId);
  assert.deepEqual(
    buildChatMessages(conversation, []).messages,
    [{ role: 'user', content: 'Prologue' }],
    'An empty system layout still honors the other saved template fields',
  );

  const { resolveSteerTemplate, appendImagePromptRevisionTask } = await import('../../server/src/generation/prompt.ts');
  stmt('UPDATE templates SET steer_template = ?, prefix_names = 1, speaker_handoff_template = ? WHERE id = ?').run(
    'Adjust {{instruction}} exactly.',
    'Speak as {{speaker}} only.',
    templateId,
  );
  assert.equal(resolveSteerTemplate(conversation), 'Adjust {{instruction}} exactly.');
  assert.equal(
    buildChatMessages(conversation, [], 'Guest $& {{speaker}}').speakerHandoff,
    'Speak as Guest $& {{speaker}} only.',
  );
  const { messageFixture } = await import('../support/fixtures.ts');
  const { getMessage } = await import('../../server/src/conversations/tree.ts');
  const { prepareChatMessages } = await import('@tinytavern/shared');
  stmt("UPDATE templates SET prefix_names = 0, user_prologue = '' WHERE id = ?").run(templateId);
  const historyRows: Record<string, string | null>[] = [
    { role: 'user', content: 'Start' },
    { content: 'Main character', name: null },
    { role: 'user', content: 'Switch' },
    { content: 'Guest reply', name: 'Guest' },
    { role: 'user', content: 'Continue' },
    { content: 'Same guest', name: 'Guest' },
    { content: '', reasoning: 'Another speaker thinking', name: 'Other' },
    { content: 'Back to main', name: null },
  ];
  const history = historyRows.map((fields) => getMessage(messageFixture(conversationId, fields))!);
  const savedHistory = structuredClone(history);
  const historical = buildChatMessages(conversation, history);
  const attributed = buildChatMessages(conversation, [
    { ...history[1]!, id: 101, content: 'Repeated reply' },
    { ...history[1]!, id: 102, content: 'Repeated reply' },
    { ...history[1]!, id: 103, role: 'tool', content: 'Hidden tool' },
    { ...history[1]!, id: 104, status: 'streaming', content: 'In progress' },
    { ...history[1]!, id: 105, content: '' },
    { ...history[0]!, id: 106, role: 'system', content: 'Moved to the front' },
    { ...history[0]!, id: 107, content: 'Next' },
    { ...history[1]!, id: 108, content: '', reasoning: 'Reasoning only' },
  ]);
  assert.deepEqual(attributed.messageIds, [[], [101, 102], [], [108]]);
  assert.equal(attributed.messages[1]!.content, 'Repeated reply\n\nRepeated reply');
  assert(
    attributed.messages.every((message) => !('messageIds' in message)),
    'Source IDs stay out of upstream message objects',
  );
  assert.deepEqual(
    historical.messages.map(({ role, content }) => [role, content]),
    [
      ['user', 'Start'],
      ['assistant', 'Main character'],
      ['user', 'Switch\n<system_instruction>\nSpeak as Guest only.\n</system_instruction>'],
      ['assistant', 'Guest reply'],
      ['user', 'Continue'],
      ['assistant', 'Same guest'],
      ['user', '<system_instruction>\nSpeak as Other only.\n</system_instruction>'],
      ['assistant', '(No visible response)'],
      ['user', '<system_instruction>\nSpeak as Layout character only.\n</system_instruction>'],
      ['assistant', 'Back to main'],
    ],
  );
  assert.equal(historical.speakerHandoff, null);
  const next = prepareChatMessages(buildChatMessages(conversation, history, 'Guest'), {
    prefillMode: 'disabled',
  });
  assert.deepEqual(
    next.messages.slice(0, -1),
    historical.messages,
    'A new handoff must not rewrite an earlier user turn across assistant replies',
  );
  assert.deepEqual(next.messages.at(-1), {
    role: 'user',
    content: '<system_instruction>\nSpeak as Guest only.\n</system_instruction>',
  });
  assert.equal(buildChatMessages(conversation, history.slice(0, 4), 'Guest').speakerHandoff, null);
  assert.deepEqual(history, savedHistory, 'Handoffs are reconstructed without editing stored messages');
  stmt("UPDATE templates SET steer_template = '', speaker_handoff_template = '' WHERE id = ?").run(templateId);
  assert.throws(() => resolveSteerTemplate(conversation), { status: 400 });
  assert.equal(buildChatMessages(conversation, [], 'Guest').speakerHandoff, '');
  const customRevision = {
    promptRevisionContext: 'Source follows: {{prompt}}',
    promptRevisionOriginal: 'SOURCE {{prompt}}',
    promptRevisionTemplate: 'CHANGE {{instruction}}',
  };
  const revisionHistory: ChatMessage[] = [{ role: 'assistant', content: 'Unchanged chat' }];
  appendImagePromptRevisionTask(revisionHistory, original, 'Original reasoning', instruction, customRevision);
  assert.deepEqual(revisionHistory, [
    { role: 'assistant', content: 'Unchanged chat' },
    {
      role: 'user',
      content: `<system_instruction>\nSource follows: ${original}\n</system_instruction>`,
    },
    { role: 'assistant', content: `SOURCE ${original}`, reasoning_content: 'Original reasoning' },
    { role: 'user', content: `<system_instruction>\nCHANGE ${instruction}\n</system_instruction>` },
  ]);
  const noBridge: ChatMessage[] = [];
  appendImagePromptRevisionTask(noBridge, original, null, instruction, {
    ...customRevision,
    promptRevisionContext: '',
  });
  assert.deepEqual(
    noBridge.map((message) => message.role),
    ['assistant', 'user'],
  );
  assert(!JSON.stringify(noBridge).includes('IMAGE PROMPT REVISION CONTEXT'));
});

databaseCase('completion config', async () => {
  type Endpoint = import('@tinytavern/shared').Endpoint;
  const { prepareStandaloneCompletion, withEndpointSystemPrompt, endpointReasoningPrefill } =
    await import('../../server/src/generation/completionConfig.ts');

  type ChatMessage = import('../../server/src/generation/prompt.ts').ChatMessage;

  const endpoint: Endpoint = {
    folderId: null,
    id: 1,
    name: 'Test',
    baseUrl: '',
    apiKey: '',
    hasApiKey: false,
    models: [],
    model: null,
    createdAt: 0,
    prefillMode: 'vllm',
    allowReasoningPrefill: true,
    allowMessagePrefill: true,
    systemPromptPrefix: '',
    systemPromptSuffix: '',
    reasoningPrefillPrefix: '',
    genParams: {
      temperature: 0,
      topP: 0.8,
      minP: 0.05,
      maxTokens: 700,
      frequencyPenalty: 0,
      presencePenalty: 0.2,
      reasoningEffort: 'high',
    },
  };
  const source: ChatMessage[] = [{ role: 'user', content: 'Revise this prompt' }];
  for (const allowMessagePrefill of [false, true]) {
    const split = prepareStandaloneCompletion(
      { ...endpoint, allowMessagePrefill, allowReasoningPrefill: !allowMessagePrefill },
      source,
      1024,
      { messagePrefill: 'Reply', reasoningPrefill: 'Think' },
    );
    assert.deepEqual(split.messages.at(-1), {
      role: 'assistant',
      content: allowMessagePrefill ? 'Reply' : '',
      ...(!allowMessagePrefill ? { reasoning_content: 'Think' } : {}),
    });
  }

  const original = structuredClone(source);
  const additions = {
    ...endpoint,
    systemPromptPrefix: 'Global system\n',
    systemPromptSuffix: '\nEnd {{literal}}',
    reasoningPrefillPrefix: '\nGlobal reasoning\n',
  };
  for (const mode of ['vllm', 'deepseek', 'none', 'disabled'] as const) {
    const prepared = prepareStandaloneCompletion({ ...additions, prefillMode: mode }, source, 1024, {
      useEndpointParameters: true,
      reasoningPrefill: 'Consider the light',
      messagePrefill: 'A scene ',
    });
    assert.deepEqual(prepared, {
      messages: [
        ...source,
        ...(mode === 'disabled'
          ? []
          : [
              {
                role: 'assistant',
                content: 'A scene ',
                reasoning_content: '\nGlobal reasoning\nConsider the light',
                ...(mode === 'deepseek' ? { prefix: true } : {}),
              },
            ]),
      ],
      parameters: {
        temperature: 0,
        top_p: 0.8,
        min_p: 0.05,
        max_tokens: 700,
        frequency_penalty: 0,
        presence_penalty: 0.2,
        reasoning_effort: 'high',
        ...(mode === 'vllm' ? { continue_final_message: true, add_generation_prompt: false } : {}),
      },
      messagePrefill: mode === 'disabled' ? '' : 'A scene ',
      reasoningPrefill: mode === 'disabled' ? '' : '\nGlobal reasoning\nConsider the light',
    });
  }
  assert.deepEqual(source, original, 'Preparing continuation must not mutate snapshotted messages');
  assert.strictEqual(withEndpointSystemPrompt(endpoint, source), source, 'Empty additions allocate no message list');
  assert.deepEqual(withEndpointSystemPrompt(additions, source), [
    { role: 'system', content: 'Global system\n\nEnd {{literal}}' },
    ...source,
  ]);
  const systemSource: ChatMessage[] = [{ role: 'system', content: 'Template system' }, ...source];
  const systemOriginal = structuredClone(systemSource);
  const wrapped = withEndpointSystemPrompt(additions, systemSource);
  assert.deepEqual(wrapped, [
    { role: 'system', content: 'Global system\nTemplate system\nEnd {{literal}}' },
    ...source,
  ]);
  assert.deepEqual(withEndpointSystemPrompt(additions, systemSource), wrapped);
  assert.deepEqual(systemSource, systemOriginal, 'System additions never mutate captured prompts');
  assert.equal(prepareStandaloneCompletion(additions, source, 1024).reasoningPrefill, '\nGlobal reasoning\n');
  for (const saved of ['\nGlobal reasoning\nThought', 'Global reasoning\nThought', 'Thought']) {
    const continued = endpointReasoningPrefill(additions, saved, true);
    assert.equal(continued, '\nGlobal reasoning\nThought');
    assert.equal(endpointReasoningPrefill(additions, continued, true), continued);
  }
  assert.equal(endpointReasoningPrefill(additions, 'Global reasoning', true), '\nGlobal reasoning\n');
  assert.deepEqual(prepareStandaloneCompletion(endpoint, source, 1024), {
    messages: source,
    parameters: { max_tokens: 1024 },
    messagePrefill: '',
    reasoningPrefill: '',
  });
  assert.deepEqual(
    prepareStandaloneCompletion({ ...endpoint, genParams: {} }, source, 1024, {
      useEndpointParameters: true,
      reasoningPrefill: 'Think',
    }),
    {
      messages: [...source, { role: 'assistant', content: '', reasoning_content: 'Think' }],
      parameters: { max_tokens: 1024, continue_final_message: true, add_generation_prompt: false },
      messagePrefill: '',
      reasoningPrefill: 'Think',
    },
  );
});

databaseCase('draft completion', async () => {
  const { DEFAULT_DRAFT_COMPLETION_PROMPT } = await import('@tinytavern/shared');

  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const { buildDraftCompletionMessages, DraftSuffixFilter } =
    await import('../../server/src/generation/draftCompletionPrompt.ts');
  const { stmt, toConversation } = await import('../../server/src/db/db.ts');
  const { getSettings } = await import('../../server/src/settings/settingsStore.ts');
  const { appendMessage } = await import('../../server/src/conversations/tree.ts');
  const { buildChatMessages } = await import('../../server/src/generation/prompt.ts');

  const conversation = toConversation(
    stmt("INSERT INTO conversations (title, created_at, updated_at) VALUES ('Draft', 1, 1) RETURNING *").get()!,
  );
  stmt('UPDATE templates SET content = ?, user_prologue = ?, prefix_names = 0 WHERE id = ?').run(
    'System',
    '',
    getSettings().defaultTemplateId!,
  );
  const first = appendMessage(conversation.id, 'user', 'First', null);
  const second = appendMessage(conversation.id, 'user', 'Second', first.id);
  const assistant = appendMessage(conversation.id, 'assistant', '', second.id);
  const tool = appendMessage(conversation.id, 'tool', 'Image prompt', assistant.id);
  const built = buildChatMessages(conversation, [first, second, { ...assistant, reasoning: 'thought' }, tool]);
  const prefix = structuredClone(built.messages);

  const alternating = buildDraftCompletionMessages(
    built.messages,
    'I was halfway through',
    DEFAULT_DRAFT_COMPLETION_PROMPT,
  );
  assert.deepEqual(
    alternating.map((message) => message.role),
    ['system', 'user', 'assistant', 'user'],
  );
  assert.equal(alternating[1]?.content, 'First\n\nSecond');
  assert.equal(alternating[2]?.content, '(No visible response)');
  assert.equal(alternating[2]?.reasoning_content, 'thought');
  assert.match(alternating.at(-1)?.content ?? '', /I was halfway through/);
  assert.deepEqual(alternating.slice(0, -1), prefix, 'Draft completion preserves the built prefix');

  const trailingUser = buildDraftCompletionMessages(
    buildChatMessages(conversation, [first, second]).messages,
    'Draft',
    DEFAULT_DRAFT_COMPLETION_PROMPT,
  );
  assert.equal(trailingUser.length, 2);
  assert.match(trailingUser[1]?.content ?? '', /^First\n\nSecond\n\n/);
  assert.match(trailingUser[1]?.content ?? '', /Draft/);

  const draft = "  - **Markdown**\n\t```ts\nconst x = '🦊';  ";
  const continuation = ' // note\n\t```\n';
  for (let split = 0; split <= draft.length + continuation.length; split++) {
    const filter = new DraftSuffixFilter(draft);
    const response = draft + continuation;
    assert.equal(filter.push(response.slice(0, split)) + filter.push(response.slice(split)), continuation);
    filter.finish();
  }
  const filter = new DraftSuffixFilter(draft);
  let suffix = '';
  for (const character of draft + continuation) suffix += filter.push(character);
  assert.equal(suffix, continuation);
  filter.finish();
  const changed = new DraftSuffixFilter(draft);
  assert.throws(() => changed.push(draft.trimStart()), /changed the existing draft/);
  const partial = new DraftSuffixFilter(draft);
  assert.equal(partial.push(draft.slice(0, -1)), '');
  assert.throws(() => partial.finish(), /stopped before repeating/);
  const exact = new DraftSuffixFilter(draft);
  assert.equal(exact.push(draft), '');
  exact.finish();
  assert.equal(exact.push('  '), '  ');

  assert.deepEqual(
    buildDraftCompletionMessages(
      [{ role: 'assistant', content: 'Chat prefix' }],
      'A {{draft}} $&',
      'Continue: {{DRAFT}}',
    ),
    [
      { role: 'assistant', content: 'Chat prefix' },
      {
        role: 'user',
        content: '<system_instruction>\nContinue: A {{draft}} $&\n</system_instruction>',
      },
    ],
  );
});
