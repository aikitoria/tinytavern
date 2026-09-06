import type { Character } from '@minitavern/shared';
import {
  assert,
  req,
  expectStatus,
  WsClient,
  tree,
  branchBody,
  sendMessage,
  activate,
  putSettings,
} from './helpers.ts';
import type { ChatFixture } from './chat.ts';

export async function testSpeculationLifecycle(fixture: Pick<ChatFixture, 'ws'>) {
  const { ws } = fixture;

  console.log('== characters can disable background swipe generation ==');
  const swipeCharacter = await req<Character>('POST', '/api/characters', {
    name: 'No background swipes',
    disableBackgroundSwipeGeneration: true,
  });
  assert(swipeCharacter.disableBackgroundSwipeGeneration, 'character speculation opt-out persists');
  const swipeCharacterCopy = await req<Character>(
    'POST',
    `/api/characters/${swipeCharacter.id}/duplicate`,
  );
  assert(
    swipeCharacterCopy.disableBackgroundSwipeGeneration,
    'duplicating a character preserves its speculation opt-out',
  );
  await expectStatus(
    'PATCH',
    `/api/characters/${swipeCharacter.id}`,
    { disableBackgroundSwipeGeneration: 'true' },
    400,
  );
  const characterSwipeConv = await req<{ id: number }>('POST', '/api/conversations', {
    characterId: swipeCharacter.id,
  });
  ws.sub(characterSwipeConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === characterSwipeConv.id,
    'character speculation conversation tree',
  );
  await putSettings({ backgroundSwipeGeneration: true });
  const characterReply = await sendMessage(characterSwipeConv.id, 'no automatic swipes');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === characterReply.assistantMessageId,
    'opted-out character foreground reply',
  );
  assert(
    !(await tree(characterSwipeConv.id)).messages.some((m) => m.generationKind === 'speculative'),
    'character opt-out suppresses speculation while the global setting is enabled',
  );
  const manualCharacterSwipe = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${characterReply.assistantMessageId}/advance`,
    await branchBody(characterSwipeConv.id),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === manualCharacterSwipe.assistantMessageId,
    'manual swipe still generates for an opted-out character',
  );
  assert(
    !(await tree(characterSwipeConv.id)).messages.some((m) => m.generationKind === 'speculative'),
    'manual swipes remain available without starting background successors',
  );
  await req('PATCH', `/api/characters/${swipeCharacter.id}`, {
    disableBackgroundSwipeGeneration: false,
  });
  const characterSpeculation = await waitForSpeculation(
    characterSwipeConv.id,
    manualCharacterSwipe.assistantMessageId,
  );
  await req('PATCH', `/api/characters/${swipeCharacter.id}`, {
    disableBackgroundSwipeGeneration: true,
  });
  await ws.waitFor(
    (e) =>
      e.t === 'final' && e.message.id === characterSpeculation && e.message.status === 'stopped',
    'disabling speculation for the character cancels its current background stream',
  );
  assert(
    !(await tree(characterSwipeConv.id)).messages.some((m) => m.generationKind === 'speculative'),
    'disabling speculation removes the prepared swipe without refilling',
  );
  await putSettings({ backgroundSwipeGeneration: false });
  await req('PATCH', `/api/characters/${swipeCharacter.id}`, {
    disableBackgroundSwipeGeneration: false,
  });
  assert(
    !(await tree(characterSwipeConv.id)).messages.some((m) => m.generationKind === 'speculative'),
    'clearing the character opt-out still respects the disabled global setting',
  );

  console.log('== speculation follows only the active branch leaf ==');
  const branchConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(branchConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === branchConv.id,
    'branch speculation conversation tree',
  );
  const branchBase = await sendMessage(branchConv.id, 'branch root');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === branchBase.assistantMessageId,
    'branch root reply',
  );
  const branchAlternative = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${branchBase.assistantMessageId}/advance`,
    await branchBody(branchConv.id),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === branchAlternative.assistantMessageId,
    'alternate branch reply',
  );
  await activate(branchConv.id, branchBase.assistantMessageId);
  const branchTail = await sendMessage(branchConv.id, 'deep branch tail');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === branchTail.assistantMessageId,
    'deep branch reply',
  );

  async function waitForSpeculation(conversationId: number, leafId: number): Promise<number> {
    const patch = await ws.waitFor(
      (e) =>
        e.t === 'treePatch' &&
        e.conversationId === conversationId &&
        e.activeLeafId === leafId &&
        e.nodes.some((m) => m.generationKind === 'speculative' && m.status === 'streaming'),
      `speculation at leaf ${leafId}`,
    );
    if (patch.t !== 'treePatch') throw new Error('unreachable');
    const speculative = patch.nodes.filter((m) => m.generationKind === 'speculative');
    const leaf = patch.nodes.find((m) => m.id === leafId)!;
    assert(
      speculative.length === 1 && speculative[0]!.parentId === leaf.parentId,
      'only the active leaf has a speculative sibling',
    );
    return speculative[0]!.id;
  }

  await putSettings({ backgroundSwipeGeneration: true });
  const tailSpeculation = await waitForSpeculation(branchConv.id, branchTail.assistantMessageId);
  await req(
    'POST',
    `/api/messages/${branchBase.assistantMessageId}/advance`,
    await branchBody(branchConv.id),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === tailSpeculation && e.message.status === 'stopped',
    'swiping an ancestor stops speculation on the abandoned tail',
  );
  const alternateSpeculation = await waitForSpeculation(
    branchConv.id,
    branchAlternative.assistantMessageId,
  );
  await activate(branchConv.id, branchBase.assistantMessageId);
  await ws.waitFor(
    (e) =>
      e.t === 'final' && e.message.id === alternateSpeculation && e.message.status === 'stopped',
    'activating the old branch stops speculation on the alternate branch',
  );
  const restoredBranch = await tree(branchConv.id);
  assert(
    restoredBranch.activeLeafId === branchTail.assistantMessageId &&
      !restoredBranch.messages.some(
        (m) => m.id === tailSpeculation || m.id === alternateSpeculation,
      ),
    'branch restoration retains the deep tail and removes both canceled speculative replies',
  );
  await putSettings({ backgroundSwipeGeneration: false });

  console.log('== leaving a conversation cancels its speculative stream ==');
  const emptyConv = await req<{ id: number }>('POST', '/api/conversations', {});
  for (const leave of ['switch', 'unsubscribe', 'disconnect'] as const) {
    const watched = await req<{ id: number }>('POST', '/api/conversations', {});
    ws.sub(watched.id);
    await ws.waitFor(
      (e) => e.t === 'tree' && e.conversationId === watched.id,
      `${leave} conversation tree`,
    );
    const reply = await sendMessage(watched.id, `cancel on ${leave}`);
    await ws.waitFor(
      (e) => e.t === 'final' && e.message.id === reply.assistantMessageId,
      `${leave} foreground reply`,
    );
    const viewer = new WsClient();
    await viewer.open();
    viewer.sub(watched.id);
    await viewer.waitFor(
      (e) => e.t === 'tree' && e.conversationId === watched.id,
      'second viewer subscribed',
    );
    await putSettings({ backgroundSwipeGeneration: true });
    const speculativeId = await waitForSpeculation(watched.id, reply.assistantMessageId);
    // Discard old snapshots so the wait confirms this subscription switch.
    ws.events = [];
    ws.sub(emptyConv.id);
    await ws.waitFor(
      (e) => e.t === 'tree' && e.conversationId === emptyConv.id,
      'first viewer switched away',
    );
    assert(
      (await tree(watched.id)).messages.some(
        (m) => m.id === speculativeId && m.status === 'streaming',
      ),
      'speculation continues while another viewer remains',
    );
    if (leave === 'disconnect') viewer.close();
    else viewer.sub(leave === 'switch' ? emptyConv.id : null);
    let abandoned = await tree(watched.id);
    for (let i = 0; i < 100 && abandoned.messages.some((m) => m.id === speculativeId); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      abandoned = await tree(watched.id);
    }
    assert(
      !abandoned.messages.some((m) => m.generationKind === 'speculative') &&
        abandoned.activeLeafId === reply.assistantMessageId,
      `${leave} cancels and removes speculation after the last viewer leaves`,
    );
    await activate(watched.id, reply.assistantMessageId);
    assert(
      !(await tree(watched.id)).messages.some((m) => m.generationKind === 'speculative'),
      'an API branch activation cannot start speculation in an unwatched conversation',
    );
    viewer.close();
    await putSettings({ backgroundSwipeGeneration: false });
  }

  return { swipeCharacter, emptyConv };
}

export type SpeculationLifecycleFixture = Awaited<ReturnType<typeof testSpeculationLifecycle>>;
