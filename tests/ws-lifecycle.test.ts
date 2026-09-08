import assert from 'node:assert/strict';
import { mock } from 'node:test';

type Listener = (event: { persisted?: boolean }) => void;
const documentListeners = new Map<string, Listener[]>();
const windowListeners = new Map<string, Listener[]>();

const fakeDocument = {
  visibilityState: 'visible',
  addEventListener(type: string, listener: Listener) {
    documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
  },
};
const fakeWindow = {
  addEventListener(type: string, listener: Listener) {
    windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
  },
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
}

Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
Object.defineProperty(globalThis, 'location', {
  value: { protocol: 'https:', host: 'tinytavern.test' },
  configurable: true,
});
Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true });

interface WsModule {
  configureWs(handlers: {
    onEvent: (event: unknown) => void;
    onOpen: () => void;
    onStatus: (connected: boolean) => void;
    onUnauthorized: () => void;
  }): void;
  startWs(): void;
  stopWs(): void;
  subscribe(conversationId: number | null): void;
}
// A dynamic path excludes browser code from the server's DOM-free type graph;
// client tsconfig checks it, and this test supplies runtime browser globals.
const wsModulePath = '../client/src/state/ws.ts';
const { configureWs, startWs, stopWs, subscribe } = (await import(wsModulePath)) as WsModule;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dispatch = (listeners: Map<string, Listener[]>, type: string, event = {}) => {
  for (const listener of listeners.get(type) ?? []) listener(event);
};

const statuses: boolean[] = [];
let resyncs = 0;
configureWs({
  onEvent: () => {},
  onOpen: () => {
    resyncs++;
  },
  onStatus: (connected) => statuses.push(connected),
  onUnauthorized: () => {},
});

startWs();
assert.equal(FakeWebSocket.instances.length, 1);
const first = FakeWebSocket.instances[0]!;
assert.equal(first.url, 'wss://tinytavern.test/ws');
first.open();
subscribe(42);
assert.deepEqual(
  first.sent.map((payload) => JSON.parse(payload)),
  [{ sub: 42 }],
);

// Replace apparently-open sockets on PWA resume without letting the old close
// callback schedule another replacement.
fakeDocument.visibilityState = 'visible';
dispatch(documentListeners, 'visibilitychange');
await delay(80);
assert.equal(FakeWebSocket.instances.length, 2);
assert.equal(first.readyState, FakeWebSocket.CLOSED);
const second = FakeWebSocket.instances[1]!;
second.open();
assert.deepEqual(
  second.sent.map((payload) => JSON.parse(payload)),
  [{ sub: 42 }],
);
await delay(550);
assert.equal(FakeWebSocket.instances.length, 2);

// Coalesce lifecycle events commonly delivered together on network/app resume.
dispatch(windowListeners, 'online');
dispatch(windowListeners, 'pageshow', { persisted: true });
await delay(80);
assert.equal(FakeWebSocket.instances.length, 3);
const third = FakeWebSocket.instances[2]!;
third.open();
assert.deepEqual(
  third.sent.map((payload) => JSON.parse(payload)),
  [{ sub: 42 }],
);

stopWs();
dispatch(documentListeners, 'visibilitychange');
await delay(80);
assert.equal(FakeWebSocket.instances.length, 3);
assert.equal(statuses.at(-1), false);

mock.timers.enable({ apis: ['setTimeout'] });
try {
  subscribe(null);
  startWs();
  const initial = FakeWebSocket.instances.at(-1)!;
  initial.open();
  const before = resyncs;
  dispatch(windowListeners, 'focus');
  dispatch(documentListeners, 'resume');
  mock.timers.tick(50);
  const resumed = FakeWebSocket.instances.at(-1)!;
  assert.notEqual(
    resumed,
    initial,
    'Gallery/jobs resume replaces a stale socket without a chat subscription',
  );
  resumed.open();
  assert.equal(resyncs, before + 1, 'Every page triggers the full data resync');
  assert.equal(resumed.sent.length, 0);
  fakeDocument.visibilityState = 'hidden';
  dispatch(windowListeners, 'focus');
  mock.timers.tick(50);
  assert.equal(FakeWebSocket.instances.at(-1), resumed);
  fakeDocument.visibilityState = 'visible';
  dispatch(documentListeners, 'resume');
  mock.timers.tick(50);
  const stuck = FakeWebSocket.instances.at(-1)!;
  mock.timers.tick(10_000);
  assert.equal(
    stuck.readyState,
    FakeWebSocket.CLOSED,
    'A stalled handshake does not hang indefinitely',
  );
  mock.timers.tick(500);
  const replacement = FakeWebSocket.instances.at(-1)!;
  assert.notEqual(replacement, stuck);
  replacement.open();
  stuck.onclose?.({ code: 1000 });
  assert.equal(statuses.at(-1), true, 'Late close callbacks cannot disconnect the replacement');
} finally {
  stopWs();
  mock.timers.reset();
}
console.log('WebSocket lifecycle tests passed');
