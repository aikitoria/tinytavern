import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import type { ClientCommand, InvalidateEntity, ServerEvent } from '@tinytavern/shared';

export interface SocketState {
  sub: number | null;
  closed: boolean;
}
export type ClientSocket = ServerWebSocket<SocketState>;
const clients = new Set<ClientSocket>();
const subscriberCounts = new Map<number, number>();
const GLOBAL_TOPIC = 'global';
const topic = (id: number) => `conversation:${id}`;
let server: Server<SocketState> | undefined;
let onConnect: ((ws: ClientSocket) => void) | undefined;
let onSubscribe: ((ws: ClientSocket, conversationId: number) => void) | null = null;
let onUnsubscribe: ((conversationId: number) => void) | null = null;

export function bindWebSocketServer(
  value: Server<SocketState>,
  connected?: typeof onConnect,
): void {
  server = value;
  onConnect = connected;
}
export function setSubscribeHandler(fn: (ws: ClientSocket, conversationId: number) => void): void {
  onSubscribe = fn;
}
export function setUnsubscribeHandler(fn: (conversationId: number) => void): void {
  onUnsubscribe = fn;
}
export function hasConversationSubscribers(id: number): boolean {
  return subscriberCounts.has(id);
}

function unsubscribe(ws: ClientSocket, id: number): void {
  ws.unsubscribe(topic(id));
  const remaining = (subscriberCounts.get(id) ?? 1) - 1;
  if (remaining > 0) subscriberCounts.set(id, remaining);
  else {
    subscriberCounts.delete(id);
    onUnsubscribe?.(id);
  }
}

function removeClient(ws: ClientSocket): void {
  if (ws.data.closed) return;
  ws.data.closed = true;
  clients.delete(ws);
  ws.unsubscribe(GLOBAL_TOPIC);
  if (ws.data.sub !== null) unsubscribe(ws, ws.data.sub);
  ws.data.sub = null;
}

export const websocket: WebSocketHandler<SocketState> = {
  idleTimeout: 60,
  sendPings: true,
  maxPayloadLength: 64 * 1024,
  backpressureLimit: 4 * 1024 * 1024,
  closeOnBackpressureLimit: true,
  open(ws) {
    clients.add(ws);
    ws.subscribe(GLOBAL_TOPIC);
    ws.send(JSON.stringify({ t: 'hello' } satisfies ServerEvent));
    onConnect?.(ws);
  },
  message(ws, data) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch {
      return;
    }
    if (parsed == null || typeof parsed !== 'object' || !('sub' in parsed)) return;
    const cmd = parsed as ClientCommand;
    if (cmd.sub !== null && (!Number.isSafeInteger(cmd.sub) || cmd.sub <= 0)) return;
    if (ws.data.sub !== cmd.sub) {
      const previous = ws.data.sub;
      ws.data.sub = cmd.sub;
      if (previous !== null) unsubscribe(ws, previous);
      if (cmd.sub !== null) {
        subscriberCounts.set(cmd.sub, (subscriberCounts.get(cmd.sub) ?? 0) + 1);
        ws.subscribe(topic(cmd.sub));
      }
    }
    if (cmd.sub !== null) onSubscribe?.(ws, cmd.sub);
  },
  close: removeClient,
};

/** Password changes revoke upgraded sockets before any later broadcasts. */
export function disconnectAllForAuthChange(): void {
  for (const ws of clients) {
    removeClient(ws);
    ws.close(4001, 'authentication changed');
  }
}

export function sendTo(ws: ClientSocket, ev: ServerEvent): void {
  if (!ws.data.closed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
}

export function broadcast(ev: ServerEvent): void {
  server?.publish(GLOBAL_TOPIC, JSON.stringify(ev));
}

/** Drop only replaceable previews for congested clients; durable state remains recoverable. */
export function broadcastMediaProgress(ev: Extract<ServerEvent, { t: 'mediaJobProgress' }>): void {
  const payload = JSON.stringify(ev);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN && ws.getBufferedAmount() < 1024 * 1024) ws.send(payload);
  }
}

export function broadcastConv(id: number, ev: ServerEvent): void {
  server?.publish(topic(id), JSON.stringify(ev));
}

export function subscribedConversationIds(): number[] {
  return [...subscriberCounts.keys()];
}

const invalidationObservers = new Set<(entity: InvalidateEntity) => void>();

/** Local background work can react to the same committed changes sent to clients. */
export function observeInvalidation(observer: (entity: InvalidateEntity) => void): () => void {
  invalidationObservers.add(observer);
  return () => {
    invalidationObservers.delete(observer);
  };
}

export function invalidate(entity: InvalidateEntity): void {
  broadcast({ t: 'invalidate', entity });
  for (const observer of invalidationObservers) observer(entity);
}
