import {
  assert,
  req,
  expectStatus,
  tree,
  branchBody,
  branchBodyAt,
  sendMessage,
  pathOf,
} from './helpers.ts';
import type { ChatFixture } from './chat.ts';

export async function testMessageRanges(fixture: Pick<ChatFixture, 'ws'>) {
  const { ws } = fixture;

  console.log('== contiguous message-range move and delete ==');
  const rangeConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(rangeConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === rangeConv.id,
    'message-range conversation tree',
  );
  const rangeFirst = await sendMessage(rangeConv.id, 'range first');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === rangeFirst.assistantMessageId,
    'message-range first reply',
  );
  const rangeSecond = await sendMessage(rangeConv.id, 'range second');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === rangeSecond.assistantMessageId,
    'message-range second reply',
  );
  await req(
    'POST',
    '/api/message-ranges/move',
    await branchBody(rangeConv.id, {
      messageIds: [
        rangeFirst.assistantMessageId,
        rangeSecond.userMessageId,
        rangeSecond.assistantMessageId,
      ],
      direction: 'up',
      steps: 1,
    }),
  );
  let rangeSnap = await tree(rangeConv.id);
  assert(
    pathOf(rangeSnap)
      .map((message) => message.id)
      .join(',') ===
      [
        rangeFirst.assistantMessageId,
        rangeSecond.userMessageId,
        rangeSecond.assistantMessageId,
        rangeFirst.userMessageId,
      ].join(','),
    'moving a three-message selected range up keeps the full range together',
  );
  await req(
    'POST',
    '/api/message-ranges/move',
    await branchBody(rangeConv.id, {
      messageIds: [
        rangeFirst.assistantMessageId,
        rangeSecond.userMessageId,
        rangeSecond.assistantMessageId,
      ],
      direction: 'down',
      steps: 1,
    }),
  );
  rangeSnap = await tree(rangeConv.id);
  assert(
    pathOf(rangeSnap)
      .map((message) => message.id)
      .join(',') ===
      [
        rangeFirst.userMessageId,
        rangeFirst.assistantMessageId,
        rangeSecond.userMessageId,
        rangeSecond.assistantMessageId,
      ].join(','),
    'moving that selected range down restores the original order',
  );
  await expectStatus(
    'POST',
    '/api/message-ranges/move',
    await branchBody(rangeConv.id, {
      messageIds: [rangeFirst.userMessageId, rangeSecond.userMessageId],
      direction: 'up',
      steps: 1,
    }),
    400,
  );
  await expectStatus(
    'POST',
    '/api/message-ranges/move',
    await branchBody(rangeConv.id, {
      messageIds: [rangeSecond.userMessageId, rangeSecond.assistantMessageId],
      direction: 'up',
      steps: 3,
    }),
    400,
  );
  await req(
    'POST',
    '/api/message-ranges/move',
    await branchBody(rangeConv.id, {
      messageIds: [rangeSecond.userMessageId, rangeSecond.assistantMessageId],
      direction: 'up',
      steps: 2,
    }),
  );
  rangeSnap = await tree(rangeConv.id);
  assert(
    pathOf(rangeSnap)
      .map((message) => message.id)
      .join(',') ===
      [
        rangeSecond.userMessageId,
        rangeSecond.assistantMessageId,
        rangeFirst.userMessageId,
        rangeFirst.assistantMessageId,
      ].join(','),
    'a contiguous message range moves several slots as one block',
  );
  await req(
    'POST',
    '/api/message-ranges/move',
    await branchBody(rangeConv.id, {
      messageIds: [rangeSecond.userMessageId, rangeSecond.assistantMessageId],
      direction: 'down',
      steps: 2,
    }),
  );
  rangeSnap = await tree(rangeConv.id);
  assert(
    pathOf(rangeSnap)
      .map((message) => message.id)
      .join(',') ===
      [
        rangeFirst.userMessageId,
        rangeFirst.assistantMessageId,
        rangeSecond.userMessageId,
        rangeSecond.assistantMessageId,
      ].join(','),
    'a contiguous message range also moves several slots downward as one block',
  );
  await req(
    'POST',
    '/api/message-ranges/move',
    await branchBody(rangeConv.id, {
      messageIds: [rangeSecond.userMessageId, rangeSecond.assistantMessageId],
      direction: 'up',
      steps: 2,
    }),
  );
  await req(
    'POST',
    '/api/message-ranges/delete',
    await branchBody(rangeConv.id, {
      messageIds: [rangeSecond.userMessageId, rangeSecond.assistantMessageId],
    }),
  );
  rangeSnap = await tree(rangeConv.id);
  assert(
    pathOf(rangeSnap)
      .map((message) => message.id)
      .join(',') === [rangeFirst.userMessageId, rangeFirst.assistantMessageId].join(',') &&
      !rangeSnap.messages.some(
        (message) =>
          message.id === rangeSecond.userMessageId || message.id === rangeSecond.assistantMessageId,
      ),
    'deleting a contiguous range preserves and reconnects its continuation',
  );

  console.log('== delete-tail removes sibling swipes and descendant trees ==');
  const tailConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(tailConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === tailConv.id,
    'delete-tail conversation tree',
  );
  const tailFirst = await sendMessage(tailConv.id, 'tail root');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === tailFirst.assistantMessageId,
    'delete-tail first reply',
  );
  const oldBranch = await sendMessage(tailConv.id, 'old branch descendant');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === oldBranch.assistantMessageId,
    'delete-tail old descendant reply',
  );
  const sibling = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${tailFirst.assistantMessageId}/advance`,
    await branchBody(tailConv.id),
  );
  if (sibling.assistantMessageId == null) throw new Error('expected a fresh sibling swipe');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === sibling.assistantMessageId,
    'delete-tail sibling reply',
  );
  const newBranch = await sendMessage(tailConv.id, 'new branch descendant');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === newBranch.assistantMessageId,
    'delete-tail new descendant reply',
  );
  const tailBefore = await tree(tailConv.id);
  await expectStatus(
    'POST',
    `/api/conversations/${tailConv.id}/delete-tail`,
    await branchBodyAt(tailConv.id, tailFirst.assistantMessageId, { count: 3 }),
    409,
  );
  const tailDeleted = await req<{ activeLeafId: number | null; deletedSiblingRoots: number }>(
    'POST',
    `/api/conversations/${tailConv.id}/delete-tail`,
    {
      count: 3,
      expectedActiveLeafId: tailBefore.activeLeafId,
      expectedMutationRevision: tailBefore.mutationRevision,
    },
  );
  const tailAfter = await tree(tailConv.id);
  assert(
    tailDeleted.deletedSiblingRoots === 2 &&
      tailAfter.activeLeafId === tailFirst.userMessageId &&
      tailAfter.messages.length === 1 &&
      tailAfter.messages[0]!.id === tailFirst.userMessageId,
    'tail deletion removes all swipes at the cutoff and both descendant trees',
  );
  await req('POST', `/api/conversations/${tailConv.id}/delete-tail`, {
    count: 99,
    expectedActiveLeafId: tailAfter.activeLeafId,
    expectedMutationRevision: tailAfter.mutationRevision,
  });
  assert((await tree(tailConv.id)).messages.length === 0, 'large tail count clears the whole tree');
}
