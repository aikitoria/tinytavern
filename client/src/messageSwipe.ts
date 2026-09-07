import type { Message } from '@tinytavern/shared';
import { imageMessage } from './images/imageGeneration.tsx';
import { streamingMessage, swipeToSibling } from './state/store.ts';

export function messageSupportsSwipe(message: Message): boolean {
  return message.role === 'assistant' || message.role === 'user' || imageMessage.matches(message);
}

/** Forward swipes can stop an assistant stream and start its next sibling;
 * image messages handle their own alternatives. */
export function swipeMessage(message: Message, dir: 1 | -1): boolean {
  if (imageMessage.matches(message)) {
    imageMessage.swipe(message, dir);
    return true;
  }
  if (message.role !== 'assistant' && message.role !== 'user') return false;
  if (dir === -1 && (message.status === 'streaming' || streamingMessage())) return false;
  void swipeToSibling(message, dir);
  return true;
}
