import type { Conversation } from '@minitavern/shared';
import {
  MOCK_URL,
  MOCK_CONTROL,
  assert,
  req,
  fetchTrace,
  branchBody,
  patchConversation,
  sendMessage,
  makeNextMockResponseEndWithoutNewline,
} from './helpers.ts';
import type { TemplatesFixture } from './templates.ts';
import type { ChatFixture } from './chat.ts';

export async function testPromptOverrides(
  fixture: Pick<TemplatesFixture, 'conv2'> & Pick<ChatFixture, 'ws'>,
) {
  const { conv2, ws } = fixture;

  console.log('== character inline custom template ==');
  const inlineChar = await req<{ id: number }>('POST', '/api/characters', {
    name: 'Inline Hero',
    customTemplate: {
      content: '{{system}} INLINE {{char}} + {{user}}',
      userPrologue: 'Inline prologue for {{char}}.',
      reasoningPrefill: 'Inline reasoning for {{char}}.',
      messagePrefill: 'Inline answer for {{user}}:',
      prefixNames: true,
      usesPersonas: false,
    },
  });
  const inlineConv = await req<{ id: number }>('POST', '/api/conversations', {
    characterId: inlineChar.id,
  });
  const inlineTrace = await fetchTrace(inlineConv.id);
  assert(
    inlineTrace.messages.some(
      (m) => m.role === 'system' && m.content.endsWith('INLINE Inline Hero + User'),
    ),
    'inline template renders its content; usesPersonas=false ignores the persona',
  );
  assert(
    inlineTrace.messages.some(
      (m) => m.role === 'user' && m.content === 'Inline prologue for Inline Hero.',
    ),
    'inline template emits its prologue',
  );
  assert(inlineTrace.namePrefill === 'Inline Hero:', 'inline template enables name prefixing');
  assert(
    inlineTrace.reasoningPrefill === 'Inline reasoning for Inline Hero.' &&
      inlineTrace.messagePrefill === 'Inline answer for User:',
    'inline custom templates expose and macro-render both assistant prefills',
  );

  console.log('== per-conversation scenario override ==');
  const scenarioChar = await req<{ id: number }>('POST', '/api/characters', {
    name: 'Scenario Hero',
    scenario: 'The character scenario for {{char}}.',
    customTemplate: {
      content: '{{#if scenario}}Scene: {{scenario}}{{/if}}',
      userPrologue: '',
      reasoningPrefill: '',
      messagePrefill: '',
      prefixNames: false,
      usesPersonas: true,
    },
  });
  const scenarioConv = await req<Conversation>('POST', '/api/conversations', {
    characterId: scenarioChar.id,
  });
  let scenarioTrace = await fetchTrace(scenarioConv.id);
  assert(
    scenarioTrace.messages.some(
      (message) =>
        message.role === 'system' &&
        message.content === 'Scene: The character scenario for Scenario Hero.',
    ),
    'conversation inherits the character scenario by default',
  );
  const scenarioUpdated = (await patchConversation(scenarioConv.id, {
    scenarioOverride: 'A private scene for {{char}}.',
  })) as Conversation;
  assert(
    scenarioUpdated.scenarioOverride === 'A private scene for {{char}}.',
    'scenario override persists on the conversation',
  );
  scenarioTrace = await fetchTrace(scenarioConv.id);
  assert(
    scenarioTrace.messages.some(
      (message) =>
        message.role === 'system' &&
        message.content === 'Scene: A private scene for Scenario Hero.',
    ),
    'prompt assembly uses the conversation scenario override',
  );
  const scenarioCopy = await req<Conversation>(
    'POST',
    `/api/conversations/${scenarioConv.id}/duplicate`,
  );
  assert(
    scenarioCopy.scenarioOverride === scenarioUpdated.scenarioOverride,
    'conversation duplication preserves the scenario override',
  );
  const emptyScenario = (await patchConversation(scenarioConv.id, {
    scenarioOverride: '',
  })) as Conversation;
  scenarioTrace = await fetchTrace(scenarioConv.id);
  assert(
    emptyScenario.scenarioOverride === '' &&
      !scenarioTrace.messages.some((message) => message.role === 'system'),
    'an empty override deliberately suppresses the scenario',
  );
  const inheritedScenario = (await patchConversation(scenarioConv.id, {
    scenarioOverride: null,
  })) as Conversation;
  scenarioTrace = await fetchTrace(scenarioConv.id);
  assert(
    inheritedScenario.scenarioOverride === null &&
      scenarioTrace.messages.some((message) =>
        message.content.includes('The character scenario for Scenario Hero.'),
      ),
    'clearing the override restores the character scenario',
  );

  console.log('== terminal SSE data without a newline is preserved ==');
  await makeNextMockResponseEndWithoutNewline();
  const terminalSend = await sendMessage(conv2.id, 'terminal SSE event');
  const terminalFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === terminalSend.assistantMessageId,
    'terminal SSE generation finished',
  );
  assert(
    terminalFinal.t === 'final' && terminalFinal.message.content.endsWith('TERMINAL_NO_NEWLINE'),
    'final unterminated SSE event is persisted',
  );

  console.log('== per-conversation endpoint override ==');
  const smallEndpoint = await req<{ id: number }>('POST', '/api/endpoints', {
    name: 'mock-small',
    baseUrl: MOCK_URL,
  });
  const overridden = await req<{ endpointId: number | null }>(
    'PATCH',
    `/api/conversations/${conv2.id}`,
    await branchBody(conv2.id, { endpointId: smallEndpoint.id }),
  );
  assert(overridden.endpointId === smallEndpoint.id, 'endpoint override persisted');
  const defaultModelSend = await sendMessage(conv2.id, 'use the endpoint default');
  const defaultModelFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === defaultModelSend.assistantMessageId,
    'default-model generation finished',
  );
  const defaultModelSeen = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as { completion: { hasModel: boolean } | null };
  assert(
    defaultModelFinal.t === 'final' &&
      defaultModelFinal.message.model === null &&
      defaultModelSeen.completion?.hasModel === false,
    'an endpoint without a selected model omits model from the upstream request',
  );
  await req('PATCH', `/api/endpoints/${smallEndpoint.id}`, { model: 'mock-small' });
  const overrideSend = await sendMessage(conv2.id, 'which model?');
  const overrideFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === overrideSend.assistantMessageId,
    'override generation finished',
  );
  assert(
    overrideFinal.t === 'final' && overrideFinal.message.model === 'mock-small',
    'generation uses the conversation endpoint override',
  );
  await patchConversation(conv2.id, { endpointId: null });
  const revertSend = await sendMessage(conv2.id, 'back to global');
  const revertFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === revertSend.assistantMessageId,
    'reverted generation finished',
  );
  assert(
    revertFinal.t === 'final' && revertFinal.message.model === 'mock-large',
    'clearing the override falls back to the global endpoint',
  );
}
