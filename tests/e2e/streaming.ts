import {
  assert,
  req,
  expectStatus,
  WsClient,
  branchBody,
  branchBodyAt,
  branchPath,
  stopGeneration,
  sendMessage,
} from './helpers.ts';
import type { ChatFixture } from './chat.ts';

export async function testStreaming(fixture: Pick<ChatFixture, 'conv' | 'ws'>) {
  const { conv, ws } = fixture;

  console.log('== swipe past an in-flight generation ==');
  const sendResult = await sendMessage(conv.id, 'Long answer please');
  await ws.waitFor(
    (e) => e.t === 'delta' && e.mid === sendResult.assistantMessageId,
    'stream started',
  );
  await expectStatus(
    'DELETE',
    await branchPath(
      conv.id,
      `/api/messages/${sendResult.userMessageId}`,
      sendResult.assistantMessageId,
    ),
    undefined,
    409,
  );
  await expectStatus(
    'PATCH',
    `/api/messages/${sendResult.userMessageId}`,
    await branchBodyAt(conv.id, sendResult.assistantMessageId, {
      content: 'changed while streaming',
    }),
    409,
  );
  const nextSwipe = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${sendResult.assistantMessageId}/advance`,
    await branchBodyAt(conv.id, sendResult.assistantMessageId),
  );
  if (nextSwipe.assistantMessageId == null) throw new Error('expected a generated swipe');
  const replaced = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === sendResult.assistantMessageId,
    'swiped-past generation stopped',
  );
  assert(
    replaced.t === 'final' && replaced.message.status === 'stopped',
    'swiping further stops and preserves the partial reply',
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === nextSwipe.assistantMessageId,
    'next swipe generation finished',
  );

  console.log('== stop mid-generation ==');
  const stoppedSend = await sendMessage(conv.id, 'Stop this answer');
  await ws.waitFor(
    (e) => e.t === 'delta' && e.mid === stoppedSend.assistantMessageId,
    'stoppable stream started',
  );
  await stopGeneration(conv.id, stoppedSend.assistantMessageId);
  const stopped = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === stoppedSend.assistantMessageId,
    'stopped finalization',
  );
  assert(stopped.t === 'final' && stopped.message.status === 'stopped', 'message marked stopped');

  console.log('== stale generation Stop cannot hit a resumed epoch ==');
  if (stopped.t !== 'final' || stopped.message.generationToken == null) {
    throw new Error('stopped generation has no token');
  }
  const firstGenerationToken = stopped.message.generationToken;
  await req(
    'POST',
    `/api/messages/${stoppedSend.assistantMessageId}/continue`,
    await branchBody(conv.id),
  );
  const resumedPatch = await ws.waitFor(
    (event) =>
      event.t === 'treePatch' &&
      event.nodes.some(
        (node) =>
          node.id === stoppedSend.assistantMessageId &&
          node.status === 'streaming' &&
          node.generationToken != null &&
          node.generationToken !== firstGenerationToken,
      ),
    'resumed generation token',
  );
  if (resumedPatch.t !== 'treePatch') throw new Error('unreachable');
  const resumedGenerationToken = resumedPatch.nodes.find(
    (node) => node.id === stoppedSend.assistantMessageId,
  )!.generationToken!;
  await expectStatus(
    'POST',
    `/api/generations/${stoppedSend.assistantMessageId}/stop`,
    { expectedGenerationToken: firstGenerationToken },
    409,
  );
  await req('POST', `/api/generations/${stoppedSend.assistantMessageId}/stop`, {
    expectedGenerationToken: resumedGenerationToken,
  });
  const resumedStopped = await ws.waitFor(
    (event) =>
      event.t === 'final' &&
      event.message.id === stoppedSend.assistantMessageId &&
      event.message.generationToken === resumedGenerationToken,
    'current resumed generation stops normally',
  );
  assert(
    resumedStopped.t === 'final' && resumedStopped.message.status === 'stopped',
    'only the matching generation token can stop a resumed message',
  );

  console.log('== mid-stream subscriber gets snapshot + remaining deltas ==');
  const send2 = await sendMessage(conv.id, 'Another one');
  await ws.waitFor(
    (e) => e.t === 'delta' && e.mid === send2.assistantMessageId,
    'second stream started',
  );
  const ws2 = new WsClient();
  await ws2.open();
  ws2.sub(conv.id);
  const treeEv = await ws2.waitFor((e) => e.t === 'tree', 'late-joiner tree snapshot');
  const finalEv = await ws2.waitFor(
    (e) => e.t === 'final' && e.message.id === send2.assistantMessageId,
    'late-joiner sees final',
  );
  if (treeEv.t !== 'tree' || finalEv.t !== 'final') throw new Error('unreachable');
  const snapshotContent = treeEv.messages.find((m) => m.id === send2.assistantMessageId)!.content;
  const lateDeltas = ws2.events
    .filter((e) => e.t === 'delta' && e.mid === send2.assistantMessageId)
    .map((e) => (e.t === 'delta' ? (e.d ?? '') : ''))
    .join('');
  assert(
    snapshotContent + lateDeltas === finalEv.message.content,
    'late-joiner snapshot + deltas reconstruct the full message',
  );
  ws2.close();

  return { stoppedSend, send2 };
}

export type StreamingFixture = Awaited<ReturnType<typeof testStreaming>>;
