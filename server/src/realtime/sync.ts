import { publicMessage } from '../media/mediaUrls.ts';
import type { ClientSocket } from './events.ts';
import type { Message, TreeSnapshot } from '@tinytavern/shared';
import {
  getActiveLeafId,
  getMessage,
  getTreeMessages,
  getTreeNodes,
  takeDirtyMessageIds,
} from '../conversations/tree.ts';
import { mergeLiveBuffers } from '../generation/generation.ts';
import { broadcastConv, sendTo } from './events.ts';
import { getConversationRevision } from '../conversations/conversationRevision.ts';

function publicLiveMessages(messages: Message[]): Message[] {
  return mergeLiveBuffers(messages).map(publicMessage);
}

export function treeSnapshot(conversationId: number): TreeSnapshot {
  return {
    conversationId,
    messages: publicLiveMessages(getTreeMessages(conversationId)),
    activeLeafId: getActiveLeafId(conversationId),
    mutationRevision: getConversationRevision(conversationId),
  };
}

const pendingTreeBroadcasts = new Set<number>();

/** Coalesce mutations per microtask into full structure plus changed bodies.
 * Subscribers already have a snapshot and receive frames in order. */
export function broadcastTree(conversationId: number): void {
  if (pendingTreeBroadcasts.has(conversationId)) return;
  pendingTreeBroadcasts.add(conversationId);
  queueMicrotask(() => {
    pendingTreeBroadcasts.delete(conversationId);
    const bodies: Message[] = [];
    for (const id of takeDirtyMessageIds(conversationId)) {
      const msg = getMessage(id); // dirty id may have been deleted in the same batch
      if (msg) bodies.push(msg);
    }
    broadcastConv(conversationId, {
      t: 'treePatch',
      conversationId,
      activeLeafId: getActiveLeafId(conversationId),
      mutationRevision: getConversationRevision(conversationId),
      nodes: getTreeNodes(conversationId),
      messages: publicLiveMessages(bodies),
    });
  });
}

/** Initial tree push when a client subscribes; live buffers included, deltas follow in order. */
export function sendTreeTo(ws: ClientSocket, conversationId: number): void {
  sendTo(ws, { t: 'tree', ...treeSnapshot(conversationId) });
}
