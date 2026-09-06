import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { ClientCommand, InvalidateEntity, ServerEvent } from '@minitavern/shared';
import { isRequestIpAllowed, isRequestOriginAllowed } from './ipAccess.ts';
import { isRequestAuthenticated } from './auth.ts';

const clients = new Map<WebSocket, { sub: number | null; alive: boolean }>();
let onSubscribe: ((ws: WebSocket, conversationId: number) => void) | null = null;
let onUnsubscribe: ((conversationId: number) => void) | null = null;

/** Called whenever a client subscribes to a conversation (used to push the initial tree). */
export function setSubscribeHandler(fn: (ws: WebSocket, conversationId: number) => void): void {
  onSubscribe = fn;
}

/** Called when a conversation loses its last connected viewer. */
export function setUnsubscribeHandler(fn: (conversationId: number) => void): void {
  onUnsubscribe = fn;
}

export function hasConversationSubscribers(conversationId: number): boolean {
  for (const [ws, state] of clients) {
    if (state.sub === conversationId && ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

function notifyUnsubscribed(conversationId: number | null): void {
  if (conversationId != null && !hasConversationSubscribers(conversationId)) {
    onUnsubscribe?.(conversationId);
  }
}

function removeClient(ws: WebSocket): void {
  const state = clients.get(ws);
  if (!state) return;
  clients.delete(ws);
  notifyUnsubscribed(state.sub);
}

export function initWebSocket(server: Server): void {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ req }, done) => {
      if (!isRequestIpAllowed(req)) done(false, 403, 'IP address is not allowed');
      else if (!isRequestOriginAllowed(req))
        done(false, 403, 'cross-site requests are not allowed');
      else if (!isRequestAuthenticated(req)) done(false, 401, 'authentication required');
      else done(true);
    },
  });
  wss.on('connection', (ws) => {
    clients.set(ws, { sub: null, alive: true });
    ws.send(JSON.stringify({ t: 'hello' } satisfies ServerEvent));
    ws.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (parsed == null || typeof parsed !== 'object' || !('sub' in parsed)) return;
      const cmd = parsed as ClientCommand;
      if (cmd.sub === null || (Number.isSafeInteger(cmd.sub) && cmd.sub > 0)) {
        const state = clients.get(ws);
        if (!state) return;
        const previous = state.sub;
        state.sub = cmd.sub;
        if (previous !== cmd.sub) notifyUnsubscribed(previous);
        if (cmd.sub != null) onSubscribe?.(ws, cmd.sub);
      }
    });
    ws.on('pong', () => {
      const state = clients.get(ws);
      if (state) state.alive = true;
    });
    ws.on('close', () => removeClient(ws));
    ws.on('error', () => removeClient(ws));
  });
  const heartbeat = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive) {
        ws.terminate();
        removeClient(ws);
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));
}

/** Password changes invalidate sessions, including already-upgraded sockets. */
export function disconnectAllForAuthChange(): void {
  for (const ws of clients.keys()) ws.close(4001, 'authentication changed');
}

export function sendTo(ws: WebSocket, ev: ServerEvent): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
}

/** Broadcast to every connected client. */
export function broadcast(ev: ServerEvent): void {
  const payload = JSON.stringify(ev);
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/** Broadcast to clients subscribed to a specific conversation. */
export function broadcastConv(conversationId: number, ev: ServerEvent): void {
  const payload = JSON.stringify(ev);
  for (const [ws, state] of clients) {
    if (state.sub === conversationId && ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/** Conversations currently visible in at least one connected client. */
export function subscribedConversationIds(): number[] {
  return [
    ...new Set([...clients.values()].flatMap((state) => (state.sub == null ? [] : [state.sub]))),
  ];
}

export function invalidate(entity: InvalidateEntity): void {
  broadcast({ t: 'invalidate', entity });
}
