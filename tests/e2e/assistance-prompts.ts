import type { Settings } from '@tinytavern/shared';
import {
  BASE,
  MOCK_CONTROL,
  WsClient,
  assert,
  branchBody,
  branchQuery,
  expectStatus,
  putSettings,
  patchConversation,
  req,
  sendMessage,
  tree,
} from './helpers.ts';

export async function testAssistancePrompts() {
  console.log('== configured title and draft completion prompts ==');
  const before = await req<Settings>('GET', '/api/settings');
  for (const patch of [{ titlePrompt: '' }, { draftCompletionPrompt: 'Missing draft' }]) {
    await expectStatus(
      'PUT',
      '/api/settings',
      { ...patch, expectedRevision: before.revision },
      400,
    );
  }
  await putSettings({
    titlePrompt: 'CUSTOM TITLE {{char}} / {{user}}',
    draftCompletionPrompt: 'CUSTOM DRAFT {{draft}}',
  });
  const saved = await req<Settings>('GET', '/api/settings');
  assert(saved.titlePrompt === 'CUSTOM TITLE {{char}} / {{user}}', 'title prompt persists');
  assert(
    saved.draftCompletionPrompt === 'CUSTOM DRAFT {{draft}}',
    'draft completion prompt persists',
  );
  const template = await req<{ id: number }>('POST', '/api/templates', {
    name: 'Assistance prefills',
    content: '{{system}}',
    userPrologue: 'Begin with {{char}}.',
    reasoningPrefill: 'ASSISTANCE {{char}} / {{user}}',
    messagePrefill: 'VISIBLE CHAT PREFILL ',
    prefixNames: true,
  });
  const character = await req<{ id: number }>('POST', '/api/characters', {
    name: 'Writer',
    firstMessage: 'An opening greeting from {{char}}.',
    templateId: template.id,
  });
  const conversation = await req<{ id: number }>('POST', '/api/conversations', {
    characterId: character.id,
  });
  const ws = new WsClient();
  await ws.open();
  try {
    ws.sub(conversation.id);
    await ws.waitFor(
      (event) => event.t === 'tree' && event.conversationId === conversation.id,
      'assistance prompt tree',
    );
    await fetch(`${MOCK_CONTROL}/control/clear-completions`, { method: 'POST' });
    const userText = 'Keep {{assistantMessage}} and $& literal';
    const sent = await sendMessage(conversation.id, userText);
    await ws.waitFor(
      (event) => event.t === 'final' && event.message.id === sent.assistantMessageId,
      'assistance prompt reply',
    );
    const snapshot = await tree(conversation.id);
    const reply = snapshot.messages.find((message) => message.id === sent.assistantMessageId)!;
    type Completion = { messages: { role: string; content: string; reasoning_content?: string }[] };
    let title: Completion | undefined;
    for (let attempt = 0; attempt < 80 && !title; attempt++) {
      const log = (await (await fetch(`${MOCK_CONTROL}/control/completions`)).json()) as {
        completions: Completion[];
      };
      title = log.completions.find((completion) =>
        completion.messages.some(
          (message) =>
            message.role === 'user' && message.content.startsWith('[System Note]\nCUSTOM TITLE'),
        ),
      );
      if (!title) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert(
      title?.messages.at(-2)?.content === '[System Note]\nCUSTOM TITLE Writer / Aiki',
      'auto-title appends the configured steering instruction to the chat',
    );
    assert(
      title?.messages.some(
        (message) => message.role === 'user' && message.content === 'Begin with Writer.',
      ),
      'title context retains the outer template first user message',
    );
    assert(
      title?.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.content === 'Writer: An opening greeting from Writer.',
      ),
      'title context includes the character greeting',
    );
    assert(
      title?.messages.some(
        (message) => message.role === 'user' && message.content === `Aiki: ${userText}`,
      ),
      'title context includes the first real user message',
    );
    assert(
      title?.messages.some(
        (message) => message.role === 'assistant' && message.content === `Writer: ${reply.content}`,
      ),
      'title context includes the complete assistant reply',
    );
    assert(
      title?.messages.at(-1)?.reasoning_content === 'ASSISTANCE Writer / Aiki' &&
        title.messages.at(-1)?.content === '',
      'auto-title inherits the outer template reasoning prefill without its visible or speaker prefill',
    );

    const draft = '  - **Unfinished** {{draft}} $&\n\t```ts\nconst value =  ';
    const continuation = '42;\n\t```\n';
    await fetch(
      `${MOCK_CONTROL}/control/completion-next?content=${encodeURIComponent(draft + continuation)}`,
      { method: 'POST' },
    );
    const response = await fetch(`${BASE}/api/conversations/${conversation.id}/complete-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await branchBody(conversation.id, { draft })),
    });
    assert(response.ok, 'configured draft completion streams successfully');
    const events = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)));
    assert(
      events.some((event) => event.done) && !events.some((event) => event.error),
      'verbatim draft completion finishes without an error',
    );
    assert(
      events.map((event) => event.d ?? '').join('') === continuation,
      'only the continuation is sent, preserving its whitespace and Markdown',
    );
    const result = (await (await fetch(`${MOCK_CONTROL}/control/last-completion`)).json()) as {
      completion: Completion;
    };
    assert(
      result.completion.messages.at(-2)?.content === `[System Note]\nCUSTOM DRAFT ${draft}`,
      'draft completion uses the saved instruction without hidden wording',
    );
    assert(
      result.completion.messages.at(-1)?.reasoning_content === 'ASSISTANCE Writer / Aiki' &&
        result.completion.messages.at(-1)?.content === '',
      'draft completion inherits the outer template reasoning prefill without its visible or speaker prefill',
    );

    assert(
      result.completion.messages.some(
        (message) => message.role === 'assistant' && message.content === `Writer: ${reply.content}`,
      ),
      'draft completion retains chat history',
    );
    for (const invalid of [draft.trimStart() + continuation, draft.slice(0, -1)]) {
      await fetch(
        `${MOCK_CONTROL}/control/completion-next?content=${encodeURIComponent(invalid)}`,
        { method: 'POST' },
      );
      const failed = await fetch(`${BASE}/api/conversations/${conversation.id}/complete-draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await branchBody(conversation.id, { draft })),
      });
      const body = await failed.text();
      assert(
        body.includes('"error"') && !body.includes('"done"') && !body.includes('"d"'),
        'changed or incomplete draft prefixes fail without sending replacement text',
      );
    }
    const named = await req<{ id: number }>('POST', '/api/conversations', {
      characterId: character.id,
    });
    await patchConversation(named.id, { title: 'Writer' });
    ws.sub(named.id);
    await fetch(`${MOCK_CONTROL}/control/clear-completions`, { method: 'POST' });
    const namedReply = await sendMessage(named.id, 'First user response');
    await ws.waitFor(
      (event) => event.t === 'final' && event.message.id === namedReply.assistantMessageId,
      'manually named chat reply',
    );
    assert(
      (await req<{ id: number; title: string }[]>('GET', '/api/conversations')).find(
        (item) => item.id === named.id,
      )?.title === 'Writer',
      'a manual title matching the initial character name is preserved',
    );
    const namedLog = (await (await fetch(`${MOCK_CONTROL}/control/completions`)).json()) as {
      completions: Completion[];
    };
    assert(
      !namedLog.completions.some((completion) =>
        completion.messages.some(
          (message) => message.content === '[System Note]\nCUSTOM TITLE Writer / Aiki',
        ),
      ),
      'manually named chats do not generate an automatic title',
    );
    await req('DELETE', `/api/conversations/${named.id}?${branchQuery(await tree(named.id))}`);
  } finally {
    ws.close();
    await putSettings({
      titlePrompt: before.titlePrompt,
      draftCompletionPrompt: before.draftCompletionPrompt,
    });
    await req(
      'DELETE',
      `/api/conversations/${conversation.id}?${branchQuery(await tree(conversation.id))}`,
    );
    await req('DELETE', `/api/characters/${character.id}`);
    await req('DELETE', `/api/templates/${template.id}`);
  }
}
