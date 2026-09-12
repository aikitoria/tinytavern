import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { conversationFixture, insertFixture } from '../support/fixtures.ts';
import { controlledStream, mockFetch } from '../support/streams.ts';
import type { ClientSocket } from '../../server/src/realtime/events.ts';

test('speculative swipes exclude media conversations even when both background options are enabled', async () => {
  const { stmt } = await import('../../server/src/db/db.ts');
  const { appendMessage } = await import('../../server/src/conversations/tree.ts');
  const { getSettings, putSettings } = await import('../support/settings.ts');
  const { prepareNextSwipe, prepareSubscribedSwipes } = await import('../../server/src/generation/speculation.ts');
  const { stopConversationGenerations } = await import('../../server/src/generation/generation.ts');
  const { websocket } = await import('../../server/src/realtime/events.ts');
  const endpointId = insertFixture('endpoints', {
    name: 'Speculation',
    base_url: 'http://unused.invalid',
    created_at: 1,
  });
  putSettings({
    ...getSettings(),
    activeEndpointId: endpointId,
    backgroundSwipeGeneration: true,
    parallelBackgroundSwipeGeneration: true,
  });
  const mediaId = conversationFixture({
    prompt_context_json: JSON.stringify({
      messages: [],
      reasoningPrefill: '',
      messagePrefill: '',
    }),
  });
  const chatId = conversationFixture();
  const mediaReply = appendMessage(mediaId, 'assistant', 'Media prompt', null);
  appendMessage(chatId, 'assistant', 'Chat reply', null);
  const socket = {
    data: { sub: null, closed: false },
    subscribe() {},
    unsubscribe() {},
  } as unknown as ClientSocket;
  const originalFetch = globalThis.fetch;
  let requests = 0;
  mockFetch((_url, init) => {
    requests++;
    return new Response(controlledStream(init?.signal).body);
  });
  const speculative = (id: number) =>
    stmt("SELECT id FROM messages WHERE conversation_id = ? AND generation_kind = 'speculative'").all(id);
  try {
    websocket.message!(socket, JSON.stringify({ subs: [mediaId, chatId] }));
    prepareNextSwipe(mediaReply.id);
    assert.deepEqual(speculative(mediaId), []);
    assert.equal(requests, 0, 'Completing a media reply must not submit a speculative request');
    prepareSubscribedSwipes();
    assert.deepEqual(speculative(mediaId), []);
    assert.equal(speculative(chatId).length, 1, 'Main chat speculation remains enabled');
    assert.equal(requests, 1);
  } finally {
    stopConversationGenerations(mediaId);
    stopConversationGenerations(chatId);
    websocket.close!(socket, 1000, 'Test finished');
    globalThis.fetch = originalFetch;
  }
});
