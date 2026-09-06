import type { Message, Settings } from '@minitavern/shared';
import {
  assert,
  req,
  expectStatus,
  tree,
  branchBody,
  branchBodyAt,
  branchPath,
  patchConversation,
  sendMessage,
  failNextMockRequests,
  putSettings,
} from './helpers.ts';
import type { ChatFixture } from './chat.ts';

export async function testSpeculation(fixture: Pick<ChatFixture, 'ws'>) {
  const { ws } = fixture;

  console.log('== background swipe generation stays one reply ahead ==');
  assert(
    !(await req<Settings>('GET', '/api/settings')).parallelBackgroundSwipeGeneration,
    'background swipes wait for the primary reply by default',
  );
  await putSettings({ backgroundSwipeGeneration: false });
  const backgroundConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(backgroundConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === backgroundConv.id,
    'background-swipe conversation tree',
  );
  const backgroundSend = await sendMessage(backgroundConv.id, 'prepare swipe choices');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === backgroundSend.assistantMessageId,
    'foreground swipe reply finished',
  );
  await putSettings({ backgroundSwipeGeneration: true });
  const preparedTree = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === backgroundConv.id &&
      e.activeLeafId === backgroundSend.assistantMessageId &&
      e.nodes.some(
        (node) =>
          node.parentId === backgroundSend.userMessageId &&
          node.id !== backgroundSend.assistantMessageId &&
          node.status === 'streaming',
      ),
    'one inactive swipe starts in the background',
  );
  if (preparedTree.t !== 'treePatch') throw new Error('unreachable');
  const prepared = preparedTree.nodes.find(
    (node) =>
      node.parentId === backgroundSend.userMessageId &&
      node.id !== backgroundSend.assistantMessageId,
  )!;
  assert(
    preparedTree.activeLeafId === backgroundSend.assistantMessageId,
    'API-only setting enable starts preparation without changing the visible reply',
  );
  await expectStatus(
    'POST',
    `/api/generations/${prepared.id}/stop`,
    { expectedGenerationToken: prepared.generationToken },
    409,
  );
  await req('POST', `/api/messages/${prepared.id}/activate`, {
    expectedActiveLeafId: backgroundSend.assistantMessageId,
    expectedMutationRevision: preparedTree.mutationRevision,
  });
  await expectStatus(
    'POST',
    `/api/messages/${prepared.id}/activate`,
    await branchBodyAt(backgroundConv.id, backgroundSend.assistantMessageId),
    409,
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === prepared.id,
    'activated background swipe finished',
  );
  const nextPreparedTree = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === backgroundConv.id &&
      e.activeLeafId === prepared.id &&
      e.nodes.filter((node) => node.parentId === backgroundSend.userMessageId).length === 3,
    'activating the prepared swipe starts exactly one successor',
  );
  if (nextPreparedTree.t !== 'treePatch') throw new Error('unreachable');
  const thirdSwipe = nextPreparedTree.nodes.find(
    (node) =>
      node.parentId === backgroundSend.userMessageId &&
      node.id !== backgroundSend.assistantMessageId &&
      node.id !== prepared.id,
  )!;
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === thirdSwipe.id,
    'successor background swipe finished',
  );
  const backgroundSnap = await tree(backgroundConv.id);
  assert(
    backgroundSnap.activeLeafId === prepared.id &&
      backgroundSnap.messages.filter((message) => message.parentId === backgroundSend.userMessageId)
        .length === 3,
    'only one unread swipe is prepared ahead of the reply being read',
  );

  const beforeProtectedResume = backgroundSnap.messages.find(
    (message) => message.id === prepared.id,
  )!.content.length;
  await req('POST', `/api/messages/${prepared.id}/continue`, {
    expectedActiveLeafId: prepared.id,
    expectedMutationRevision: backgroundSnap.mutationRevision,
  });
  await expectStatus(
    'PATCH',
    `/api/conversations/${backgroundConv.id}`,
    await branchBody(backgroundConv.id, { speakerName: 'Rejected while foreground streams' }),
    409,
  );
  assert(
    (await tree(backgroundConv.id)).messages.some((message) => message.id === thirdSwipe.id),
    'rejected context edits do not delete completed speculative swipes',
  );
  await ws.waitFor(
    (e) =>
      e.t === 'final' &&
      e.message.id === prepared.id &&
      e.message.content.length > beforeProtectedResume,
    'protected foreground resume finishes',
  );

  console.log('== in-place history edits invalidate completed background swipes ==');
  await req(
    'PATCH',
    `/api/messages/${backgroundSend.userMessageId}`,
    await branchBodyAt(backgroundConv.id, prepared.id, { content: 'edited swipe context' }),
  );
  const editedTree = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === backgroundConv.id &&
      !e.nodes.some((node) => node.id === thirdSwipe.id) &&
      e.nodes.some(
        (node) =>
          node.parentId === backgroundSend.userMessageId &&
          node.id > thirdSwipe.id &&
          node.generationKind === 'speculative',
      ),
    'history edit refills the speculative swipe',
  );
  if (editedTree.t !== 'treePatch') throw new Error('unreachable');
  assert(
    !editedTree.nodes.some((node) => node.id === thirdSwipe.id),
    'completed speculative reply is removed after an ancestor edit',
  );
  const editedSwipe = editedTree.nodes.find(
    (node) =>
      node.parentId === backgroundSend.userMessageId &&
      node.id > thirdSwipe.id &&
      node.generationKind === 'speculative',
  )!;
  const editedFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === editedSwipe.id,
    'fresh swipe after history edit',
  );
  assert(
    editedFinal.t === 'final' && editedFinal.message.content.includes('edited swipe context'),
    'replacement swipe is generated from the edited history',
  );
  await patchConversation(backgroundConv.id, { speakerName: 'Changed' });
  const invalidatedTree = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === backgroundConv.id &&
      !e.nodes.some((node) => node.id === editedSwipe.id) &&
      e.nodes.some((node) => node.id > editedSwipe.id && node.generationKind === 'speculative'),
    'conversation context change refills the speculative swipe',
  );
  if (invalidatedTree.t !== 'treePatch') throw new Error('unreachable');
  assert(
    !invalidatedTree.nodes.some((node) => node.id === editedSwipe.id) &&
      invalidatedTree.nodes.some(
        (node) => node.id > editedSwipe.id && node.generationKind === 'speculative',
      ),
    'context changes replace stale speculation and preserve one-ahead generation',
  );
  await putSettings({ backgroundSwipeGeneration: false });

  console.log('== failed background generations keep retrying ==');
  const retryConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(retryConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === retryConv.id,
    'retry conversation tree',
  );
  const retrySend = await sendMessage(retryConv.id, 'retry background preparation');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === retrySend.assistantMessageId,
    'retry conversation foreground reply',
  );
  await failNextMockRequests(2);
  await putSettings({ backgroundSwipeGeneration: true });
  const retriedFinal = await ws.waitFor(
    (e) =>
      e.t === 'final' &&
      e.message.parentId === retrySend.userMessageId &&
      e.message.id !== retrySend.assistantMessageId &&
      e.message.status === 'done',
    'background preparation succeeds after two failures',
    30_000,
  );
  assert(
    retriedFinal.t === 'final' && retriedFinal.message.generationKind === 'speculative',
    'background refill retries transient failures with backoff',
  );
  await putSettings({ backgroundSwipeGeneration: false });

  console.log('== speculative swipes wait for a subscribed client ==');
  await putSettings({ backgroundSwipeGeneration: true });
  // ws still watches retryConv; the new conversation has no subscriber.
  const gatedConv = await req<{ id: number }>('POST', '/api/conversations', {});
  const gatedSend = await sendMessage(gatedConv.id, 'no spectators here');
  let gatedReply: Message | undefined;
  for (let i = 0; i < 60 && !gatedReply; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const message = (await tree(gatedConv.id)).messages.find(
      (m) => m.id === gatedSend.assistantMessageId,
    );
    if (message?.status === 'done') gatedReply = message;
  }
  assert(gatedReply != null, 'unwatched foreground reply finished');
  // An ungated onDone spawns within a microtask; 1.5s leaves ample time to detect it.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const unwatchedSnap = await tree(gatedConv.id);
  assert(
    unwatchedSnap.messages.filter((m) => m.parentId === gatedSend.userMessageId).length === 1 &&
      !unwatchedSnap.messages.some((m) => m.generationKind === 'speculative'),
    'no speculative swipe is generated while nobody is subscribed',
  );
  ws.sub(gatedConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === gatedConv.id,
    'gated conversation tree after subscribing',
  );
  const gatedPreparedTree = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === gatedConv.id &&
      e.nodes.some(
        (node) =>
          node.parentId === gatedSend.userMessageId &&
          node.id !== gatedSend.assistantMessageId &&
          node.status === 'streaming',
      ),
    'subscribing starts the held-off speculative swipe',
  );
  if (gatedPreparedTree.t !== 'treePatch') throw new Error('unreachable');
  const gatedPrepared = gatedPreparedTree.nodes.find(
    (node) => node.parentId === gatedSend.userMessageId && node.id !== gatedSend.assistantMessageId,
  )!;
  const gatedFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === gatedPrepared.id,
    'gated speculative swipe finished',
  );
  assert(
    gatedFinal.t === 'final' && gatedFinal.message.generationKind === 'speculative',
    'the speculative swipe generates once a client is watching',
  );
  await putSettings({ backgroundSwipeGeneration: false });

  console.log('== Delete swipe safely promotes a completed speculative alternative ==');
  const promotedConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(promotedConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === promotedConv.id,
    'speculative-promotion conversation tree',
  );
  const promotedBase = await sendMessage(promotedConv.id, 'promote the prepared alternative');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === promotedBase.assistantMessageId,
    'speculative-promotion foreground reply',
  );
  await putSettings({ backgroundSwipeGeneration: true });
  const promotedPreparedPatch = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === promotedConv.id &&
      e.nodes.some(
        (node) =>
          node.parentId === promotedBase.userMessageId &&
          node.id !== promotedBase.assistantMessageId &&
          node.generationKind === 'speculative',
      ),
    'prepared replacement for Delete swipe',
  );
  if (promotedPreparedPatch.t !== 'treePatch') throw new Error('unreachable');
  const promotedPrepared = promotedPreparedPatch.nodes.find(
    (node) =>
      node.parentId === promotedBase.userMessageId &&
      node.id !== promotedBase.assistantMessageId &&
      node.generationKind === 'speculative',
  )!;
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === promotedPrepared.id,
    'prepared replacement finishes before deletion',
  );
  await req(
    'DELETE',
    await branchPath(
      promotedConv.id,
      `/api/messages/${promotedBase.assistantMessageId}/swipe`,
      promotedBase.assistantMessageId,
    ),
  );
  let promotedSnap = await tree(promotedConv.id);
  assert(
    promotedSnap.activeLeafId === promotedPrepared.id &&
      promotedSnap.messages.find((message) => message.id === promotedPrepared.id)
        ?.generationKind === 'normal',
    'Delete swipe normalizes the completed speculative replacement before activation',
  );
  const promotedDescendant = await sendMessage(promotedConv.id, 'keep this descendant');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === promotedDescendant.assistantMessageId,
    'descendant below promoted replacement finishes',
  );
  await req(
    'PATCH',
    `/api/messages/${promotedDescendant.userMessageId}`,
    await branchBodyAt(promotedConv.id, promotedDescendant.assistantMessageId, {
      content: 'keep this edited descendant',
    }),
  );
  promotedSnap = await tree(promotedConv.id);
  assert(
    promotedSnap.activeLeafId === promotedDescendant.assistantMessageId &&
      promotedSnap.messages.some((message) => message.id === promotedPrepared.id) &&
      promotedSnap.messages.some((message) => message.id === promotedDescendant.userMessageId) &&
      promotedSnap.messages.some((message) => message.id === promotedDescendant.assistantMessageId),
    'later speculation invalidation preserves the promoted branch and descendants',
  );
  await putSettings({ backgroundSwipeGeneration: false });
}
