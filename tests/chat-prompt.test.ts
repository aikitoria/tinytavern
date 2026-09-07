import assert from 'node:assert/strict';
import { DEFAULT_GALLERY_REVISION_TEMPLATE } from '@tinytavern/shared';
import type { BuiltPrompt, ChatMessage } from '../server/src/prompt.ts';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { appendChatMessage, withDisabledPrefillSpeakerNote, buildGalleryRevisionPrompt } =
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

const original = 'A sign reading {{instruction}} and $&';
const instruction = 'Make it blue; keep {{prompt}} literal';
const revised = buildGalleryRevisionPrompt(original, instruction, {
  systemPrompt: 'Edit {{prompt}} using {{instruction}}',
  userMessage: 'Change: {{INSTRUCTION}}\nSource: {{prompt}}\nAgain: {{instruction}}',
  reasoningPrefill: 'Consider {{instruction}}',
  messagePrefill: 'Image: {{prompt}}',
});
assert.deepEqual(revised, {
  messages: [
    { role: 'system', content: `Edit ${original} using ${instruction}` },
    { role: 'user', content: `Change: ${instruction}\nSource: ${original}\nAgain: ${instruction}` },
  ],
  reasoningPrefill: `Consider ${instruction}`,
  messagePrefill: `Image: ${original}`,
});
const noSystem = buildGalleryRevisionPrompt(original, instruction, {
  ...DEFAULT_GALLERY_REVISION_TEMPLATE,
  systemPrompt: '',
  reasoningPrefill: '  ',
  messagePrefill: '\n',
});
assert.deepEqual(
  noSystem.messages.map((message) => message.role),
  ['user'],
);
assert.equal(noSystem.reasoningPrefill, null);
assert.equal(noSystem.messagePrefill, null);
assert.ok(noSystem.messages[0]!.content.includes(original));
assert.ok(noSystem.messages[0]!.content.includes(instruction));

console.log('chat prompt normalization tests passed');
