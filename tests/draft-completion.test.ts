import assert from 'node:assert/strict';
import { DEFAULT_DRAFT_COMPLETION_PROMPT } from '@tinytavern/shared';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { buildDraftCompletionMessages, DraftSuffixFilter } =
  await import('../server/src/draftCompletionPrompt.ts');
const { stmt, toConversation } = await import('../server/src/db.ts');
const { getSettings } = await import('../server/src/settingsStore.ts');
const { appendMessage } = await import('../server/src/tree.ts');
const { buildChatMessages } = await import('../server/src/prompt.ts');

const conversation = toConversation(
  stmt(
    "INSERT INTO conversations (title, created_at, updated_at) VALUES ('Draft', 1, 1) RETURNING *",
  ).get()!,
);
stmt('UPDATE templates SET content = ?, user_prologue = ?, prefix_names = 0 WHERE id = ?').run(
  'System',
  '',
  getSettings().defaultTemplateId!,
);
const first = appendMessage(conversation.id, 'user', 'First', null);
const second = appendMessage(conversation.id, 'user', 'Second', first.id);
const assistant = appendMessage(conversation.id, 'assistant', '', second.id);
const tool = appendMessage(conversation.id, 'tool', 'Image prompt', assistant.id);
const built = buildChatMessages(conversation, [
  first,
  second,
  { ...assistant, reasoning: 'thought' },
  tool,
]);
const prefix = structuredClone(built.messages);

const alternating = buildDraftCompletionMessages(
  built.messages,
  'I was halfway through',
  DEFAULT_DRAFT_COMPLETION_PROMPT,
);
assert.deepEqual(
  alternating.map((message) => message.role),
  ['system', 'user', 'assistant', 'user'],
);
assert.equal(alternating[1]?.content, 'First\n\nSecond');
assert.equal(alternating[2]?.content, '(No visible response)');
assert.equal(alternating[2]?.reasoning_content, 'thought');
assert.match(alternating.at(-1)?.content ?? '', /I was halfway through/);
assert.deepEqual(alternating.slice(0, -1), prefix, 'Draft completion preserves the built prefix');

const trailingUser = buildDraftCompletionMessages(
  buildChatMessages(conversation, [first, second]).messages,
  'Draft',
  DEFAULT_DRAFT_COMPLETION_PROMPT,
);
assert.equal(trailingUser.length, 2);
assert.match(trailingUser[1]?.content ?? '', /^First\n\nSecond\n\n/);
assert.match(trailingUser[1]?.content ?? '', /Draft/);

const draft = "  - **Markdown**\n\t```ts\nconst x = '🦊';  ";
const continuation = ' // note\n\t```\n';
for (let split = 0; split <= draft.length + continuation.length; split++) {
  const filter = new DraftSuffixFilter(draft);
  const response = draft + continuation;
  assert.equal(
    filter.push(response.slice(0, split)) + filter.push(response.slice(split)),
    continuation,
  );
  filter.finish();
}
const filter = new DraftSuffixFilter(draft);
let suffix = '';
for (const character of draft + continuation) suffix += filter.push(character);
assert.equal(suffix, continuation);
filter.finish();
const changed = new DraftSuffixFilter(draft);
assert.throws(() => changed.push(draft.trimStart()), /changed the existing draft/);
const partial = new DraftSuffixFilter(draft);
assert.equal(partial.push(draft.slice(0, -1)), '');
assert.throws(() => partial.finish(), /stopped before repeating/);
const exact = new DraftSuffixFilter(draft);
assert.equal(exact.push(draft), '');
exact.finish();
assert.equal(exact.push('  '), '  ');
console.log(
  'Draft completion preserves whitespace and Markdown across every chunk boundary and rejects changed or incomplete prefixes.',
);

assert.deepEqual(
  buildDraftCompletionMessages(
    [{ role: 'assistant', content: 'Chat prefix' }],
    'A {{draft}} $&',
    'Continue: {{DRAFT}}',
  ),
  [
    { role: 'assistant', content: 'Chat prefix' },
    { role: 'user', content: '[System Note]\nContinue: A {{draft}} $&' },
  ],
);
