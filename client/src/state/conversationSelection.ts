import { createMemo, createSignal } from 'solid-js';
import type { Message } from '@tinytavern/shared';
import type { ConversationState } from './conversationSession.ts';

interface MessageSelection {
  conversationId: number;
  anchorId: number;
  extentId: number;
}

export interface SelectedMessageRange {
  messages: Message[];
  messageIds: number[];
  messageIdSet: ReadonlySet<number>;
  start: number;
  end: number;
  pathLength: number;
}

export function createMessageSelection(state: ConversationState, activePath: () => Message[]) {
  const [selection, setSelection] = createSignal<MessageSelection | null>(null);

  const messageSelection = selection;

  function startMessageSelection(messageId: number): void {
    const message = state.tree.messages[messageId];
    if (!message || !activePath().some((candidate) => candidate.id === messageId)) return;
    setSelection({
      conversationId: message.conversationId,
      anchorId: messageId,
      extentId: messageId,
    });
  }

  function extendMessageSelection(messageId: number): void {
    const current = selection();
    if (!current || current.conversationId !== state.selectedId) return;
    if (!activePath().some((message) => message.id === messageId)) return;
    setSelection({ ...current, extentId: messageId });
  }

  function clearMessageSelection(): void {
    setSelection(null);
  }

  /** Losing either endpoint from the authoritative path invalidates the selection. */
  const selectedMessageRange = createMemo<SelectedMessageRange | null>(() => {
    const current = selection();
    if (!current || current.conversationId !== state.selectedId || state.viewMode !== 'chat') {
      return null;
    }
    const path = activePath();
    const anchor = path.findIndex((message) => message.id === current.anchorId);
    const extent = path.findIndex((message) => message.id === current.extentId);
    if (anchor < 0 || extent < 0) return null;
    const start = Math.min(anchor, extent);
    const end = Math.max(anchor, extent);
    const messages = path.slice(start, end + 1);
    const messageIds = messages.map((message) => message.id);
    return {
      messages,
      messageIds,
      messageIdSet: new Set(messageIds),
      start,
      end,
      pathLength: path.length,
    };
  });

  function messageSelectionActive(): boolean {
    return selectedMessageRange() != null;
  }

  function messageIsSelected(messageId: number): boolean {
    return selectedMessageRange()?.messageIdSet.has(messageId) ?? false;
  }

  return {
    messageSelection,
    startMessageSelection,
    extendMessageSelection,
    clearMessageSelection,
    selectedMessageRange,
    messageSelectionActive,
    messageIsSelected,
  };
}
