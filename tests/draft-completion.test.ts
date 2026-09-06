import assert from 'node:assert/strict';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { buildDraftCompletionMessages, DraftSuffixFilter } =
  await import('../server/src/draftCompletionPrompt.ts');

const alternating = buildDraftCompletionMessages(
  [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'First' },
    { role: 'user', content: 'Second' },
    { role: 'assistant', content: '', reasoning_content: 'thought' },
  ],
  'I was halfway through',
);
assert.deepEqual(
  alternating.map((message) => message.role),
  ['system', 'user', 'assistant', 'user'],
);
assert.equal(alternating[1]?.content, 'First\n\nSecond');
assert.equal(alternating[2]?.content, '(No visible response)');
assert.equal(alternating[2]?.reasoning_content, 'thought');
assert.match(alternating.at(-1)?.content ?? '', /I was halfway through/);

const trailingUser = buildDraftCompletionMessages([{ role: 'user', content: 'History' }], 'Draft');
assert.equal(trailingUser.length, 1);
assert.match(trailingUser[0]?.content ?? '', /^History/);
assert.match(trailingUser[0]?.content ?? '', /Draft/);

const echoed = new DraftSuffixFilter('Draft');
assert.equal(echoed.push('Dra'), '');
assert.equal(echoed.push('ft plus'), ' plus');
assert.equal(echoed.finish(), '');

const genuine = new DraftSuffixFilter('Draft');
assert.equal(genuine.push('Drifting onward'), 'Drifting onward');
assert.equal(genuine.finish(), '');

console.log('draft completion prompt: 13 assertions passed');
