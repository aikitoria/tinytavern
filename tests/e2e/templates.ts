import {
  MOCK_CONTROL,
  assert,
  req,
  expectStatus,
  WsClient,
  tree,
  fetchTrace,
  branchBody,
  branchQuery,
  patchConversation,
  sendMessage,
  makeNextMockResponseDieAfterContent,
  putSettings,
} from './helpers.ts';
import { DEFAULT_SYSTEM_PROMPT } from '@tinytavern/shared';
import type { ChatFixture } from './chat.ts';
import type { SetupFixture } from './setup.ts';

export async function testTemplates(
  fixture: Pick<ChatFixture, 'ws'> & Pick<SetupFixture, 'endpoint'>,
) {
  const { ws, endpoint } = fixture;

  console.log('== read-only defaults and editable copies ==');
  for (const table of ['presets', 'templates']) {
    const entities = await req<{ id: number; readOnly: boolean; content: string }[]>(
      'GET',
      `/api/${table}`,
    );
    const original = entities.find((entity) => entity.readOnly)!;
    assert(Boolean(original), `${table} has a protected default`);
    if (table === 'presets') {
      assert(
        original.content === DEFAULT_SYSTEM_PROMPT,
        'Default system prompt matches the requested text',
      );
    }
    await expectStatus(
      'PATCH',
      `/api/${table}/${original.id}`,
      { content: 'Cannot overwrite' },
      403,
    );
    await expectStatus('DELETE', `/api/${table}/${original.id}`, undefined, 403);
    const copy = await req<{ id: number; readOnly: boolean; content: string }>(
      'POST',
      `/api/${table}/${original.id}/duplicate`,
    );
    assert(
      !copy.readOnly && copy.content === original.content,
      `${table} default duplicates into an editable copy`,
    );
    const edited = await req<{ content: string }>('PATCH', `/api/${table}/${copy.id}`, {
      content: 'Custom copy',
    });
    assert(edited.content === 'Custom copy', `${table} duplicate can be edited`);
    await req('DELETE', `/api/${table}/${copy.id}`);
  }

  console.log('== templates: prologue, name prefixing, /char, resume ==');
  const tpl = await req<{ id: number }>('POST', '/api/templates', {
    name: 'e2e-prefix',
    content: '{{system}}',
    userPrologue: 'You are playing {{char}}.',
    reasoningPrefill: 'Reason first as {{char}} for {{user}}.',
    messagePrefill: 'Seeded reply to {{user}}: ',
    prefixNames: true,
  });
  const prevSettings = await req<{ defaultTemplateId: number | null }>('GET', '/api/settings');
  await putSettings({ defaultTemplateId: tpl.id });
  const conv2 = await req<{ id: number }>('POST', '/api/conversations', {});
  await patchConversation(conv2.id, { speakerName: 'Ari' });

  const trace = await fetchTrace(conv2.id);
  assert(
    trace.messages.some((m) => m.role === 'user' && m.content === 'You are playing Assistant.'),
    'template prologue emitted as fake user turn',
  );
  assert(trace.namePrefill === 'Ari:', 'name prefill uses the /char speaker');
  assert(
    trace.reasoningPrefill === 'Reason first as Assistant for Aiki.' &&
      trace.messagePrefill === 'Seeded reply to Aiki:',
    'template reasoning and message prefills render macros independently',
  );

  ws.sub(conv2.id);
  await fetch(`${MOCK_CONTROL}/control/clear-completions`, { method: 'POST' });
  const sent = await sendMessage(conv2.id, '  prefix check  ');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === sent.assistantMessageId,
    'prefixed generation finished',
  );
  let snap2 = await tree(conv2.id);
  const reply = snap2.messages.find((m) => m.id === sent.assistantMessageId)!;
  assert(reply.name === 'Ari', 'reply stamped with the /char speaker name');
  assert(
    reply.reasoning?.startsWith('Reason first as Assistant for Aiki.') === true &&
      reply.content.startsWith('Seeded reply to Aiki:'),
    'template prefills become part of the saved reasoning and message',
  );
  const seededCompletions = (await (await fetch(`${MOCK_CONTROL}/control/completions`)).json()) as {
    completions: {
      messages: { role: string; content: string; reasoning_content?: string }[];
    }[];
  };
  assert(
    seededCompletions.completions.some((completion) => {
      const prefill = completion.messages.at(-1);
      return (
        prefill?.role === 'assistant' &&
        prefill.content === 'Ari: Seeded reply to Aiki:' &&
        prefill.reasoning_content === 'Reason first as Assistant for Aiki.'
      );
    }),
    'fresh generation sends reasoning_content and visible content in one final assistant prefill',
  );

  console.log('== template reasoning prefill for image prompts ==');
  const imagePrefillConv = await req<{ id: number }>('POST', '/api/conversations', {});
  const imagePrefillWs = new WsClient();
  await imagePrefillWs.open();
  imagePrefillWs.sub(imagePrefillConv.id);
  await imagePrefillWs.waitFor(
    (event) => event.t === 'tree' && event.conversationId === imagePrefillConv.id,
    'image-prefill conversation subscribed',
  );
  await fetch(`${MOCK_CONTROL}/control/clear-completions`, { method: 'POST' });
  const imagePrompt = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${imagePrefillConv.id}/tool`,
    await branchBody(imagePrefillConv.id, {
      prompt: 'Describe {{char}} for {{user}}.',
      label: 'Image prompt',
    }),
  );
  const imagePromptFinal = await imagePrefillWs.waitFor(
    (event) => event.t === 'final' && event.message.id === imagePrompt.toolMessageId,
    'image prompt with reasoning prefill finished',
  );
  assert(
    imagePromptFinal.t === 'final' &&
      imagePromptFinal.message.role === 'tool' &&
      imagePromptFinal.message.reasoning?.startsWith('Reason first as Assistant for Aiki.') ===
        true &&
      !imagePromptFinal.message.content.startsWith('Seeded reply to Aiki:'),
    'image prompt saves the active template reasoning prefill but not its message prefill',
  );
  const imagePromptCompletion = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: {
      messages: { role: string; content: string; reasoning_content?: string }[];
    } | null;
  };
  assert(
    imagePromptCompletion.completion?.messages.at(-1)?.role === 'assistant' &&
      imagePromptCompletion.completion.messages.at(-1)?.content === '' &&
      imagePromptCompletion.completion.messages.at(-1)?.reasoning_content ===
        'Reason first as Assistant for Aiki.',
    'image prompt sends only the template reasoning prefill in its final assistant turn',
  );

  const revisedImagePrompt = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${imagePrompt.toolMessageId}/regenerate`,
    await branchBody(imagePrefillConv.id, { instruction: 'Make it moonlit.' }),
  );
  const revisedImagePromptFinal = await imagePrefillWs.waitFor(
    (event) => event.t === 'final' && event.message.id === revisedImagePrompt.assistantMessageId,
    'revised image prompt with reasoning prefill finished',
  );
  const revisedImagePromptCompletion = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: {
      messages: { role: string; content: string; reasoning_content?: string }[];
    } | null;
  };
  assert(
    revisedImagePromptFinal.t === 'final' &&
      revisedImagePromptFinal.message.reasoning?.startsWith(
        'Reason first as Assistant for Aiki.',
      ) === true &&
      revisedImagePromptCompletion.completion?.messages.at(-1)?.role === 'assistant' &&
      revisedImagePromptCompletion.completion.messages.at(-1)?.content === '' &&
      revisedImagePromptCompletion.completion.messages.at(-1)?.reasoning_content ===
        'Reason first as Assistant for Aiki.',
    'revised image prompt also applies only the active template reasoning prefill',
  );
  imagePrefillWs.close();
  const imagePrefillSnapshot = await tree(imagePrefillConv.id);
  await req(
    'DELETE',
    `/api/conversations/${imagePrefillConv.id}?${branchQuery(imagePrefillSnapshot)}`,
  );

  assert(
    reply.content.includes('Aiki: prefix check'),
    'history prefixed with persona name upstream',
  );
  const prefixedTrace = await fetchTrace(conv2.id);
  assert(
    prefixedTrace.messages.some(
      (message) => message.role === 'user' && message.content.endsWith('Aiki: prefix check'),
    ) && prefixedTrace.namePrefill === 'Ari:',
    'name prefixes use one space and prefills have no trailing space after role normalization',
  );
  assert(
    prefixedTrace.messages.some(
      (message) => message.role === 'assistant' && Boolean(message.reasoning_content),
    ),
    'assistant history replays persisted reasoning_content',
  );

  await patchConversation(conv2.id, { speakerName: 'Bob' });
  const regen = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${sent.assistantMessageId}/advance`,
    await branchBody(conv2.id),
  );
  if (regen.assistantMessageId == null) throw new Error('expected a newly generated swipe');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === regen.assistantMessageId,
    'speaker-preserving swipe finished',
  );
  snap2 = await tree(conv2.id);
  assert(
    snap2.messages.find((m) => m.id === regen.assistantMessageId)!.name === 'Ari',
    'a new swipe keeps the original speaker name',
  );

  const beforeResume = snap2.messages.find((m) => m.id === regen.assistantMessageId)!.content
    .length;
  await req(
    'POST',
    `/api/messages/${regen.assistantMessageId}/continue`,
    await branchBody(conv2.id),
  );
  await ws.waitFor(
    (e) =>
      e.t === 'final' &&
      e.message.id === regen.assistantMessageId &&
      e.message.content.length > beforeResume &&
      e.message.status === 'done',
    'resume appended to the same message',
  );
  const resumedCompletion = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: {
      messages: { role: string; content: string; reasoning_content?: string }[];
    } | null;
  };
  assert(
    resumedCompletion.completion?.messages.at(-1)?.role === 'assistant' &&
      Boolean(resumedCompletion.completion.messages.at(-1)?.reasoning_content),
    'continuation prefill replays reasoning_content with assistant content',
  );

  console.log('== reasoning-only template prefill ==');
  await req('PATCH', `/api/templates/${tpl.id}`, {
    prefixNames: false,
    messagePrefill: '',
  });
  await fetch(`${MOCK_CONTROL}/control/clear-completions`, { method: 'POST' });
  const reasoningOnlyPrefillSend = await sendMessage(conv2.id, 'continue from hidden reasoning');
  const reasoningOnlyPrefillFinal = await ws.waitFor(
    (event) =>
      event.t === 'final' && event.message.id === reasoningOnlyPrefillSend.assistantMessageId,
    'reasoning-only prefill generation finished',
  );
  assert(
    reasoningOnlyPrefillFinal.t === 'final' &&
      reasoningOnlyPrefillFinal.message.reasoning?.startsWith(
        'Reason first as Assistant for Aiki.',
      ) === true &&
      reasoningOnlyPrefillFinal.message.content.length > 0,
    'reasoning-only prefill is saved before newly generated reasoning and message content',
  );
  const reasoningOnlyPrefillRequests = (await (
    await fetch(`${MOCK_CONTROL}/control/completions`)
  ).json()) as {
    completions: {
      messages: { role: string; content: string; reasoning_content?: string }[];
    }[];
  };
  assert(
    reasoningOnlyPrefillRequests.completions.some((completion) => {
      const prefill = completion.messages.at(-1);
      return (
        prefill?.role === 'assistant' &&
        prefill.content === '' &&
        prefill.reasoning_content === 'Reason first as Assistant for Aiki.'
      );
    }),
    'reasoning-only prefill sends an empty visible assistant content with reasoning_content',
  );
  await req('PATCH', `/api/templates/${tpl.id}`, {
    prefixNames: true,
    reasoningPrefill: '',
    messagePrefill: '',
  });

  console.log('== endpoint can disable assistant prefills ==');
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { prefillMode: 'disabled' });
  const disabledNamedTrace = await fetchTrace(conv2.id);
  assert(
    disabledNamedTrace.namePrefill === null,
    'prompt trace omits the disabled endpoint prefill',
  );
  assert(
    disabledNamedTrace.messages
      .findLast((message) => message.role === 'user')
      ?.content.endsWith('<Note: Reply as Bob>') === true,
    'disabled prefill adds an explicit note for a non-default speaker',
  );
  await req('PATCH', `/api/templates/${tpl.id}`, {
    speakerHandoffTemplate: 'CUSTOM SPEAKER {{speaker}}',
  });
  const customSpeakerTrace = await fetchTrace(conv2.id);
  assert(
    customSpeakerTrace.messages
      .findLast((message) => message.role === 'user')
      ?.content.endsWith('CUSTOM SPEAKER Bob') === true,
    'speaker handoff uses the selected template',
  );
  await req('PATCH', `/api/templates/${tpl.id}`, { speakerHandoffTemplate: '' });
  const emptySpeakerTrace = await fetchTrace(conv2.id);
  assert(
    !emptySpeakerTrace.messages.some(
      (message) =>
        message.content.includes('<Note: Reply as') || message.content.includes('CUSTOM SPEAKER'),
    ),
    'empty speaker handoff introduces no default instruction',
  );
  await req('PATCH', `/api/templates/${tpl.id}`, {
    speakerHandoffTemplate: '<Note: Reply as {{speaker}}>',
  });
  const noPrefillSend = await sendMessage(conv2.id, 'no prefill, please');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === noPrefillSend.assistantMessageId,
    'generation with prefills disabled finished',
  );
  const noPrefillCompletion = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: { lastMessageRole: string | null; continueFinalMessage: boolean } | null;
  };
  assert(
    noPrefillCompletion.completion?.lastMessageRole === 'user' &&
      noPrefillCompletion.completion.continueFinalMessage === false,
    'disabled endpoint omits speaker-name prefill and native continuation flag',
  );

  const noPrefillBeforeResume = (await tree(conv2.id)).messages.find(
    (m) => m.id === noPrefillSend.assistantMessageId,
  )!.content.length;
  await expectStatus(
    'POST',
    `/api/messages/${noPrefillSend.assistantMessageId}/continue`,
    await branchBody(conv2.id),
    400,
  );
  assert(
    (await tree(conv2.id)).messages.find((m) => m.id === noPrefillSend.assistantMessageId)?.content
      .length === noPrefillBeforeResume,
    'disabled endpoint rejects resume without modifying the existing reply',
  );

  await makeNextMockResponseDieAfterContent('Bob: DISABLED_PARTIAL');
  const disabledPartial = await sendMessage(conv2.id, 'disabled partial retry safety');
  const disabledPartialFinal = await ws.waitFor(
    (event) => event.t === 'final' && event.message.id === disabledPartial.assistantMessageId,
    'disabled-prefill partial failure finalizes',
  );
  assert(
    disabledPartialFinal.t === 'final' &&
      disabledPartialFinal.message.status === 'error' &&
      disabledPartialFinal.message.content === 'DISABLED_PARTIAL',
    'disabled prefills neither concatenate a restarted answer nor leak a matching speaker prefix',
  );

  await patchConversation(conv2.id, { speakerName: null });
  const disabledSwitchBackTrace = await fetchTrace(conv2.id);
  assert(
    disabledSwitchBackTrace.messages
      .findLast((message) => message.role === 'user')
      ?.content.endsWith('<Note: Reply as Assistant>') === true,
    'disabled prefill explicitly notes a switch back to the default speaker',
  );
  const defaultSpeakerConv = await req<{ id: number }>('POST', '/api/conversations', {});
  const disabledDefaultTrace = await fetchTrace(defaultSpeakerConv.id);
  assert(
    !disabledDefaultTrace.messages.some((message) => message.content.includes('<Note: Reply as ')),
    'ordinary default-to-default speaking adds no disabled-prefill note',
  );
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { prefillMode: 'none' });

  const clearedTemplates = await putSettings({ defaultTemplateId: null });
  assert(
    clearedTemplates.defaultTemplateId === null,
    'defaultTemplateId can be cleared without selecting a hidden template',
  );
  await putSettings({ defaultTemplateId: prevSettings.defaultTemplateId });

  return { tpl, prevSettings, conv2 };
}

export type TemplatesFixture = Awaited<ReturnType<typeof testTemplates>>;
