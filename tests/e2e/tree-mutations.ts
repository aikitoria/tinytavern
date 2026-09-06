import type { Conversation, Message } from '@tinytavern/shared';
import {
  assert,
  req,
  expectStatus,
  tree,
  branchBody,
  branchBodyAt,
  branchQuery,
  branchPath,
  patchConversation,
  sendMessage,
  pathOf,
  treeLinkShape,
} from './helpers.ts';
import type { ChatFixture } from './chat.ts';
import type { StreamingFixture } from './streaming.ts';

export async function testTreeMutations(
  fixture: Pick<ChatFixture, 'conv' | 'ws'> & Pick<StreamingFixture, 'send2' | 'stoppedSend'>,
) {
  const { conv, send2, stoppedSend, ws } = fixture;

  console.log('== delete splices the message out of the chain ==');
  let snap = await tree(conv.id);
  const before = snap.messages.length;
  await req('DELETE', `/api/messages/${send2.assistantMessageId}?${branchQuery(snap)}`);
  snap = await tree(conv.id);
  assert(snap.messages.length === before - 1, 'message deleted');
  assert(snap.activeLeafId !== send2.assistantMessageId, 'active leaf repaired');
  await req(
    'DELETE',
    `/api/messages/${stoppedSend.assistantMessageId}?${branchQuery(snap, send2.userMessageId)}`,
  );
  snap = await tree(conv.id);
  assert(snap.messages.length === before - 2, 'only the deleted message is removed');
  assert(
    snap.messages.find((m) => m.id === send2.userMessageId)?.parentId ===
      stoppedSend.userMessageId && snap.activeLeafId === send2.userMessageId,
    'descendants reparent upward and the active leaf survives',
  );
  const blockSend = await sendMessage(conv.id, 'block root');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === blockSend.assistantMessageId,
    'block reply finished',
  );
  const blockSwipe = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${blockSend.assistantMessageId}/advance`,
    await branchBodyAt(conv.id, blockSend.assistantMessageId),
  );
  const swipeId = blockSwipe.assistantMessageId!;
  await ws.waitFor((e) => e.t === 'final' && e.message.id === swipeId, 'block swipe finished');
  const below = await sendMessage(conv.id, 'below the block');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === below.assistantMessageId,
    'below-block reply finished',
  );
  await req(
    'DELETE',
    await branchPath(conv.id, `/api/messages/${swipeId}`, below.assistantMessageId),
  );
  snap = await tree(conv.id);
  assert(
    !snap.messages.some((m) => m.id === swipeId || m.id === blockSend.assistantMessageId),
    'deleting a block removes its sibling swipes too',
  );
  assert(
    snap.messages.find((m) => m.id === below.userMessageId)?.parentId === blockSend.userMessageId &&
      snap.activeLeafId === below.assistantMessageId,
    'the visible chain below the block survives, reparented',
  );
  // Reparenting must travel in structural patches without resending survivor bodies.
  const splicePatch = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === conv.id &&
      e.nodes.some((n) => n.id === below.userMessageId && n.parentId === blockSend.userMessageId) &&
      !e.nodes.some((n) => n.id === swipeId),
    'splice reparenting travels over the WS patch',
  );
  assert(splicePatch.t === 'treePatch', 'splice patch received');

  console.log('== delete one swipe keeps its sibling branch ==');
  const swipeBase = await sendMessage(conv.id, 'swipe deletion root');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === swipeBase.assistantMessageId,
    'swipe-deletion first reply finished',
  );
  const keptDescendant = await sendMessage(conv.id, 'keep this branch');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === keptDescendant.assistantMessageId,
    'kept swipe descendant finished',
  );
  const doomedSwipe = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${swipeBase.assistantMessageId}/advance`,
    await branchBody(conv.id),
  );
  if (doomedSwipe.assistantMessageId == null) throw new Error('expected a sibling swipe');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === doomedSwipe.assistantMessageId,
    'doomed sibling swipe finished',
  );
  const doomedDescendant = await sendMessage(conv.id, 'delete this branch');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === doomedDescendant.assistantMessageId,
    'doomed swipe descendant finished',
  );
  const swipeDelete = await req<{ activeLeafId: number | null }>(
    'DELETE',
    await branchPath(
      conv.id,
      `/api/messages/${doomedSwipe.assistantMessageId}/swipe`,
      doomedDescendant.assistantMessageId,
    ),
  );
  snap = await tree(conv.id);
  assert(
    !snap.messages.some(
      (message) =>
        message.id === doomedSwipe.assistantMessageId ||
        message.id === doomedDescendant.userMessageId ||
        message.id === doomedDescendant.assistantMessageId,
    ),
    'delete swipe removes the selected alternative and its subtree',
  );
  assert(
    snap.messages.some((message) => message.id === swipeBase.assistantMessageId) &&
      snap.messages.some((message) => message.id === keptDescendant.userMessageId) &&
      snap.messages.some((message) => message.id === keptDescendant.assistantMessageId) &&
      swipeDelete.activeLeafId === keptDescendant.assistantMessageId &&
      snap.activeLeafId === keptDescendant.assistantMessageId,
    'delete swipe preserves and activates the remaining sibling branch',
  );

  console.log('== message move and duplicate ==');
  const mv = await sendMessage(conv.id, 'move me');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === mv.assistantMessageId,
    'move-me reply finished',
  );
  const mvParent = (await tree(conv.id)).messages.find((m) => m.id === mv.userMessageId)!.parentId;
  await req(
    'POST',
    `/api/messages/${mv.assistantMessageId}/move`,
    await branchBodyAt(conv.id, mv.assistantMessageId, { direction: 'up' }),
  );
  snap = await tree(conv.id);
  assert(
    snap.messages.find((m) => m.id === mv.assistantMessageId)?.parentId === mvParent &&
      snap.messages.find((m) => m.id === mv.userMessageId)?.parentId === mv.assistantMessageId &&
      snap.activeLeafId === mv.userMessageId,
    'move up rotates the block above its parent',
  );
  const movedCopy = await req<{ id: number }>('POST', `/api/conversations/${conv.id}/duplicate`);
  assert(
    JSON.stringify(treeLinkShape(await tree(movedCopy.id))) === JSON.stringify(treeLinkShape(snap)),
    'conversation duplicate preserves links when an older row has a newer parent after a move',
  );
  await req(
    'POST',
    `/api/messages/${mv.userMessageId}/move`,
    await branchBodyAt(conv.id, mv.userMessageId, { direction: 'up' }),
  );
  snap = await tree(conv.id);
  assert(
    snap.messages.find((m) => m.id === mv.userMessageId)?.parentId === mvParent &&
      snap.messages.find((m) => m.id === mv.assistantMessageId)?.parentId === mv.userMessageId &&
      snap.activeLeafId === mv.assistantMessageId,
    'moving back restores the original order',
  );
  const middleDup = await req<{ messageId: number; activeLeafId: number }>(
    'POST',
    `/api/messages/${mv.userMessageId}/duplicate`,
    await branchBodyAt(conv.id, mv.assistantMessageId),
  );
  snap = await tree(conv.id);
  const middleDupMsg = snap.messages.find((message) => message.id === middleDup.messageId)!;
  assert(
    middleDupMsg.parentId === mv.userMessageId &&
      middleDupMsg.activeChildId === mv.assistantMessageId &&
      snap.messages.find((message) => message.id === mv.assistantMessageId)?.parentId ===
        middleDup.messageId &&
      snap.activeLeafId === mv.assistantMessageId,
    'duplicating a middle message inserts the copy without losing its active continuation',
  );
  await req(
    'DELETE',
    await branchPath(conv.id, `/api/messages/${middleDup.messageId}`, mv.assistantMessageId),
  );
  snap = await tree(conv.id);
  assert(
    snap.messages.find((message) => message.id === mv.assistantMessageId)?.parentId ===
      mv.userMessageId && snap.activeLeafId === mv.assistantMessageId,
    'deleting the inserted middle copy restores the original chain',
  );
  const dup = await req<{ messageId: number; activeLeafId: number }>(
    'POST',
    `/api/messages/${mv.assistantMessageId}/duplicate`,
    await branchBodyAt(conv.id, mv.assistantMessageId),
  );
  snap = await tree(conv.id);
  const dupMsg = snap.messages.find((m) => m.id === dup.messageId);
  assert(
    dupMsg?.parentId === mv.assistantMessageId &&
      dupMsg.content === snap.messages.find((m) => m.id === mv.assistantMessageId)!.content &&
      snap.messages.find((m) => m.id === mv.assistantMessageId)?.activeChildId === dup.messageId &&
      snap.activeLeafId === dup.messageId,
    'duplicating the leaf inserts its copy directly below the source',
  );
  const sourceById = new Map(snap.messages.map((message) => [message.id, message]));
  const sourceBranchPath: Message[] = [];
  for (let id: number | null = mv.assistantMessageId; id != null;) {
    const message: Message = sourceById.get(id)!;
    sourceBranchPath.push(message);
    id = message.parentId;
  }
  sourceBranchPath.reverse();
  await patchConversation(conv.id, { scenarioOverride: 'A scenario kept by branches' });
  const sourceConversation = (await req<Conversation[]>('GET', '/api/conversations')).find(
    (conversation) => conversation.id === conv.id,
  )!;
  const branchedConversation = await req<Conversation>(
    'POST',
    `/api/messages/${mv.assistantMessageId}/branch-conversation`,
  );
  const branchedSnap = await tree(branchedConversation.id);
  const branchedPath = pathOf(branchedSnap);
  assert(
    branchedSnap.messages.length === sourceBranchPath.length &&
      branchedPath.length === sourceBranchPath.length &&
      branchedPath.every(
        (message, index) =>
          message.content === sourceBranchPath[index]!.content &&
          message.role === sourceBranchPath[index]!.role &&
          message.reasoning === sourceBranchPath[index]!.reasoning &&
          message.name === sourceBranchPath[index]!.name &&
          message.parentId === (index === 0 ? null : branchedPath[index - 1]!.id) &&
          message.activeChildId ===
            (index === branchedPath.length - 1 ? null : branchedPath[index + 1]!.id),
      ),
    'branch to new conversation copies only the selected message ancestry as one linear path',
  );
  assert(
    branchedConversation.characterId === sourceConversation.characterId &&
      branchedConversation.personaId === sourceConversation.personaId &&
      branchedConversation.endpointId === sourceConversation.endpointId &&
      branchedConversation.speakerName === sourceConversation.speakerName &&
      branchedConversation.scenarioOverride === sourceConversation.scenarioOverride &&
      branchedConversation.title.endsWith(' (branch)'),
    'branched conversation preserves source configuration and gets a branch title',
  );
  await expectStatus(
    'POST',
    `/api/messages/${dup.messageId}/move`,
    await branchBodyAt(conv.id, dup.messageId, { direction: 'down' }),
    400,
  );
}
