import type { Message } from '@tinytavern/shared';
import { findMessageView } from './plugins/index.ts';
import { streamingMessage, swipeToSibling } from './state/store.ts';

export function messageSupportsSwipe(message: Message): boolean {
  return (
    message.role === 'assistant' ||
    message.role === 'user' ||
    findMessageView(message)?.swipe != null
  );
}

/** Forward swipes can stop an assistant stream and start its next sibling;
 * plugins own equivalent behavior for tool messages. */
export function swipeMessage(message: Message, dir: 1 | -1): boolean {
  const pluginSwipe = findMessageView(message)?.swipe;
  if (pluginSwipe) {
    pluginSwipe(message, dir);
    return true;
  }
  if (message.role !== 'assistant' && message.role !== 'user') return false;
  if (dir === -1 && (message.status === 'streaming' || streamingMessage())) return false;
  void swipeToSibling(message, dir);
  return true;
}
