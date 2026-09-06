import {
  MOCK_CONTROL,
  assert,
  req,
  patchConversation,
  sendMessage,
  failNextMockRequests,
  makeNextMockResponseDieAfterContent,
  putSettings,
} from './helpers.ts';
import type { TemplatesFixture } from './templates.ts';
import type { SetupFixture } from './setup.ts';
import type { ChatFixture } from './chat.ts';

export async function testRetries(
  fixture: Pick<TemplatesFixture, 'conv2' | 'tpl' | 'prevSettings'> &
    Pick<SetupFixture, 'endpoint'> &
    Pick<ChatFixture, 'ws'>,
) {
  const { conv2, endpoint, ws, tpl, prevSettings } = fixture;

  console.log('== transient upstream failures auto-resume ==');
  await fetch(`${MOCK_CONTROL}/control/clear-completions`, { method: 'POST' });
  await failNextMockRequests(1);
  const resilientSend = await sendMessage(conv2.id, 'survive a blip');
  await req('PATCH', `/api/endpoints/${endpoint.id}`, {
    model: 'mock-small',
    genParams: { maxTokens: 77, reasoningEffort: 'low' },
  });
  const resilientFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === resilientSend.assistantMessageId,
    'generation survives one upstream 503',
    20_000,
  );
  assert(
    resilientFinal.t === 'final' &&
      resilientFinal.message.status === 'done' &&
      resilientFinal.message.content.length > 0 &&
      resilientFinal.message.model === 'mock-large',
    'foreground generation retries transparently with its snapshotted model',
  );
  const retryRequests = (await (await fetch(`${MOCK_CONTROL}/control/completions`)).json()) as {
    completions: {
      model: string | null;
      maxTokens: number | null;
      reasoningEffort: string | null;
      messages: unknown[];
    }[];
  };
  assert(
    retryRequests.completions.length === 2 &&
      retryRequests.completions.every(
        (request) =>
          request.model === 'mock-large' &&
          request.maxTokens === 321 &&
          request.reasoningEffort === 'high',
      ) &&
      JSON.stringify(retryRequests.completions[0]!.messages) ===
        JSON.stringify(retryRequests.completions[1]!.messages),
    'retry reuses snapshotted endpoint, model, parameters and prompt messages',
  );
  await req('PATCH', `/api/endpoints/${endpoint.id}`, {
    model: 'mock-large',
    genParams: { maxTokens: 321, reasoningEffort: 'high' },
  });
  await failNextMockRequests(3);
  const doomedSend = await sendMessage(conv2.id, 'exhaust the retries');
  const doomedFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === doomedSend.assistantMessageId,
    'generation fails once retries are exhausted',
    30_000,
  );
  assert(
    doomedFinal.t === 'final' &&
      doomedFinal.message.status === 'error' &&
      doomedFinal.message.generationKind === 'normal' &&
      doomedFinal.message.genMeta?.error?.includes('503') === true,
    'exhausted retries surface the upstream error on the message',
  );

  console.log('== held-back name prefix survives a transient retry ==');
  await putSettings({ defaultTemplateId: tpl.id });
  const holdbackConv = await req<{ id: number }>('POST', '/api/conversations', {});
  await patchConversation(holdbackConv.id, { speakerName: 'Hal' });
  ws.sub(holdbackConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === holdbackConv.id,
    'holdback conversation tree',
  );
  // "Ha" is held back as a possible "Hal:" prefix; retry must resume from that holdback.
  await fetch(`${MOCK_CONTROL}/control/clear-completions`, { method: 'POST' });
  await makeNextMockResponseDieAfterContent('Ha');
  const holdbackSend = await sendMessage(holdbackConv.id, 'holdback check');
  const holdbackFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === holdbackSend.assistantMessageId,
    'held-back prefix generation retried to completion',
    20_000,
  );
  assert(
    holdbackFinal.t === 'final' &&
      holdbackFinal.message.status === 'done' &&
      holdbackFinal.message.content.startsWith('HaYou said:'),
    'held-back prefix characters are kept exactly once across the retry',
  );
  const holdbackRetryCompletions = (await (
    await fetch(`${MOCK_CONTROL}/control/completions`)
  ).json()) as {
    completions: {
      messages: { role: string; content: string; reasoning_content?: string }[];
    }[];
  };
  const reasoningPrefill = holdbackRetryCompletions.completions
    .findLast((completion) => completion.messages.at(-1)?.role === 'assistant')
    ?.messages.at(-1);
  assert(
    reasoningPrefill?.reasoning_content?.includes('PARTIAL_RETRY_REASONING') === true,
    'partial retry prefill replays accumulated reasoning_content',
  );

  await fetch(`${MOCK_CONTROL}/control/reasoning-only`, { method: 'POST' });
  const reasoningOnlySend = await sendMessage(holdbackConv.id, 'reasoning-only history check');
  const reasoningOnlyFinal = await ws.waitFor(
    (event) => event.t === 'final' && event.message.id === reasoningOnlySend.assistantMessageId,
    'reasoning-only generation finished',
  );
  assert(
    reasoningOnlyFinal.t === 'final' &&
      reasoningOnlyFinal.message.content === '' &&
      reasoningOnlyFinal.message.reasoning?.includes('REASONING_ONLY_OUTPUT') === true,
    'reasoning-only assistant output is persisted',
  );
  await fetch(`${MOCK_CONTROL}/control/clear-completions`, { method: 'POST' });
  const afterReasoningOnly = await sendMessage(holdbackConv.id, 'continue after reasoning only');
  await ws.waitFor(
    (event) => event.t === 'final' && event.message.id === afterReasoningOnly.assistantMessageId,
    'generation after reasoning-only history finished',
  );
  const afterReasoningOnlyCompletion = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: {
      messages: { role: string; content: string; reasoning_content?: string }[];
    } | null;
  };
  assert(
    afterReasoningOnlyCompletion.completion?.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.reasoning_content?.includes('REASONING_ONLY_OUTPUT') === true,
    ),
    'reasoning-only assistant history is replayed upstream',
  );
  await putSettings({ defaultTemplateId: prevSettings.defaultTemplateId });
}
