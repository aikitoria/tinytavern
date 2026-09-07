import type { Character, Conversation } from '@tinytavern/shared';
import {
  BASE,
  MOCK_CONTROL,
  WsClient,
  assert,
  branchQuery,
  expectStatus,
  fetchTrace,
  patchConversation,
  pathOf,
  req,
  sendMessage,
  tree,
} from './helpers.ts';

export async function testCharacterChatNames() {
  console.log('== character display names and chat name overrides ==');
  const character = await req<Character>('POST', '/api/characters', {
    name: 'Library character label',
    chatName: '  Ari  ',
    personality: '{{char}} is a patient guide.',
    examples: '{{char}}: Hello, {{user}}.',
    firstMessage: 'I am {{char}}. Welcome, {{user}}.',
    customPrompt: 'Play {{char}}.',
    customTemplate: {
      content: '{{system}}\n{{personality}}\n{{examples}}',
      userPrologue: 'Begin with {{char}}.',
      reasoningPrefill: 'Think as {{char}}.',
      messagePrefill: '{{char}} says: ',
      prefixNames: true,
    },
  });
  assert(
    character.name === 'Library character label' && character.chatName === 'Ari',
    'character DTO keeps its UI name and normalizes its separate chat name',
  );
  await expectStatus('PATCH', `/api/characters/${character.id}`, { chatName: 42 }, 400);
  const renamed = await req<Character>('PATCH', `/api/characters/${character.id}`, {
    name: 'Library label renamed',
  });
  assert(renamed.chatName === 'Ari', 'renaming the UI label preserves the chat override');
  const copy = await req<Character>('POST', `/api/characters/${character.id}/duplicate`);
  assert(
    copy.name === 'Library label renamed (copy)' && copy.chatName === 'Ari',
    'duplication copies the chat override while giving the UI entry its own name',
  );

  const reimport = async (id: number) => {
    const exported = await fetch(`${BASE}/api/characters/${id}/card`);
    assert(exported.ok, 'character with a chat override exports successfully');
    const imported = await fetch(`${BASE}/api/characters/import-card`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(await exported.arrayBuffer()),
    });
    assert(imported.ok, 'character with a chat override reimports successfully');
    return (await imported.json()) as Character;
  };
  const imported = await reimport(character.id);
  assert(
    imported.name === renamed.name && imported.chatName === 'Ari',
    'character card round-trip preserves both names',
  );
  await req('PATCH', `/api/characters/${imported.id}`, { chatName: null });
  const clearedImport = await reimport(imported.id);
  assert(clearedImport.chatName === null, 'card export does not resurrect a cleared chat override');

  const conversation = await req<Conversation>('POST', '/api/conversations', {
    characterId: character.id,
  });
  assert(conversation.title === renamed.name, 'conversation UI title uses the main character name');
  const greeting = pathOf(await tree(conversation.id))[0]!;
  assert(
    greeting.content === 'I am Ari. Welcome, Aiki.' && greeting.name === null,
    'greetings expand the chat name while retaining the live default speaker label',
  );
  const trace = await fetchTrace(conversation.id);
  assert(
    trace.messages.some((message) => message.content.includes('Play Ari.')) &&
      trace.messages.some((message) => message.content.includes('Ari is a patient guide.')) &&
      trace.messages.some((message) => message.content.includes('Ari: Hello, Aiki.')),
    'system prompts, character fields, and examples all expand the chat name',
  );
  assert(
    trace.namePrefill === 'Ari:' &&
      trace.reasoningPrefill === 'Think as Ari.' &&
      trace.messagePrefill === 'Ari says:',
    'speaker-name, reasoning, and message prefills use the chat name',
  );

  const ws = new WsClient();
  await ws.open();
  ws.sub(conversation.id);
  try {
    const sent = await sendMessage(conversation.id, 'Hello');
    await ws.waitFor(
      (event) => event.t === 'final' && event.message.id === sent.assistantMessageId,
      'chat-name generation completes',
    );
    const request = (await (await fetch(`${MOCK_CONTROL}/control/last-completion`)).json()) as {
      completion: { messages: { role: string; content: string }[] };
    };
    assert(
      JSON.stringify(request.completion.messages).includes('Ari') &&
        !JSON.stringify(request.completion.messages).includes('Library label renamed'),
      'the upstream request uses the chat identity instead of the library label',
    );
    await patchConversation(conversation.id, { speakerName: 'Guest' });
    const guestTrace = await fetchTrace(conversation.id);
    assert(
      guestTrace.namePrefill === 'Guest:' && guestTrace.reasoningPrefill === 'Think as Ari.',
      'explicit /char speaker names take precedence without changing the character macro',
    );
    const guest = await sendMessage(conversation.id, 'A different speaker');
    const final = await ws.waitFor(
      (event) => event.t === 'final' && event.message.id === guest.assistantMessageId,
      'explicit speaker generation completes',
    );
    assert(
      final.t === 'final' && final.message.name === 'Guest',
      'explicit speaker headers stay stamped',
    );

    const cleared = await req<Character>('PATCH', `/api/characters/${character.id}`, {
      chatName: '   ',
    });
    assert(cleared.chatName === null, 'an empty override restores the main character name');
    await patchConversation(conversation.id, { speakerName: null });
    const restored = await fetchTrace(conversation.id);
    assert(
      restored.namePrefill === `${renamed.name}:` &&
        restored.reasoningPrefill === `Think as ${renamed.name}.`,
      'clearing the override restores the main name in macros and default speaker prefills',
    );
    assert(
      pathOf(await tree(conversation.id))[0]!.content === greeting.content,
      'changing the chat name leaves existing message content intact',
    );
  } finally {
    ws.close();
  }
  await req(
    'DELETE',
    `/api/conversations/${conversation.id}?${branchQuery(await tree(conversation.id))}`,
  );
  for (const id of [character.id, copy.id, imported.id, clearedImport.id]) {
    await req('DELETE', `/api/characters/${id}`);
  }
}
