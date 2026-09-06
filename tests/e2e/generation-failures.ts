import {
  MOCK_CONTROL,
  assert,
  req,
  expectStatus,
  tree,
  branchBody,
  branchBodyAt,
  stopGeneration,
  sendMessage,
} from './helpers.ts';
import type { TemplatesFixture } from './templates.ts';
import type { ImagesFixture } from './images.ts';
import type { ChatFixture } from './chat.ts';

export async function testGenerationFailures(
  fixture: Pick<TemplatesFixture, 'conv2'> &
    Pick<ImagesFixture, 'COMFY_WORKFLOW' | 'waitForImageState'> &
    Pick<ChatFixture, 'ws'>,
) {
  const { conv2, COMFY_WORKFLOW, ws, waitForImageState } = fixture;

  console.log('== comfy render failures surface and are retryable ==');

  await fetch(`${MOCK_CONTROL}/control/comfy-fail-next?stage=prompt&count=1`, { method: 'POST' });
  const failSnap = await tree(conv2.id);
  const failRes = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    {
      prompt: 'Depict a failure.',
      label: 'Image prompt',
      expectedActiveLeafId: failSnap.activeLeafId,
      expectedMutationRevision: failSnap.mutationRevision,
      image: { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL },
    },
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === failRes.toolMessageId,
    'failing image tool text finished',
  );
  // Verify subscribers see failures without refetching.
  const failPatch = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.messages.some((m) => m.id === failRes.toolMessageId && m.genMeta?.imageError != null),
    'render failure broadcast to subscribers',
  );
  const failedMsg =
    failPatch.t === 'treePatch'
      ? failPatch.messages.find((m) => m.id === failRes.toolMessageId)
      : undefined;
  assert(
    failedMsg?.imagePending === false &&
      failedMsg.images.length === 0 &&
      failedMsg.status === 'done' &&
      failedMsg.genMeta?.imageError?.includes('rejected the workflow (500)') === true,
    'a rejected submission clears imagePending and surfaces genMeta.imageError',
  );

  // Retry without supplying a config exercises the stored snapshot.
  await req(
    'POST',
    `/api/messages/${failRes.toolMessageId}/render-image`,
    await branchBody(conv2.id),
  );
  const retried = await waitForImageState(
    failRes.toolMessageId,
    (m) => !m.imagePending && m.images.length === 1,
    'retry render finished',
  );
  assert(retried.genMeta?.imageError == null, 'a successful retry clears the stored imageError');

  await fetch(`${MOCK_CONTROL}/control/comfy-fail-next?stage=render&count=1`, { method: 'POST' });
  await req(
    'POST',
    `/api/messages/${failRes.toolMessageId}/render-image`,
    await branchBody(conv2.id),
  );
  const execFailed = await waitForImageState(
    failRes.toolMessageId,
    (m) => !m.imagePending && m.genMeta?.imageError != null,
    'execution failure surfaced',
  );
  assert(
    execFailed.genMeta?.imageError?.includes('KSampler [3] RuntimeError: mock render explosion') ===
      true,
    'execution failures relay the ComfyUI node traceback',
  );
  assert(execFailed.images.length === 1, 'a failed re-render keeps previously rendered images');

  console.log('== tool message guards ==');
  await expectStatus(
    'POST',
    `/api/messages/${failRes.toolMessageId}/advance`,
    await branchBodyAt(conv2.id, failRes.toolMessageId),
    400,
  );
  await expectStatus(
    'POST',
    `/api/messages/${failRes.toolMessageId}/continue`,
    await branchBodyAt(conv2.id, failRes.toolMessageId),
    400,
  );

  // Stopped generations must clear imagePending even though no render runs.
  const stopSnap = await tree(conv2.id);
  const stopRes = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    {
      prompt: 'Will be stopped.',
      label: 'Image prompt',
      expectedActiveLeafId: stopSnap.activeLeafId,
      expectedMutationRevision: stopSnap.mutationRevision,
      image: { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL },
    },
  );
  await stopGeneration(conv2.id, stopRes.toolMessageId);
  const stoppedMsg = (await tree(conv2.id)).messages.find((m) => m.id === stopRes.toolMessageId);
  assert(
    stoppedMsg?.status === 'stopped' &&
      stoppedMsg.imagePending === false &&
      stoppedMsg.images.length === 0,
    'stopping a tool generation clears its queued image render',
  );

  // Rendering accepts assistant messages, but resume must not disown a pending render.
  const renderSend = await sendMessage(conv2.id, 'draw the last reply');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === renderSend.assistantMessageId,
    'assistant reply to render finished',
  );
  await req(
    'POST',
    `/api/messages/${renderSend.assistantMessageId}/render-image`,
    await branchBody(conv2.id, { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL }),
  );
  await expectStatus(
    'POST',
    `/api/messages/${renderSend.assistantMessageId}/continue`,
    await branchBodyAt(conv2.id, renderSend.assistantMessageId),
    409,
  );
  const assistantRendered = await waitForImageState(
    renderSend.assistantMessageId,
    (m) => !m.imagePending && m.images.length === 1,
    'assistant-message render finished',
  );
  assert(assistantRendered.hasImageRender, 'fallback render config is stored for future swipes');
}
