import type { Settings } from '@tinytavern/shared';
import {
  MOCK_CONTROL,
  assert,
  req,
  expectStatus,
  tree,
  branchBody,
  stopGeneration,
  sendMessage,
  activate,
  putSettings,
} from './helpers.ts';
import type { ChatFixture } from './chat.ts';
import type { SpeculationLifecycleFixture } from './speculation-lifecycle.ts';

export async function testParallelSpeculation(
  fixture: Pick<ChatFixture, 'ws'> &
    Pick<SpeculationLifecycleFixture, 'swipeCharacter' | 'emptyConv'>,
) {
  const { ws, swipeCharacter, emptyConv } = fixture;

  console.log('== optional parallel background swipe generation ==');
  await expectStatus(
    'PUT',
    '/api/settings',
    {
      expectedRevision: (await req<Settings>('GET', '/api/settings')).revision,
      parallelBackgroundSwipeGeneration: 2,
    },
    400,
  );

  async function newSwipeConversation(characterId?: number) {
    const conversation = await req<{ id: number }>('POST', '/api/conversations', { characterId });
    ws.sub(conversation.id);
    await ws.waitFor(
      (e) => e.t === 'tree' && e.conversationId === conversation.id,
      'parallel swipe conversation subscribed',
    );
    return conversation.id;
  }

  async function assertParallelPair(conversationId: number, primaryId: number): Promise<number> {
    const snapshot = await tree(conversationId);
    const speculative = snapshot.messages.filter((m) => m.generationKind === 'speculative');
    const primary = snapshot.messages.find((m) => m.id === primaryId)!;
    assert(
      snapshot.activeLeafId === primaryId &&
        primary.status === 'streaming' &&
        speculative.length === 1 &&
        speculative[0]!.status === 'streaming' &&
        speculative[0]!.parentId === primary.parentId &&
        snapshot.messages.filter((m) => m.status === 'streaming').length === 2,
      'exactly the active primary and one unread sibling stream concurrently',
    );
    const speculativeId = speculative[0]!.id;
    await ws.waitFor((e) => e.t === 'delta' && e.mid === primaryId, 'primary emits live tokens');
    await ws.waitFor(
      (e) => e.t === 'delta' && e.mid === speculativeId,
      'parallel background swipe emits live tokens',
    );
    return speculativeId;
  }

  const toggleConv = await newSwipeConversation();
  await putSettings({ backgroundSwipeGeneration: true });
  const toggleReply = await sendMessage(toggleConv, 'toggle parallel speculation mid-stream');
  assert(
    !(await tree(toggleConv)).messages.some((m) => m.generationKind === 'speculative'),
    'serial mode does not start speculation during the primary response',
  );
  await putSettings({ parallelBackgroundSwipeGeneration: true });
  const toggledSpeculation = await assertParallelPair(toggleConv, toggleReply.assistantMessageId);
  await putSettings({ parallelBackgroundSwipeGeneration: false });
  const serialAgain = await tree(toggleConv);
  assert(
    serialAgain.messages.find((m) => m.id === toggleReply.assistantMessageId)?.status ===
      'streaming' && !serialAgain.messages.some((m) => m.id === toggledSpeculation),
    'disabling parallel mode cancels only the background stream',
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === toggleReply.assistantMessageId,
    'primary finishes after returning to serial mode',
  );
  ws.events = [];
  const serialSuccessor = await tree(toggleConv);
  assert(
    serialSuccessor.messages.some((m) => m.generationKind === 'speculative'),
    'serial mode still prepares a swipe after the primary finishes',
  );
  await putSettings({ backgroundSwipeGeneration: false, parallelBackgroundSwipeGeneration: true });

  for (const action of ['advance', 'activate'] as const) {
    const parallelConv = await newSwipeConversation();
    await putSettings({ backgroundSwipeGeneration: true });
    const primary = await sendMessage(parallelConv, `parallel swipe via ${action}`);
    const speculativeId = await assertParallelPair(parallelConv, primary.assistantMessageId);
    // Resubscription must not create another speculative stream.
    ws.sub(parallelConv);
    await req(
      'POST',
      `/api/messages/${action === 'advance' ? primary.assistantMessageId : speculativeId}/${action}`,
      await branchBody(parallelConv),
    );
    const nextSpeculativeId = await assertParallelPair(parallelConv, speculativeId);
    const promoted = await tree(parallelConv);
    assert(
      promoted.messages.find((m) => m.id === primary.assistantMessageId)?.status === 'stopped' &&
        promoted.messages.find((m) => m.id === speculativeId)?.generationKind === 'normal',
      `${action} stops the primary, promotes the prepared swipe, and refills just one successor`,
    );
    await stopGeneration(parallelConv, speculativeId);
    const stoppedPair = await tree(parallelConv);
    assert(
      !stoppedPair.messages.some((m) => m.status === 'streaming' || m.id === nextSpeculativeId),
      'stopping the promoted primary also cancels its parallel successor',
    );
    await req('POST', `/api/messages/${speculativeId}/continue`, await branchBody(parallelConv));
    await assertParallelPair(parallelConv, speculativeId);
    await stopGeneration(parallelConv, speculativeId);
    await putSettings({ backgroundSwipeGeneration: false });
  }

  console.log('== a parallel swipe may finish before its primary ==');
  const earlyConv = await newSwipeConversation();
  await putSettings({ backgroundSwipeGeneration: true });
  const delayResponse = await fetch(`${MOCK_CONTROL}/control/token-delay-next?ms=40`, {
    method: 'POST',
  });
  if (!delayResponse.ok) throw new Error('could not slow the next mock stream');
  const slowPrimary = await sendMessage(earlyConv, 'background reply finishes first');
  const earlySwipe = await assertParallelPair(earlyConv, slowPrimary.assistantMessageId);
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === earlySwipe && e.message.status === 'done',
    'background swipe finishes ahead of its primary',
  );
  const earlySnapshot = await tree(earlyConv);
  assert(
    earlySnapshot.messages.find((m) => m.id === slowPrimary.assistantMessageId)?.status ===
      'streaming' &&
      earlySnapshot.messages.filter((m) => m.generationKind === 'speculative').length === 1,
    'a completed unread swipe does not spawn additional background alternatives',
  );
  await activate(earlyConv, earlySwipe);
  const selectedEarly = await tree(earlyConv);
  assert(
    selectedEarly.activeLeafId === earlySwipe &&
      selectedEarly.messages.find((m) => m.id === slowPrimary.assistantMessageId)?.status ===
        'stopped' &&
      selectedEarly.messages.filter((m) => m.status === 'streaming').length === 1,
    'activating an already-completed parallel swipe stops its primary and prepares one successor',
  );
  await putSettings({ backgroundSwipeGeneration: false });

  const disabledParallelConv = await newSwipeConversation(swipeCharacter.id);
  await req('PATCH', `/api/characters/${swipeCharacter.id}`, {
    disableBackgroundSwipeGeneration: true,
  });
  await putSettings({ backgroundSwipeGeneration: true });
  const disabledParallelReply = await sendMessage(
    disabledParallelConv,
    'parallel character opt-out',
  );
  assert(
    !(await tree(disabledParallelConv)).messages.some((m) => m.generationKind === 'speculative'),
    'character opt-out also prevents parallel speculation',
  );
  await stopGeneration(disabledParallelConv, disabledParallelReply.assistantMessageId);
  await putSettings({ backgroundSwipeGeneration: false });

  const leavingParallelConv = await newSwipeConversation();
  await putSettings({ backgroundSwipeGeneration: true });
  const leavingPrimary = await sendMessage(
    leavingParallelConv,
    'leave while both responses stream',
  );
  const leavingSpeculation = await assertParallelPair(
    leavingParallelConv,
    leavingPrimary.assistantMessageId,
  );
  ws.events = [];
  ws.sub(emptyConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === emptyConv.id,
    'leave parallel conversation',
  );
  const leftParallel = await tree(leavingParallelConv);
  assert(
    leftParallel.messages.find((m) => m.id === leavingPrimary.assistantMessageId)?.status ===
      'streaming' && !leftParallel.messages.some((m) => m.id === leavingSpeculation),
    'leaving a parallel conversation cancels speculation and preserves the foreground reply',
  );
  await stopGeneration(leavingParallelConv, leavingPrimary.assistantMessageId);
  await putSettings({ backgroundSwipeGeneration: false, parallelBackgroundSwipeGeneration: false });
}
