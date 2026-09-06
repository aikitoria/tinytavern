import assert from 'node:assert/strict';
import type { BuiltPrompt, ChatMessage } from '../server/src/prompt.ts';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { appendChatMessage, withDisabledPrefillSpeakerNote } =
  await import('../server/src/prompt.ts');

const messages: ChatMessage[] = [];
appendChatMessage(messages, { role: 'user', content: 'first' });
appendChatMessage(messages, { role: 'user', content: 'second' });
appendChatMessage(messages, { role: 'assistant', content: 'reply', reasoning_content: 'one' });
appendChatMessage(messages, { role: 'assistant', content: 'more', reasoning_content: 'two' });
appendChatMessage(messages, { role: 'system', content: 'late system context' });

assert.deepEqual(
  messages.map((message) => message.role),
  ['system', 'user', 'assistant'],
);
assert.equal(messages[1]?.content, 'first\n\nsecond');
assert.equal(messages[2]?.content, 'reply\n\nmore');
assert.equal(messages[2]?.reasoning_content, 'one\n\ntwo');
assert(
  messages.every(
    (message, index) =>
      message.content.trim().length > 0 &&
      (index === 0 || message.role === 'system' || message.role !== messages[index - 1]?.role),
  ),
);

const rootPrompt: BuiltPrompt = {
  messages: [{ role: 'system', content: 'system' }],
  reasoningPrefill: null,
  messagePrefill: null,
  namePrefill: 'Guest:',
  disabledPrefillSpeakerNote: '<Note: Reply as Guest>',
  charName: 'Assistant',
  userName: 'User',
};
const rootWithNote = withDisabledPrefillSpeakerNote(rootPrompt);
assert.deepEqual(
  rootWithNote.map((message) => message.role),
  ['system', 'user'],
);
assert.equal(rootWithNote.at(-1)?.content, '<Note: Reply as Guest>');

console.log('chat prompt normalization tests passed');
