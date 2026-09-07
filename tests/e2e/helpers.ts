import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { WebSocket as HeaderWebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import type { Message, ServerEvent, Settings, TreeSnapshot } from '@tinytavern/shared';
import { chunk } from '../../server/src/pngChunk.ts';

if (!process.env.E2E_BASE || !process.env.E2E_MOCK) {
  console.error(
    'E2E_BASE and E2E_MOCK must be set explicitly — this suite mutates settings and data\n' +
      'on the target server. Run it against an isolated throwaway instance only.',
  );
  process.exit(1);
}
export const BASE = process.env.E2E_BASE;
export const MOCK_URL = process.env.E2E_MOCK;
export const MOCK_CONTROL = MOCK_URL.replace(/\/v1\/?$/, '');

export let passed = 0;

export function assert(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  passed++;
  console.log(`  ok: ${label}`);
}

/** Catch client entry and built-in image export failures in Vite's development transform. */
export async function assertClientDevModules(): Promise<void> {
  const clientRoot = join(process.cwd(), 'client');
  const vite = await createViteServer({
    root: clientRoot,
    configFile: join(clientRoot, 'vite.config.ts'),
    logLevel: 'silent',
    // One-shot transforms need no watchers, HMR, or background dependency discovery.
    server: { middlewareMode: true, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const paths = [
      '/src/index.tsx',
      '/src/App.tsx',
      '/src/components/SettingsModal.tsx',
      '/src/components/tabs/GalleryTab.tsx',
      '/src/images/imageGeneration.tsx',
    ];
    const transformed = new Map<string, string>();
    for (const path of paths) {
      const result = await vite.transformRequest(path);
      assert(result != null && result.code.length > 0, `Vite transforms ${path}`);
      // Source maps embed source text that could falsely satisfy runtime export checks.
      transformed.set(path, result!.code.split('\n//# sourceMappingURL=', 1)[0]!);
    }
    for (const name of [
      'imageMessage',
      'imageGenerationCommands',
      'imageGenerationTools',
      'ImageGenerationSettingsPage',
    ]) {
      assert(
        new RegExp(
          `export\\s+(?:const|function)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`,
        ).test(transformed.get('/src/images/imageGeneration.tsx')!),
        `the built-in image module exports ${name}`,
      );
    }
  } finally {
    await vite.close();
  }
}

export async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export async function collectRenderProgress(response: Response, label: string): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawProgress = false;
  let sawPreview = false;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`${label} SSE ended before progress and preview`);
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const event = JSON.parse(line.slice(5)) as {
        value?: number;
        max?: number;
        preview?: string;
      };
      if (event.max && typeof event.value === 'number') sawProgress = true;
      if (event.preview?.startsWith('data:image/jpeg;base64,')) sawPreview = true;
      if (sawProgress && sawPreview) return;
    }
  }
}

export async function expectStatus(
  method: string,
  path: string,
  body: unknown,
  status: number,
): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(res.status === status, `${method} ${path} rejects invalid input with ${status}`);
}

export async function websocketHandshake(
  origin: string,
  cookie?: string,
): Promise<'open' | number> {
  return new Promise((resolve, reject) => {
    const ws = new HeaderWebSocket(`${BASE.replace('http', 'ws')}/ws`, {
      origin,
      ...(cookie ? { headers: { cookie } } : {}),
    });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timeout waiting for WebSocket handshake from ${origin}`));
    }, 5000);
    ws.once('open', () => {
      clearTimeout(timeout);
      ws.close();
      resolve('open');
    });
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      ws.terminate();
      resolve(response.statusCode ?? 0);
    });
    ws.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export class WsClient {
  events: ServerEvent[] = [];
  private ws: WebSocket;
  private waiters: { pred: (ev: ServerEvent) => boolean; resolve: (ev: ServerEvent) => void }[] =
    [];

  constructor() {
    this.ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
    this.ws.onmessage = (event: MessageEvent) => {
      const ev = JSON.parse(event.data as string) as ServerEvent;
      this.events.push(ev);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(ev)) {
          w.resolve(ev);
          return false;
        }
        return true;
      });
    };
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e: Event) => reject(new Error(`ws error: ${String(e)}`));
    });
  }

  sub(conversationId: number | null): void {
    this.ws.send(JSON.stringify({ sub: conversationId }));
  }

  sendRaw(value: unknown): void {
    this.ws.send(JSON.stringify(value));
  }

  waitFor(
    pred: (ev: ServerEvent) => boolean,
    label: string,
    timeoutMs = 15000,
  ): Promise<ServerEvent> {
    const existing = this.events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for: ${label}`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (ev) => {
          clearTimeout(timer);
          resolve(ev);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

export function makeCardPng(
  card: unknown = {
    spec: 'chara_card_v2',
    data: {
      name: 'Card Imported Hero',
      description: 'A brave test subject.',
      personality: 'Fearless and pixelated.',
      scenario: 'Inside a unit test.',
      first_mes: 'Greetings, {{user}}! I am {{char}}.',
      system_prompt: 'Imported system prompt.',
      alternate_greetings: ['Alternate hello, {{user}}!'],
    },
  },
): Buffer {
  // 1x1 PNG with a tEXt 'chara' chunk carrying a V2 card.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const text = Buffer.concat([
    Buffer.from('chara', 'latin1'),
    Buffer.from([0]),
    Buffer.from(Buffer.from(JSON.stringify(card), 'utf8').toString('base64'), 'latin1'),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', text),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function makeCompressedMetadataBombPng(): Buffer {
  const metadata = Buffer.concat([
    Buffer.from('chara\0', 'latin1'),
    Buffer.from([1, 0, 0, 0]),
    deflateSync(Buffer.alloc(9 * 1024 * 1024, 0x41)),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('iTXt', metadata),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const tree = (id: number) => req<TreeSnapshot>('GET', `/api/conversations/${id}/tree`);

export const fetchTrace = (id: number) =>
  req<{
    messages: { role: string; content: string; reasoning_content?: string }[];
    reasoningPrefill: string | null;
    messagePrefill: string | null;
    namePrefill: string | null;
  }>('GET', `/api/conversations/${id}/trace`);

export async function branchBody(conversationId: number, body: Record<string, unknown> = {}) {
  const snapshot = await tree(conversationId);
  return {
    ...body,
    expectedActiveLeafId: snapshot.activeLeafId,
    expectedMutationRevision: snapshot.mutationRevision,
  };
}

export async function branchBodyAt(
  conversationId: number,
  expectedActiveLeafId: number | null,
  body: Record<string, unknown> = {},
) {
  const snapshot = await tree(conversationId);
  return { ...body, expectedActiveLeafId, expectedMutationRevision: snapshot.mutationRevision };
}

export function branchQuery(snapshot: TreeSnapshot, activeLeafId = snapshot.activeLeafId): string {
  return `expectedActiveLeafId=${activeLeafId ?? 'null'}&expectedMutationRevision=${snapshot.mutationRevision}`;
}

export async function branchPath(
  conversationId: number,
  path: string,
  expectedActiveLeafId: number | null,
): Promise<string> {
  const snapshot = await tree(conversationId);
  return `${path}?${branchQuery(snapshot, expectedActiveLeafId)}`;
}

export async function patchConversation(
  conversationId: number,
  patch: Record<string, unknown>,
): Promise<unknown> {
  return req(
    'PATCH',
    `/api/conversations/${conversationId}`,
    await branchBody(conversationId, patch),
  );
}

export async function stopGeneration(conversationId: number, messageId: number): Promise<void> {
  const snapshot = await tree(conversationId);
  const token = snapshot.messages.find((message) => message.id === messageId)?.generationToken;
  if (token == null) throw new Error(`message ${messageId} has no generation token`);
  await req('POST', `/api/generations/${messageId}/stop`, { expectedGenerationToken: token });
}

export const sendMessage = async (conversationId: number, content: string) =>
  req<{ userMessageId: number; assistantMessageId: number }>(
    'POST',
    `/api/conversations/${conversationId}/messages`,
    await branchBody(conversationId, { content }),
  );

export const activate = async (conversationId: number, messageId: number) =>
  req('POST', `/api/messages/${messageId}/activate`, await branchBody(conversationId));

export async function failNextMockRequests(count: number): Promise<void> {
  const res = await fetch(`${MOCK_CONTROL}/control/fail-next?count=${count}`, { method: 'POST' });
  if (!res.ok) throw new Error(`could not configure mock failures: ${await res.text()}`);
}

export async function makeNextMockResponseEndWithoutNewline(): Promise<void> {
  const res = await fetch(`${MOCK_CONTROL}/control/terminal-without-newline`, { method: 'POST' });
  if (!res.ok) throw new Error(`could not configure terminal mock event: ${await res.text()}`);
}

export async function makeNextMockResponseDieAfterContent(content: string): Promise<void> {
  const res = await fetch(
    `${MOCK_CONTROL}/control/die-after-content?content=${encodeURIComponent(content)}`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`could not configure mid-stream mock death: ${await res.text()}`);
}

export async function putSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await req<Settings>('GET', '/api/settings');
  return req<Settings>('PUT', '/api/settings', {
    ...patch,
    expectedRevision: current.revision,
  });
}

export function pathOf(snapshot: TreeSnapshot): Message[] {
  const byId = new Map(snapshot.messages.map((m) => [m.id, m]));
  const path: Message[] = [];
  let cur = snapshot.activeLeafId;
  while (cur != null) {
    const msg = byId.get(cur)!;
    path.push(msg);
    cur = msg.parentId;
  }
  return path.reverse();
}

/** Compare links by id-order position, which duplication preserves even after reparenting. */
export function treeLinkShape(snapshot: TreeSnapshot): unknown {
  const ordered = [...snapshot.messages].sort((a, b) => a.id - b.id);
  const index = new Map(ordered.map((message, i) => [message.id, i]));
  return {
    activeLeaf: snapshot.activeLeafId == null ? null : index.get(snapshot.activeLeafId),
    nodes: ordered.map((message) => ({
      parent: message.parentId == null ? null : index.get(message.parentId),
      activeChild: message.activeChildId == null ? null : index.get(message.activeChildId),
    })),
  };
}
