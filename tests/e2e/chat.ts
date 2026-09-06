import type { Message, Settings } from '@minitavern/shared';
import {
  BASE,
  MOCK_CONTROL,
  assert,
  req,
  expectStatus,
  WsClient,
  tree,
  branchBody,
  branchBodyAt,
  branchQuery,
  patchConversation,
  stopGeneration,
  sendMessage,
  activate,
  pathOf,
} from './helpers.ts';

export async function testChat() {
  console.log('== core chat loop with streaming ==');
  const conv = await req<{ id: number }>('POST', '/api/conversations', { characterId: null });
  const ws = new WsClient();
  await ws.open();
  ws.sendRaw(null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const settingsAfterBadWs = await req<Settings>('GET', '/api/settings');
  assert(
    typeof settingsAfterBadWs.revision === 'number',
    'malformed WebSocket command does not crash the server',
  );
  ws.sub(conv.id);
  await ws.waitFor((e) => e.t === 'tree', 'initial tree push');
  const peer = new WsClient();
  await peer.open();
  peer.sub(conv.id);
  await peer.waitFor(
    (e) => e.t === 'tree' && e.conversationId === conv.id,
    'second frontend initial tree',
  );

  console.log('== duplicate and export include unflushed live generation buffers ==');
  const liveWs = new WsClient();
  await liveWs.open();
  const exportLiveConv = await req<{ id: number }>('POST', '/api/conversations', {});
  liveWs.sub(exportLiveConv.id);
  await liveWs.waitFor(
    (e) => e.t === 'tree' && e.conversationId === exportLiveConv.id,
    'live-export conversation tree',
  );
  const exportLiveSend = await sendMessage(exportLiveConv.id, 'export during first flush window');
  const exportDelta = await liveWs.waitFor(
    (e) => e.t === 'delta' && e.mid === exportLiveSend.assistantMessageId && !!e.d,
    'first visible live-export content delta',
  );
  if (exportDelta.t !== 'delta' || !exportDelta.d) throw new Error('unreachable');
  const exportResponse = await fetch(`${BASE}/api/conversations/${exportLiveConv.id}/export`);
  if (!exportResponse.ok) throw new Error(`live export failed: ${await exportResponse.text()}`);
  const liveExport = (await exportResponse.json()) as { messages: Message[] };
  assert(
    liveExport.messages
      .find((message) => message.id === exportLiveSend.assistantMessageId)
      ?.content.includes(exportDelta.d) === true,
    'conversation export includes content visible before the periodic DB flush',
  );
  await stopGeneration(exportLiveConv.id, exportLiveSend.assistantMessageId);

  const duplicateLiveConv = await req<{ id: number }>('POST', '/api/conversations', {});
  liveWs.sub(duplicateLiveConv.id);
  await liveWs.waitFor(
    (e) => e.t === 'tree' && e.conversationId === duplicateLiveConv.id,
    'live-duplicate source tree',
  );
  const duplicateLiveSend = await sendMessage(
    duplicateLiveConv.id,
    'duplicate during first flush window',
  );
  const duplicateDelta = await liveWs.waitFor(
    (e) => e.t === 'delta' && e.mid === duplicateLiveSend.assistantMessageId && !!e.d,
    'first visible live-duplicate content delta',
  );
  if (duplicateDelta.t !== 'delta' || !duplicateDelta.d) throw new Error('unreachable');
  const liveCopy = await req<{ id: number }>(
    'POST',
    `/api/conversations/${duplicateLiveConv.id}/duplicate`,
  );
  const liveCopyAssistant = (await tree(liveCopy.id)).messages.find(
    (message) => message.role === 'assistant',
  );
  assert(
    liveCopyAssistant?.status === 'stopped' && liveCopyAssistant.content.includes(duplicateDelta.d),
    'conversation duplicate preserves visible content before the periodic DB flush',
  );
  await stopGeneration(duplicateLiveConv.id, duplicateLiveSend.assistantMessageId);
  liveWs.close();

  const firstSend = await sendMessage(conv.id, '  Hello world  ');
  const [firstFinal, peerFinal] = await Promise.all([
    ws.waitFor(
      (e) => e.t === 'final' && e.message.id === firstSend.assistantMessageId,
      'first generation finished',
    ),
    peer.waitFor(
      (e) => e.t === 'final' && e.message.id === firstSend.assistantMessageId,
      'second frontend sees first generation finish',
    ),
  ]);
  assert(
    firstFinal.t === 'final' &&
      peerFinal.t === 'final' &&
      firstFinal.message.content === peerFinal.message.content &&
      peer.events.some(
        (event) => event.t === 'delta' && event.mid === firstSend.assistantMessageId,
      ),
    'two frontends receive the same streamed response',
  );
  peer.close();
  const deltas = ws.events.filter((e) => e.t === 'delta' && e.mid === firstSend.assistantMessageId);
  assert(deltas.length > 10, `stream relayed incrementally (${deltas.length} delta frames)`);
  assert(
    ws.events.some(
      (e) => e.t === 'delta' && e.mid === firstSend.assistantMessageId && 'r' in e && e.r,
    ),
    'reasoning deltas relayed',
  );

  let snap = await tree(conv.id);
  let path = pathOf(snap);
  assert(path.length === 2, 'path is [user, assistant]');
  assert(
    path[1]!.status === 'done' && path[1]!.content.includes('Hello world'),
    'assistant reply persisted',
  );
  assert(
    path[1]!.content.includes('You are Assistant speaking with Aiki.'),
    'macros substituted in system prompt',
  );
  assert(path[1]!.reasoning != null && path[1]!.reasoning.length > 0, 'reasoning persisted');
  const userMsg1 = path[0]!;
  const assistant1 = path[1]!;
  assert(userMsg1.content === 'Hello world', 'message boundaries are trimmed on write');

  console.log('== same-leaf stale mutations are revision-guarded ==');
  const beforeSameLeafEdit = await tree(conv.id);
  await req('PATCH', `/api/messages/${userMsg1.id}`, {
    content: userMsg1.content,
    expectedActiveLeafId: beforeSameLeafEdit.activeLeafId,
    expectedMutationRevision: beforeSameLeafEdit.mutationRevision,
  });
  await expectStatus(
    'PATCH',
    `/api/messages/${userMsg1.id}`,
    {
      content: 'stale same-leaf overwrite',
      expectedActiveLeafId: beforeSameLeafEdit.activeLeafId,
      expectedMutationRevision: beforeSameLeafEdit.mutationRevision,
    },
    409,
  );
  const afterSameLeafConflict = await tree(conv.id);
  assert(
    afterSameLeafConflict.mutationRevision > beforeSameLeafEdit.mutationRevision &&
      afterSameLeafConflict.messages.find((message) => message.id === userMsg1.id)?.content ===
        userMsg1.content,
    'same active leaf cannot conceal a stale content revision',
  );
  const staleDeleteConv = await req<{ id: number }>('POST', '/api/conversations', {});
  const beforeDeleteMetadataChange = await tree(staleDeleteConv.id);
  await patchConversation(staleDeleteConv.id, { title: 'changed before stale delete' });
  await expectStatus(
    'DELETE',
    `/api/conversations/${staleDeleteConv.id}?${branchQuery(beforeDeleteMetadataChange)}`,
    undefined,
    409,
  );
  const currentDeleteState = await tree(staleDeleteConv.id);
  await req(
    'DELETE',
    `/api/conversations/${staleDeleteConv.id}?${branchQuery(currentDeleteState)}`,
  );
  assert(true, 'conversation delete requires the current mutation revision');
  await expectStatus(
    'POST',
    `/api/conversations/${conv.id}/messages`,
    await branchBodyAt(conv.id, null, { content: 'stale send' }),
    409,
  );
  await expectStatus(
    'PATCH',
    `/api/conversations/${conv.id}`,
    await branchBody(conv.id, { personaId: 999999999 }),
    400,
  );

  const streamed = deltas.map((e) => (e.t === 'delta' ? (e.d ?? '') : '')).join('');
  assert(streamed === assistant1.content, 'concatenated deltas equal persisted content');

  console.log('== advancing past the last swipe creates a sibling ==');
  await req('POST', `/api/messages/${assistant1.id}/advance`, await branchBody(conv.id));
  await ws.waitFor((e) => e.t === 'final' && e.message.id !== assistant1.id, 'new swipe finished');

  // Auto-title overwrites the first reply's last-completion record; inspect the second reply.
  const effortSeen = (await (await fetch(`${MOCK_CONTROL}/control/last-completion`)).json()) as {
    completion: { reasoningEffort: string | null } | null;
  };
  assert(
    effortSeen.completion?.reasoningEffort === 'high',
    'endpoint reasoningEffort reaches upstream as reasoning_effort',
  );
  snap = await tree(conv.id);
  const assistantSiblings = snap.messages.filter((m) => m.parentId === userMsg1.id);
  assert(assistantSiblings.length === 2, 'two assistant siblings after advancing');
  const assistant2 = assistantSiblings.find((m) => m.id !== assistant1.id)!;
  assert(snap.activeLeafId === assistant2.id, 'new sibling is active');

  console.log('== extend branch on first sibling, then deep-restore ==');
  await activate(conv.id, assistant1.id);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === assistant1.id, 'branch switch back to first reply');

  await sendMessage(conv.id, 'Second question');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.parentId != null && e.message.parentId !== userMsg1.id,
    'reply to second question',
  );
  snap = await tree(conv.id);
  path = pathOf(snap);
  assert(path.length === 4, 'path deepened to 4 under first sibling');
  const deepLeafId = snap.activeLeafId!;

  await activate(conv.id, assistant2.id);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === assistant2.id, 'switched to short branch');
  await activate(conv.id, assistant1.id);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === deepLeafId, 'deep chain restored after switching back');

  console.log('== edit user message as branch (root fork), then restore ==');
  await req(
    'POST',
    `/api/messages/${userMsg1.id}/edit-branch`,
    await branchBody(conv.id, { content: 'Edited hello' }),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.content.includes('Edited hello'),
    'generation for edited branch',
  );
  snap = await tree(conv.id);
  path = pathOf(snap);
  assert(
    path.length === 2 && path[0]!.content === 'Edited hello',
    'edited branch active with fresh reply',
  );
  const roots = snap.messages.filter((m) => m.parentId === null);
  assert(roots.length === 2, 'two root siblings after root edit');

  await activate(conv.id, userMsg1.id);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === deepLeafId, 'full original chain restored across the root fork');

  console.log('== in-place edit ==');
  await expectStatus(
    'PATCH',
    `/api/messages/${assistant1.id}`,
    await branchBody(conv.id, { content: '   ' }),
    400,
  );
  await req(
    'PATCH',
    `/api/messages/${assistant1.id}`,
    await branchBody(conv.id, { content: 'Rewritten reply.' }),
  );
  snap = await tree(conv.id);
  assert(
    snap.messages.find((m) => m.id === assistant1.id)!.content === 'Rewritten reply.',
    'in-place edit persisted',
  );
  const editPatch = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.messages.some((m) => m.id === assistant1.id && m.content === 'Rewritten reply.'),
    'patch frame for the in-place edit',
  );
  if (editPatch.t !== 'treePatch') throw new Error('unreachable');
  assert(
    editPatch.messages.length === 1 && editPatch.nodes.length === snap.messages.length,
    'tree patches carry full structure but bodies only for changed messages',
  );

  console.log('== regenerate with instruction includes the original reply ==');
  const steered = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${assistant1.id}/regenerate`,
    await branchBody(conv.id, { instruction: 'Make this much shorter.' }),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === steered.assistantMessageId,
    'steered regeneration finished',
  );
  const steeredSeen = (await (await fetch(`${MOCK_CONTROL}/control/last-completion`)).json()) as {
    completion: {
      assistantMessages: string[];
      messages: { role: string; content: string }[];
      lastMessageRole: string | null;
      lastMessageContent: string | null;
    } | null;
  };
  assert(
    steeredSeen.completion?.assistantMessages.includes('Rewritten reply.') === true,
    'steered regeneration sends the original assistant reply upstream',
  );
  assert(
    steeredSeen.completion?.lastMessageRole === 'user' &&
      steeredSeen.completion.lastMessageContent?.includes('Make this much shorter.') === true,
    'one-off steer instruction follows the original reply as a user message',
  );
  const steeredAlternating = steeredSeen.completion!.messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  );
  assert(
    steeredAlternating.every(
      (message, index) =>
        message.content.trim().length > 0 &&
        (index === 0 || message.role !== steeredAlternating[index - 1]!.role),
    ),
    'steered text request keeps user/assistant messages non-empty and alternating',
  );
  snap = await tree(conv.id);
  const steeredMessage = snap.messages.find(
    (message) => message.id === steered.assistantMessageId,
  )!;
  assert(
    steeredMessage.parentId === assistant1.parentId,
    'steered result is stored as a sibling, not as a child of the original reply',
  );

  return { conv, ws };
}

export type ChatFixture = Awaited<ReturnType<typeof testChat>>;
