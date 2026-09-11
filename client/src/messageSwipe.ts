import type { Message } from '@tinytavern/shared';
import type { ConversationSession } from './state/conversationSession.ts';
import { createImageMessage } from './images/imageGeneration.tsx';

export function createMessageSwipe(session: ConversationSession, active: () => boolean) {
  const imageMessage = createImageMessage(session, active);
  function messageSupportsSwipe(message: Message): boolean {
    return message.role === 'assistant' || message.role === 'user' || imageMessage.matches(message);
  }
  function swipeMessage(message: Message, dir: 1 | -1): boolean {
    if (imageMessage.matches(message)) {
      imageMessage.swipe(message, dir);
      return true;
    }
    if (message.role !== 'assistant' && message.role !== 'user') return false;
    if (dir === -1 && (message.status === 'streaming' || session.streamingMessage())) return false;
    void session.swipeToSibling(message, dir);
    return true;
  }
  return { imageMessage, messageSupportsSwipe, swipeMessage };
}
