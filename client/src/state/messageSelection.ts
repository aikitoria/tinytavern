import { createSignal } from 'solid-js';
import type { Message } from '@minitavern/shared';
import { activePath, state } from './store.ts';

interface MessageSelection {
  conversationId: number;
  anchorId: number;
  extentId: number;
}

export interface SelectedMessageRange {
  messages: Message[];
  messageIds: number[];
  start: number;
  end: number;
  pathLength: number;
}

const [selection, setSelection] = createSignal<MessageSelection | null>(null);

export const messageSelection = selection;

/** Starts a contiguous selection with one active-path message. */
export function startMessageSelection(messageId: number): void {
  const message = state.tree.messages[messageId];
  if (!message || !activePath().some((candidate) => candidate.id === messageId)) return;
  setSelection({
    conversationId: message.conversationId,
    anchorId: messageId,
    extentId: messageId,
  });
}

/** Extends the selection from its fixed anchor through this active-path message. */
export function extendMessageSelection(messageId: number): void {
  const current = selection();
  if (!current || current.conversationId !== state.selectedId) return;
  if (!activePath().some((message) => message.id === messageId)) return;
  setSelection({ ...current, extentId: messageId });
}

export function clearMessageSelection(): void {
  setSelection(null);
}

/** Resolves the selected ids from the current authoritative path. A branch
 * switch or deletion that removes either endpoint invalidates the selection. */
export function selectedMessageRange(): SelectedMessageRange | null {
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
  return {
    messages,
    messageIds: messages.map((message) => message.id),
    start,
    end,
    pathLength: path.length,
  };
}

export function messageSelectionActive(): boolean {
  return selectedMessageRange() != null;
}

export function messageIsSelected(messageId: number): boolean {
  return selectedMessageRange()?.messageIds.includes(messageId) ?? false;
}
