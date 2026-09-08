const original = 'A sign reading {{instruction}} and $&';
const instruction = 'Make it blue; keep {{prompt}} literal';
import assert from 'node:assert/strict';
import { systemNote } from '@tinytavern/shared';
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
assert.equal(rootWithNote.at(-1)?.content, '[System Note]\n<Note: Reply as Guest>');
assert.equal(systemNote('[System Note]\nCustom'), '[System Note]\nCustom');
assert.equal(systemNote(''), '');
for (const label of [
  'IMAGE PROMPT TASK',
  'VIDEO PROMPT TASK',
  'IMAGE PROMPT REVISION TASK',
  'IMAGE PROMPT REVISION CONTEXT',
]) {
  assert.equal(systemNote(`[${label}]\nCustom`), '[System Note]\nCustom');
  assert.equal(systemNote(`[System Note]\n[${label}]\nCustom`), '[System Note]\nCustom');
}

console.log('chat prompt normalization tests passed');

const { stmt, toConversation } = await import('../server/src/db.ts');
const { getSettings, putSettings } = await import('../server/src/settingsStore.ts');
const { buildChatMessages } = await import('../server/src/prompt.ts');
const characterId = Number(
  stmt(
    "INSERT INTO characters(name, personality, created_at) VALUES ('Layout character', 'Visible personality', 1)",
  ).run().lastInsertRowid,
);
const conversationId = Number(
  stmt(
    "INSERT INTO conversations(title, character_id, created_at, updated_at) VALUES ('Layout test', ?, 1, 1)",
  ).run(characterId).lastInsertRowid,
);
const conversation = toConversation(
  stmt('SELECT * FROM conversations WHERE id = ?').get(conversationId)!,
);
assert(
  buildChatMessages(conversation, []).messages[0]?.content.includes('Visible personality'),
  'Fresh installations select a normal seeded template',
);
const templateId = getSettings().defaultTemplateId!;
for (const content of ['', '   ']) {
  stmt('UPDATE templates SET content = ? WHERE id = ?').run(content, templateId);
  assert.deepEqual(
    buildChatMessages(conversation, []).messages,
    [],
    'Empty saved layouts stay empty',
  );
}
stmt('UPDATE templates SET content = ?, user_prologue = ? WHERE id = ?').run(
  '{{system}}',
  'Prologue',
  templateId,
);
assert.equal(buildChatMessages(conversation, []).messages[0]?.role, 'system');
stmt('UPDATE characters SET custom_template = ? WHERE id = ?').run(
  JSON.stringify({ content: '' }),
  characterId,
);
assert.deepEqual(
  buildChatMessages(conversation, []).messages,
  [],
  'Empty inline layouts override the global saved layout',
);
stmt('UPDATE characters SET custom_template = NULL WHERE id = ?').run(characterId);
putSettings({ ...getSettings(), defaultTemplateId: null });
assert.deepEqual(
  buildChatMessages(conversation, []).messages,
  [],
  'No selection does not introduce a hidden layout',
);
putSettings({ ...getSettings(), defaultTemplateId: templateId });
stmt("UPDATE templates SET content = '' WHERE id = ?").run(templateId);
assert.deepEqual(
  buildChatMessages(conversation, []).messages,
  [{ role: 'user', content: 'Prologue' }],
  'An empty system layout still honors the other saved template fields',
);
console.log(
  'Prompt layouts use saved selections; empty and missing layouts have no hard-coded fallback',
);

const { resolveSteerTemplate, appendImagePromptRevisionTask } =
  await import('../server/src/prompt.ts');
stmt(
  'UPDATE templates SET steer_template = ?, prefix_names = 1, speaker_handoff_template = ? WHERE id = ?',
).run('Adjust {{instruction}} exactly.', 'Speak as {{speaker}} only.', templateId);
assert.equal(resolveSteerTemplate(conversation), 'Adjust {{instruction}} exactly.');
assert.equal(
  buildChatMessages(conversation, [], 'Guest $& {{speaker}}').disabledPrefillSpeakerNote,
  'Speak as Guest $& {{speaker}} only.',
);
stmt("UPDATE templates SET steer_template = '', speaker_handoff_template = '' WHERE id = ?").run(
  templateId,
);
assert.throws(() => resolveSteerTemplate(conversation), { status: 400 });
assert.equal(buildChatMessages(conversation, [], 'Guest').disabledPrefillSpeakerNote, '');
const customRevision = {
  promptRevisionContext: 'Source follows: {{prompt}}',
  promptRevisionOriginal: 'SOURCE {{prompt}}',
  promptRevisionTemplate: 'CHANGE {{instruction}}',
};
const revisionHistory: ChatMessage[] = [{ role: 'assistant', content: 'Unchanged chat' }];
appendImagePromptRevisionTask(
  revisionHistory,
  original,
  'Original reasoning',
  instruction,
  customRevision,
);
assert.deepEqual(revisionHistory, [
  { role: 'assistant', content: 'Unchanged chat' },
  { role: 'user', content: `[System Note]\nSource follows: ${original}` },
  { role: 'assistant', content: `SOURCE ${original}`, reasoning_content: 'Original reasoning' },
  { role: 'user', content: `[System Note]\nCHANGE ${instruction}` },
]);
const noBridge: ChatMessage[] = [];
appendImagePromptRevisionTask(noBridge, original, null, instruction, {
  ...customRevision,
  promptRevisionContext: '',
});
assert.deepEqual(
  noBridge.map((message) => message.role),
  ['assistant', 'user'],
);
assert(!JSON.stringify(noBridge).includes('IMAGE PROMPT REVISION CONTEXT'));
console.log(
  'Saved steering, speaker handoff and image revision prompts have no implicit instructions',
);
