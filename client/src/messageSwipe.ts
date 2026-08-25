import type { Message } from '@minitavern/shared';
import { findMessageView } from './plugins/index.ts';
import { streamingMessage, swipeToSibling } from './state/store.ts';

/** Whether the message has ordinary chat alternatives or a plugin-owned
 * alternative action. Shared by pointer, button, and keyboard entry points. */
export function messageSupportsSwipe(message: Message): boolean {
  return (
    message.role === 'assistant' ||
    message.role === 'user' ||
    findMessageView(message)?.swipe != null
  );
}

/** One swipe dispatcher for desktop Left/Right and mobile horizontal gestures.
 * Forward on a streaming assistant uses advance(), which stops the current
 * stream and starts its next sibling. A plugin owns equivalent behavior for
 * tool messages (the image plugin stops an in-flight prompt before rendering).
 * Backward navigation remains blocked while a reply is streaming. */
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
