import {
  assert,
  req,
  expectStatus,
  tree,
  fetchTrace,
  branchBodyAt,
  branchPath,
} from './helpers.ts';
import type { TemplatesFixture } from './templates.ts';
import type { ChatFixture } from './chat.ts';

export async function testTools(
  fixture: Pick<TemplatesFixture, 'conv2'> & Pick<ChatFixture, 'ws'>,
) {
  const { conv2, ws } = fixture;

  console.log('== image tool generation (foreground, role=tool) ==');
  const toolSnap = await tree(conv2.id);
  const toolRes = await req<{ toolMessageId: number; activeLeafId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    {
      prompt: 'Describe {{char}} for {{user}}.',
      label: 'Image prompt',
      expectedActiveLeafId: toolSnap.activeLeafId,
      expectedMutationRevision: toolSnap.mutationRevision,
    },
  );
  await expectStatus(
    'POST',
    `/api/conversations/${conv2.id}/messages`,
    await branchBodyAt(conv2.id, toolRes.toolMessageId, { content: 'busy' }),
    409,
  );
  const toolFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === toolRes.toolMessageId,
    'tool generation finished',
  );
  assert(
    toolFinal.t === 'final' &&
      toolFinal.message.role === 'tool' &&
      toolFinal.message.status === 'done',
    'tool output streams into a role=tool message',
  );
  assert(
    toolFinal.message.content.includes('Describe Assistant for Aiki.'),
    'tool prompt gets {{char}}/{{user}} expanded and the chat context',
  );
  const toolTrace = await fetchTrace(conv2.id);
  assert(
    toolTrace.messages.every(
      (m) => m.role !== 'tool' && !m.content.includes('Describe Assistant for Aiki.'),
    ),
    'tool messages are excluded from prompt history',
  );

  console.log('== parallel tool prompts and deletion during generation ==');
  const toolSource = (await tree(conv2.id)).messages.find(
    (message) => message.id === toolRes.toolMessageId,
  )!;
  const parallelOne = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    await branchBodyAt(conv2.id, toolRes.toolMessageId, {
      prompt: 'Parallel image prompt one.',
      label: 'Image prompt',
    }),
  );
  const parallelTwo = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    await branchBodyAt(conv2.id, parallelOne.toolMessageId, {
      prompt: 'Parallel image prompt two.',
      label: 'Image prompt',
    }),
  );
  const parallelPending = await tree(conv2.id);
  assert(
    parallelPending.messages.find((message) => message.id === parallelOne.toolMessageId)?.status ===
      'streaming' &&
      parallelPending.messages.find((message) => message.id === parallelTwo.toolMessageId)
        ?.status === 'streaming',
    'multiple image prompts stream concurrently in one conversation',
  );
  await req(
    'DELETE',
    await branchPath(conv2.id, `/api/messages/${toolRes.toolMessageId}`, parallelTwo.toolMessageId),
  );
  const parallelAfterDelete = await tree(conv2.id);
  assert(
    !parallelAfterDelete.messages.some((message) => message.id === toolRes.toolMessageId) &&
      parallelAfterDelete.messages.find((message) => message.id === parallelOne.toolMessageId)
        ?.parentId === toolSource.parentId &&
      parallelAfterDelete.messages.find((message) => message.id === parallelTwo.toolMessageId)
        ?.parentId === parallelOne.toolMessageId,
    'deleting an earlier tool message preserves and reparents active prompt generations',
  );
  const parallelOneFinal = await ws.waitFor(
    (event) => event.t === 'final' && event.message.id === parallelOne.toolMessageId,
    'first parallel tool prompt finished',
  );
  const parallelTwoFinal = await ws.waitFor(
    (event) => event.t === 'final' && event.message.id === parallelTwo.toolMessageId,
    'second parallel tool prompt finished',
  );
  assert(
    parallelOneFinal.t === 'final' &&
      parallelOneFinal.message.content.includes('Parallel image prompt one.') &&
      parallelTwoFinal.t === 'final' &&
      parallelTwoFinal.message.content.includes('Parallel image prompt two.'),
    'parallel prompt streams finish independently after their old parent is deleted',
  );
}
