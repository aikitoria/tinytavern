import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { BuiltPrompt } from '../server/src/prompt.ts';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { db, stmt, toConversation } = await import('../server/src/db.ts');
const { startGeneration, stopGeneration, stopAllGenerations, mergeLiveBuffers } =
  await import('../server/src/generation.ts');
const { getMessage } = await import('../server/src/tree.ts');
const { getSettings, putSettings } = await import('../server/src/settingsStore.ts');
const { getConversationRevision } = await import('../server/src/conversationRevision.ts');
const endpointId = Number(
  stmt('INSERT INTO endpoints (name, base_url, model, created_at) VALUES (?, ?, ?, ?)').run(
    'test',
    'https://upstream.invalid/v1',
    'test-model',
    Date.now(),
  ).lastInsertRowid,
);
putSettings({ ...getSettings(), activeEndpointId: endpointId });
const cid = Number(
  stmt('INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)').run(
    'Persistence',
    Date.now(),
    Date.now(),
  ).lastInsertRowid,
);
const conversation = toConversation(stmt('SELECT * FROM conversations WHERE id = ?').get(cid)!);
const prompt: BuiltPrompt = {
  messages: [{ role: 'user', content: 'Hello' }],
  reasoningPrefill: null,
  messagePrefill: null,
  namePrefill: null,
  disabledPrefillSpeakerNote: null,
  charName: 'Assistant',
  userName: 'User',
};
const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async () =>
  new Response(
    new ReadableStream({
      start(controller) {
        streams.push(controller);
      },
    }),
  );
const encoder = new TextEncoder();
function append(
  stream: ReadableStreamDefaultController<Uint8Array>,
  content: string,
  reasoning = '',
) {
  stream.enqueue(
    encoder.encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content, reasoning_content: reasoning } }] })}\n\n`,
    ),
  );
}
function message(role = 'assistant') {
  return Number(
    stmt(
      "INSERT INTO messages (conversation_id, role, content, status, image_pending, created_at) VALUES (?, ?, '', 'streaming', 1, ?)",
    ).run(cid, role, Date.now()).lastInsertRowid,
  );
}
function begin(mid: number, resume?: { content: string; reasoning: string }) {
  startGeneration(conversation, mid, resume, { prompt, background: true });
  return streams.at(-1)!;
}
async function settle() {
  await delay(10);
}
try {
  const mid = message();
  const stream = begin(mid);
  append(stream, ' First', ' Think');
  await delay(650); // Cross the former periodic flush interval.
  assert.equal(getMessage(mid)!.content, '');
  assert.equal(getMessage(mid)!.reasoning, null);
  assert.equal(getMessage(mid)!.model, null);
  assert.equal(mergeLiveBuffers([getMessage(mid)!])[0]!.content, ' First');
  const revision = getConversationRevision(cid);
  append(stream, ' reply ', ' more ');
  stream.close();
  await settle();
  assert.equal(getMessage(mid)!.content, 'First reply');
  assert.equal(getMessage(mid)!.reasoning, 'Think more');
  assert.equal(getMessage(mid)!.model, 'test-model');
  assert.equal(getMessage(mid)!.status, 'done');
  assert.equal(getMessage(mid)!.imagePending, true);
  assert.equal(getConversationRevision(cid), revision + 1);

  stmt("UPDATE messages SET status = 'streaming' WHERE id = ?").run(mid);
  const old = begin(mid, { content: 'First reply', reasoning: 'Think more' });
  append(old, ' continued');
  await settle();
  assert.equal(getMessage(mid)!.content, 'First reply');
  stopGeneration(mid);
  assert.equal(getMessage(mid)!.content, 'First reply continued');
  assert.equal(getMessage(mid)!.status, 'stopped');
  assert.equal(getMessage(mid)!.imagePending, false);
  stmt("UPDATE messages SET status = 'streaming' WHERE id = ?").run(mid);
  const next = begin(mid, { content: 'First reply continued', reasoning: 'Think more' });
  append(old, ' stale');
  old.close();
  append(next, ' successor');
  await settle();
  assert.equal(mergeLiveBuffers([getMessage(mid)!])[0]!.content, 'First reply continued successor');
  next.close();
  await settle();
  assert.equal(getMessage(mid)!.content, 'First reply continued successor');

  const failed = message();
  const failingStream = begin(failed);
  append(failingStream, 'Partial', 'Reason');
  await settle();
  failingStream.error(new Error('fatal test failure'));
  await settle();
  assert.equal(getMessage(failed)!.status, 'error');
  assert.equal(getMessage(failed)!.content, 'Partial');
  assert.equal(getMessage(failed)!.reasoning, 'Reason');
  assert.equal(getMessage(failed)!.imagePending, false);

  const deleted = message();
  const deletedStream = begin(deleted);
  append(deletedStream, 'Gone');
  await settle();
  stmt('DELETE FROM messages WHERE id = ?').run(deleted);
  const beforeDeleteFinal = getConversationRevision(cid);
  deletedStream.close();
  await settle();
  assert.equal(getMessage(deleted), undefined);
  assert.equal(getConversationRevision(cid), beforeDeleteFinal);

  const pending = ['assistant', 'tool'].map((role) => {
    const id = message(role);
    const controller = begin(id);
    append(controller, role);
    return { id, controller, role };
  });
  await settle();
  stopAllGenerations();
  for (const { id, controller, role } of pending) {
    assert.equal(getMessage(id)!.content, role);
    assert.equal(getMessage(id)!.status, 'stopped');
    controller.close();
  }
  await settle();
  console.log(
    'Generation persistence: live buffers, terminal writes, resume identity, deletion, and shutdown passed',
  );
} finally {
  stopAllGenerations();
  globalThis.fetch = originalFetch;
  db.close();
}
