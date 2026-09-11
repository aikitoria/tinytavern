import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  isMediaPromptExcerpt,
  resolveMediaPromptSelection,
  type Message,
} from '@tinytavern/shared';

test('explicit media prompt selection survives followups and refuses missing or changed excerpts', () => {
  const first = { id: 1, role: 'assistant', status: 'done', content: 'First prompt' } as Message;
  const latest = {
    ...first,
    id: 2,
    content: 'Here is the prompt:\n```text\nBlue sky\nStill camera\n```\nSome explanation.',
  };
  const messages = { 1: first, 2: latest };
  const path = [first, latest];
  assert.equal(resolveMediaPromptSelection(messages, path, null)?.text, latest.content);
  assert.equal(
    resolveMediaPromptSelection(messages, path, { messageId: 1 })?.text,
    'First prompt',
    'An explicit earlier reply is not replaced by later replies or branch navigation',
  );
  const selected = { messageId: 2, text: 'Blue sky\nStill camera' };
  const code = resolveMediaPromptSelection(messages, path, selected)!;
  assert.equal(code.valid, true);
  assert.equal(
    code.text,
    selected.text,
    'Only code contents are used, without fences or commentary',
  );
  assert.equal(
    resolveMediaPromptSelection({ 1: first }, [first], selected),
    null,
    'Deletion cannot silently substitute another prompt',
  );
  assert.equal(
    resolveMediaPromptSelection(
      { ...messages, 2: { ...latest, content: 'Different prompt' } },
      path,
      selected,
    )?.valid,
    false,
  );
  assert.equal(
    resolveMediaPromptSelection(
      { ...messages, 2: { ...latest, status: 'streaming' } },
      path,
      selected,
    )?.valid,
    false,
  );
  assert(isMediaPromptExcerpt('    Blue sky\r\n    Still camera\r\n', selected.text));
  assert(!isMediaPromptExcerpt(latest.content, 'Blue sky\nInvented instruction'));
});

test('quoted fenced prompts preserve code content while removing Markdown containers', () => {
  const text = 'Blue sky\n> Higher clouds';
  for (const prefix of ['> ', '> > ', '  > > > ']) {
    for (const fence of ['```text', '~~~~']) {
      const end = fence.startsWith('`') ? '```' : '~~~~';
      const content = [
        'Use this prompt:',
        '',
        ...[fence, ...text.split('\n'), end].map((line) => prefix + line),
        '',
        'Explanation.',
      ].join('\n');
      const message = { id: 1, role: 'assistant', status: 'done', content } as Message;
      assert.equal(
        resolveMediaPromptSelection({ 1: message }, [message], { messageId: 1, text })?.valid,
        true,
      );
      assert(
        !isMediaPromptExcerpt(content, 'Blue sky\nHigher clouds'),
        'Literal quote characters inside code are not discarded',
      );
      assert(!isMediaPromptExcerpt(content, 'Blue sky\nInvented content'));
    }
  }
  assert(
    !isMediaPromptExcerpt('> Blue sky\n> Higher clouds', 'Blue sky\nHigher clouds'),
    'Ordinary blockquotes are not code blocks',
  );
});
