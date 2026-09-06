import { publicMessage } from './mediaUrls.ts';
import type { WebSocket } from 'ws';
import type { Message, TreeSnapshot } from '@tinytavern/shared';
import {
  getActiveLeafId,
  getMessage,
  getTreeMessages,
  getTreeNodes,
  takeDirtyMessageIds,
} from './tree.ts';
import { mergeLiveBuffers } from './generation.ts';
import { broadcastConv, sendTo } from './events.ts';
import { getConversationRevision } from './conversationRevision.ts';

export function treeSnapshot(conversationId: number): TreeSnapshot {
  return {
    conversationId,
    messages: mergeLiveBuffers(getTreeMessages(conversationId)).map(publicMessage),
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
      messages: mergeLiveBuffers(bodies).map(publicMessage),
    });
  });
}

/** Initial tree push when a client subscribes; live buffers included, deltas follow in order. */
export function sendTreeTo(ws: WebSocket, conversationId: number): void {
  sendTo(ws, { t: 'tree', ...treeSnapshot(conversationId) });
}
