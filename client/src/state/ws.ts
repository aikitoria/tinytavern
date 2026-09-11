import type { ClientCommand, ServerEvent } from '@tinytavern/shared';

let sock: WebSocket | null = null;
let currentSub: number | null = null;
const extraSubscriptions = new Map<object, number>();
function sendSubscriptions(resync?: number): void {
  if (!extraSubscriptions.size) {
    send({ sub: currentSub });
    return;
  }
  send({
    subs: [
      ...new Set([...(currentSub === null ? [] : [currentSub]), ...extraSubscriptions.values()]),
    ],
    resync,
  });
}
let retryDelay = 500;
let started = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
let lifecycleListenersInstalled = false;

// Set lazily to break the import cycle with store.ts.
let onEvent: ((ev: ServerEvent) => void) | null = null;
let onOpen: (() => void) | null = null;
let onStatus: ((connected: boolean) => void) | null = null;
let onUnauthorized: (() => void) | null = null;

export function configureWs(handlers: {
  onEvent: (ev: ServerEvent) => void;
  onOpen: () => void;
  onStatus: (connected: boolean) => void;
  onUnauthorized: () => void;
}): void {
  onEvent = handlers.onEvent;
  onOpen = handlers.onOpen;
  onStatus = handlers.onStatus;
  onUnauthorized = handlers.onUnauthorized;
}

function scheduleReconnect(): void {
  if (!started || reconnectTimer != null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 5000);
}

function connect(): void {
  if (!started) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  sock = ws;
  connectTimer = setTimeout(() => {
    if (sock !== ws) return;
    connectTimer = null;
    sock = null;
    ws.close();
    onStatus?.(false);
    scheduleReconnect();
  }, 10_000);
  ws.onopen = () => {
    if (sock !== ws || !started) {
      ws.close();
      return;
    }
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = null;
    retryDelay = 500;
    onStatus?.(true);
    // Resync: state may have changed while disconnected.
    onOpen?.();
    // Reconnect restores every mounted session; server subscriptions start empty.
    if (currentSub !== null || extraSubscriptions.size) sendSubscriptions();
  };
  ws.onmessage = (event) => {
    if (sock !== ws) return;
    try {
      onEvent?.(JSON.parse(event.data as string) as ServerEvent);
    } catch (err) {
      console.error('[ws] bad event:', err);
    }
  };
  ws.onclose = (event) => {
    // A replaced socket may close late; do not disturb its successor.
    if (sock !== ws) return;
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = null;
    onStatus?.(false);
    sock = null;
    if (event.code === 4001) onUnauthorized?.();
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

/** Replace even an apparently OPEN socket. Mobile browsers can retain that
 * readyState while the suspended PWA's underlying connection is already dead. */
export function refreshWs(): void {
  if (!started) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = null;
  retryDelay = 500;
  const previous = sock;
  sock = null;
  previous?.close();
  onStatus?.(false);
  connect();
}

function queueResumeRefresh(): void {
  if (!started || document.visibilityState !== 'visible' || resumeTimer != null) return;
  // Coalesce visibility/online/pageshow bursts to avoid replacing the new socket again.
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    refreshWs();
  }, 50);
}

function installLifecycleListeners(): void {
  if (lifecycleListenersInstalled) return;
  lifecycleListenersInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') queueResumeRefresh();
  });
  window.addEventListener('online', queueResumeRefresh);
  window.addEventListener('focus', queueResumeRefresh);
  document.addEventListener('resume', queueResumeRefresh);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) queueResumeRefresh();
  });
}

export function startWs(): void {
  if (started) return;
  started = true;
  installLifecycleListeners();
  connect();
}

export function stopWs(): void {
  started = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = null;
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = null;
  const current = sock;
  sock = null;
  current?.close();
  onStatus?.(false);
}

function send(cmd: ClientCommand): void {
  if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(cmd));
}

export function subscribe(conversationId: number | null): void {
  currentSub = conversationId;
  sendSubscriptions(conversationId ?? undefined);
}

/** Independent view ownership, sharing one socket and deduplicated server subscriptions. */
export function watchConversation(owner: object, id: number | null): void {
  if (id === null) extraSubscriptions.delete(owner);
  else extraSubscriptions.set(owner, id);
  sendSubscriptions(id ?? undefined);
}
