import type { Message } from './index.ts';

export interface MediaPromptSelection {
  messageId: number;
  /** Omitted when using the complete reply. */
  text?: string;
}

/** Markdown code blocks normalize line endings and remove their container indentation. */
export function isMediaPromptExcerpt(content: string, excerpt: string): boolean {
  const normalize = (text: string) =>
    text
      .replace(/\r\n?/g, '\n')
      .replace(/^[ \t]+/gm, '')
      .trim();
  const wanted = normalize(excerpt);
  if (!wanted) return false;
  if (normalize(content).includes(wanted)) return true;

  // Fenced blocks inside blockquotes lose their enclosing quote markers in Markdown.
  // Remove exactly the fence's quote depth so literal `>` characters in code survive.
  let fence: { depth: number; marker: string; length: number } | null = null;
  let code: string[] = [];
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    if (!fence) {
      const opening = /^[ \t]*((?:>[ \t]*)+)(`{3,}|~{3,})/.exec(line);
      if (opening) {
        fence = {
          depth: opening[1]!.split('>').length - 1,
          marker: opening[2]![0]!,
          length: opening[2]!.length,
        };
        code = [];
      }
      continue;
    }
    let offset = 0;
    let depth = 0;
    while (depth < fence.depth) {
      while (line[offset] === ' ' || line[offset] === '\t') offset++;
      if (line[offset] !== '>') break;
      offset++;
      if (line[offset] === ' ') offset++;
      depth++;
    }
    const text = line.slice(offset);
    const closing = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(text)?.[1];
    if (depth !== fence.depth || (closing?.[0] === fence.marker && closing.length >= fence.length)) {
      if (normalize(code.join('\n')).includes(wanted)) return true;
      fence = null;
    } else code.push(text);
  }
  return fence !== null && normalize(code.join('\n')).includes(wanted);
}

export function resolveMediaPromptSelection(
  messages: Readonly<Record<number, Message>>,
  activePath: readonly Message[],
  selected: MediaPromptSelection | null,
) {
  const message = selected ? messages[selected.messageId] : activePath.findLast((item) => item.role === 'assistant');
  if (!message) return null;
  const selection = selected ?? { messageId: message.id };
  const text = selection.text ?? message.content;
  return {
    message,
    selection,
    text,
    valid:
      message.role === 'assistant' &&
      (message.status === 'done' || message.status === 'stopped') &&
      Boolean(text.trim()) &&
      (selection.text === undefined || isMediaPromptExcerpt(message.content, selection.text)),
  };
}
