import { createContext, useContext, type Accessor } from 'solid-js';
import type { Message, MediaPromptSelection } from '@tinytavern/shared';
import type { ConversationSession } from '../../state/conversationSession.ts';
import { mainConversationSession, state } from '../../state/store.ts';

export interface ConversationView {
  session: ConversationSession;
  active: Accessor<boolean>;
  embedded?: boolean;
  showAvatarRail?: boolean;
  showMessageMenu?: boolean;
  renderPrompt?: (message: Message, text?: string) => void;
  selectedPrompt?: Accessor<MediaPromptSelection | null>;
  promptSelectionDisabled?: Accessor<boolean>;
}
export const ConversationContext = createContext<ConversationView>();
export function useConversationView(): ConversationView {
  return (
    useContext(ConversationContext) ?? {
      session: mainConversationSession,
      active: () => state.modal === null,
    }
  );
}
