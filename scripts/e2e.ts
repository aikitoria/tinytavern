// End-to-end test suite. DESTRUCTIVE: it mutates settings and creates/deletes
// data on the target server — NEVER point it at a live instance. There are
// deliberately no default targets; run it fully isolated (see CLAUDE.md):
//
//   docker compose -p minitavern-e2e -f docker-compose.dev.yml run --rm --no-deps \
//     -e DATA_DIR=/tmp/e2e-data -e E2E_BASE=http://127.0.0.1:15487 -e E2E_MOCK=http://127.0.0.1:19800/v1 \
//     server sh -c 'PORT=15487 node server/src/index.ts & PORT=19800 node scripts/mock-openai.ts & \
//       sleep 2; node scripts/e2e.ts'
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket as HeaderWebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { expandWorkflowTemplate, workflowValidationError } from '@minitavern/shared';
import type {
  Character,
  CharacterFolder,
  Conversation,
  GenParams,
  GalleryItem,
  Message,
  ServerEvent,
  Settings,
  TreeSnapshot,
} from '@minitavern/shared';
import { chunk } from './pngChunk.ts';
import { createIpAllowlist } from '../server/src/ipAccess.ts';

if (!process.env.E2E_BASE || !process.env.E2E_MOCK) {
  console.error(
    'E2E_BASE and E2E_MOCK must be set explicitly — this suite mutates settings and data\n' +
      'on the target server. Run it against an isolated throwaway instance only.',
  );
  process.exit(1);
}
const BASE = process.env.E2E_BASE;
const MOCK_URL = process.env.E2E_MOCK;
const MOCK_CONTROL = MOCK_URL.replace(/\/v1\/?$/, '');

let passed = 0;

function assert(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  passed++;
  console.log(`  ok: ${label}`);
}

/** Exercise Vite's development transform, not just the production bundle.
 * This catches broken client entry modules and import/export contract drift in
 * the plugin registry before an otherwise healthy API deployment. */
async function assertClientDevModules(): Promise<void> {
  const clientRoot = join(process.cwd(), 'client');
  const vite = await createViteServer({
    root: clientRoot,
    configFile: join(clientRoot, 'vite.config.ts'),
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  try {
    const paths = [
      '/src/index.tsx',
      '/src/App.tsx',
      '/src/plugins/index.ts',
      '/src/plugins/imageGeneration.tsx',
    ];
    const transformed = new Map<string, string>();
    for (const path of paths) {
      const result = await vite.transformRequest(path);
      assert(result != null && result.code.length > 0, `Vite transforms ${path}`);
      // Ignore the inline source map: it embeds the original source text and
      // must not make a missing runtime export look present.
      transformed.set(path, result!.code.split('\n//# sourceMappingURL=', 1)[0]!);
    }
    assert(
      /import\s*\{\s*imageGenerationPlugin\s*\}\s*from\s*["'][^"']*imageGeneration\.tsx(?:\?[^"']*)?["']/.test(
        transformed.get('/src/plugins/index.ts')!,
      ),
      'the development plugin registry imports imageGenerationPlugin',
    );
    assert(
      /export\s+const\s+imageGenerationPlugin\b|export\s*\{[^}]*\bimageGenerationPlugin\b[^}]*\}/.test(
        transformed.get('/src/plugins/imageGeneration.tsx')!,
      ),
      'the transformed image plugin provides the named registry export',
    );
  } finally {
    await vite.close();
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

async function expectStatus(
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

async function websocketHandshake(origin: string, cookie?: string): Promise<'open' | number> {
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

class WsClient {
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

function makeCardPng(
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

function makeCompressedMetadataBombPng(): Buffer {
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

const tree = (id: number) => req<TreeSnapshot>('GET', `/api/conversations/${id}/tree`);

const fetchTrace = (id: number) =>
  req<{
    messages: { role: string; content: string; reasoning_content?: string }[];
    reasoningPrefill: string | null;
    messagePrefill: string | null;
    namePrefill: string | null;
  }>('GET', `/api/conversations/${id}/trace`);

async function branchBody(conversationId: number, body: Record<string, unknown> = {}) {
  const snapshot = await tree(conversationId);
  return {
    ...body,
    expectedActiveLeafId: snapshot.activeLeafId,
    expectedMutationRevision: snapshot.mutationRevision,
  };
}

async function branchBodyAt(
  conversationId: number,
  expectedActiveLeafId: number | null,
  body: Record<string, unknown> = {},
) {
  const snapshot = await tree(conversationId);
  return { ...body, expectedActiveLeafId, expectedMutationRevision: snapshot.mutationRevision };
}

function branchQuery(snapshot: TreeSnapshot, activeLeafId = snapshot.activeLeafId): string {
  return `expectedActiveLeafId=${activeLeafId ?? 'null'}&expectedMutationRevision=${snapshot.mutationRevision}`;
}

async function branchPath(
  conversationId: number,
  path: string,
  expectedActiveLeafId: number | null,
): Promise<string> {
  const snapshot = await tree(conversationId);
  return `${path}?${branchQuery(snapshot, expectedActiveLeafId)}`;
}

async function patchConversation(
  conversationId: number,
  patch: Record<string, unknown>,
): Promise<unknown> {
  return req(
    'PATCH',
    `/api/conversations/${conversationId}`,
    await branchBody(conversationId, patch),
  );
}

async function stopGeneration(conversationId: number, messageId: number): Promise<void> {
  const snapshot = await tree(conversationId);
  const token = snapshot.messages.find((message) => message.id === messageId)?.generationToken;
  if (token == null) throw new Error(`message ${messageId} has no generation token`);
  await req('POST', `/api/generations/${messageId}/stop`, { expectedGenerationToken: token });
}

const sendMessage = async (conversationId: number, content: string) =>
  req<{ userMessageId: number; assistantMessageId: number }>(
    'POST',
    `/api/conversations/${conversationId}/messages`,
    await branchBody(conversationId, { content }),
  );

const activate = async (conversationId: number, messageId: number) =>
  req('POST', `/api/messages/${messageId}/activate`, await branchBody(conversationId));

async function failNextMockRequests(count: number): Promise<void> {
  const res = await fetch(`${MOCK_CONTROL}/control/fail-next?count=${count}`, { method: 'POST' });
  if (!res.ok) throw new Error(`could not configure mock failures: ${await res.text()}`);
}

async function makeNextMockResponseEndWithoutNewline(): Promise<void> {
  const res = await fetch(`${MOCK_CONTROL}/control/terminal-without-newline`, { method: 'POST' });
  if (!res.ok) throw new Error(`could not configure terminal mock event: ${await res.text()}`);
}

async function makeNextMockResponseDieAfterContent(content: string): Promise<void> {
  const res = await fetch(
    `${MOCK_CONTROL}/control/die-after-content?content=${encodeURIComponent(content)}`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`could not configure mid-stream mock death: ${await res.text()}`);
}

async function putSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await req<Settings>('GET', '/api/settings');
  return req<Settings>('PUT', '/api/settings', {
    ...patch,
    expectedRevision: current.revision,
  });
}

function pathOf(snapshot: TreeSnapshot): Message[] {
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

/** Compares only tree links, translating message ids to each snapshot's stable
 * id-order positions. Conversation duplication preserves that row ordering
 * even when moves/insertions make a newer message the parent of an older one. */
function treeLinkShape(snapshot: TreeSnapshot): unknown {
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

async function main() {
  console.log('== development client modules ==');
  await assertClientDevModules();

  const unrestricted = createIpAllowlist('   ');
  assert(
    unrestricted.isAllowed('203.0.113.42') && unrestricted.isAllowed('2001:db8::42'),
    'an explicitly empty IP allowlist permits every source address',
  );

  console.log('== cross-site request rejection ==');
  const hostileGet = await fetch(`${BASE}/api/settings`, {
    headers: { origin: 'http://attacker.invalid' },
  });
  assert(hostileGet.status === 403, 'cross-site HTTP reads are rejected');
  const hostilePost = await fetch(`${BASE}/api/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'http://attacker.invalid' },
    body: '{}',
  });
  assert(hostilePost.status === 403, 'cross-site text/plain POSTs are rejected before mutation');
  const sameOriginGet = await fetch(`${BASE}/api/settings`, {
    headers: { origin: new URL(BASE).origin },
  });
  assert(sameOriginGet.ok, 'same-origin browser HTTP requests remain accepted');
  assert(
    (await websocketHandshake('http://attacker.invalid')) === 403,
    'cross-site WebSocket upgrades are rejected',
  );
  assert(
    (await websocketHandshake(new URL(BASE).origin)) === 'open',
    'same-origin WebSocket upgrades remain accepted',
  );

  console.log('== workflow macro context validation ==');
  const unsafeWorkflow = String.raw`{"x":"\{{prompt}}"}`;
  assert(
    workflowValidationError(unsafeWorkflow)?.includes('unpaired backslash') === true,
    'backslash-adjacent prompt macros are rejected at validation time',
  );
  assert(
    workflowValidationError('{"seed":"{{seed}}"}')?.includes('JSON number value') === true,
    'quoted seed macros are rejected instead of changing type',
  );
  const macroPrompt = 'quotes " and slash \\ survive\nnewlines';
  const expandedWorkflow = expandWorkflowTemplate(
    '{"text":"prefix {{prompt}} suffix","seed":{{seed}}}',
    macroPrompt,
    42,
  );
  const expandedWorkflowJson = JSON.parse(expandedWorkflow) as { text: string; seed: number };
  assert(
    expandedWorkflowJson.text === `prefix ${macroPrompt} suffix` &&
      expandedWorkflowJson.seed === 42,
    'shared workflow expansion preserves prompt text and numeric seeds in real JSON context',
  );

  console.log('== setup: endpoint, models, settings ==');
  const endpoint = await req<{ id: number }>('POST', '/api/endpoints', {
    name: 'mock',
    baseUrl: MOCK_URL,
    apiKey: 'test-key',
  });
  const publicEndpoint = (
    await req<{ id: number; apiKey: string; hasApiKey: boolean }[]>('GET', '/api/endpoints')
  ).find((candidate) => candidate.id === endpoint.id)!;
  assert(
    publicEndpoint.apiKey === '' && publicEndpoint.hasApiKey,
    'endpoint API responses redact stored secrets',
  );
  const models = await req<string[]>('GET', `/api/endpoints/${endpoint.id}/models`);
  assert(models.includes('mock-large'), 'model list fetched from upstream');
  const modelAuthorization = async () =>
    (
      (await (await fetch(`${MOCK_CONTROL}/control/last-model-authorization`)).json()) as {
        authorization: string | null;
      }
    ).authorization;
  assert(
    (await modelAuthorization()) === 'Bearer test-key',
    'model fetch sends the configured key',
  );
  const sameAuthorityUrl = new URL(MOCK_URL);
  sameAuthorityUrl.pathname = '/alt/v1';
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { baseUrl: sameAuthorityUrl.toString() });
  await req<string[]>('GET', `/api/endpoints/${endpoint.id}/models`);
  assert(
    (await modelAuthorization()) === 'Bearer test-key',
    'same-authority endpoint path edits preserve the stored key',
  );
  const retargetedUrl = new URL(sameAuthorityUrl);
  retargetedUrl.hostname = retargetedUrl.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { baseUrl: retargetedUrl.toString() });
  await req<string[]>('GET', `/api/endpoints/${endpoint.id}/models`);
  const retargetedEndpoint = (
    await req<{ id: number; hasApiKey: boolean }[]>('GET', '/api/endpoints')
  ).find((candidate) => candidate.id === endpoint.id)!;
  assert(
    !retargetedEndpoint.hasApiKey && (await modelAuthorization()) === null,
    'retargeting endpoint authority clears the hidden key before model fetch',
  );
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { baseUrl: MOCK_URL, apiKey: 'test-key' });
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { model: 'mock-large' });
  await req('PATCH', `/api/endpoints/${endpoint.id}`, {
    genParams: { reasoningEffort: 'high' },
  });
  await req('PATCH', `/api/endpoints/${endpoint.id}`, {
    genParams: { maxTokens: 321 },
  });
  const endpointAfterPartialParams = (
    await req<{ id: number; genParams: { reasoningEffort?: string; maxTokens?: number } }[]>(
      'GET',
      '/api/endpoints',
    )
  ).find((candidate) => candidate.id === endpoint.id)!;
  assert(
    endpointAfterPartialParams.genParams.reasoningEffort === 'high' &&
      endpointAfterPartialParams.genParams.maxTokens === 321,
    'partial endpoint generation-parameter PATCH preserves unspecified keys',
  );
  await req('PATCH', `/api/endpoints/${endpoint.id}`, {
    genParams: {},
    replaceGenParams: true,
  });
  const endpointAfterClearingParams = (
    await req<{ id: number; genParams: GenParams }[]>('GET', '/api/endpoints')
  ).find((candidate) => candidate.id === endpoint.id)!;
  assert(
    Object.keys(endpointAfterClearingParams.genParams).length === 0,
    'the first-party replacement marker persists omitted generation parameters',
  );
  await req('PATCH', `/api/endpoints/${endpoint.id}`, {
    genParams: { reasoningEffort: 'high', maxTokens: 321 },
    replaceGenParams: true,
  });
  await expectStatus(
    'PATCH',
    `/api/endpoints/${endpoint.id}`,
    { genParams: { reasoningEffort: 'extreme' } },
    400,
  );

  console.log('== endpoint duplicate carries the secret key ==');
  const endpointCopy = await req<{
    id: number;
    name: string;
    apiKey: string;
    hasApiKey: boolean;
    model: string | null;
  }>('POST', `/api/endpoints/${endpoint.id}/duplicate`);
  assert(
    endpointCopy.name === 'mock (copy)' &&
      endpointCopy.apiKey === '' &&
      endpointCopy.hasApiKey &&
      endpointCopy.model === 'mock-large',
    'endpoint duplicate copies fields and redacts the copied secret',
  );
  await req<string[]>('GET', `/api/endpoints/${endpointCopy.id}/models`);
  assert(
    (await modelAuthorization()) === 'Bearer test-key',
    'duplicated endpoint fetches models with the copied key',
  );
  await req('DELETE', `/api/endpoints/${endpointCopy.id}`);

  await putSettings({ activeEndpointId: endpoint.id });

  console.log('== private persistence + online backup ==');
  const dataDir = process.env.DATA_DIR!;
  for (const path of [
    dataDir,
    join(dataDir, 'minitavern.db'),
    join(dataDir, 'minitavern.db-wal'),
    join(dataDir, 'minitavern.db-shm'),
  ]) {
    assert((statSync(path).mode & 0o077) === 0, `${path} is private to the server user`);
  }
  const backupPath = join('/tmp', `minitavern-e2e-backup-${randomUUID()}.db`);
  execFileSync('node', ['server/src/backup.ts', backupPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'pipe',
  });
  try {
    assert((statSync(backupPath).mode & 0o077) === 0, 'online backup file is mode 0600');
    const live = new DatabaseSync(join(dataDir, 'minitavern.db'), { readOnly: true });
    const snapshot = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const liveEndpoints = (
        live.prepare('SELECT count(*) AS n FROM endpoints').get() as { n: number }
      ).n;
      const backupEndpoints = (
        snapshot.prepare('SELECT count(*) AS n FROM endpoints').get() as { n: number }
      ).n;
      const integrity = snapshot.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      };
      assert(
        liveEndpoints === backupEndpoints && integrity.integrity_check === 'ok',
        'online backup is a complete, valid SQLite snapshot while WAL is active',
      );
    } finally {
      live.close();
      snapshot.close();
    }
  } finally {
    unlinkSync(backupPath);
  }

  console.log('== shared settings reject stale device writes ==');
  const settingsBase = await req<Settings>('GET', '/api/settings');
  await req<Settings>('PUT', '/api/settings', {
    autoExpandThinking: true,
    expectedRevision: settingsBase.revision,
  });
  await expectStatus(
    'PUT',
    '/api/settings',
    { autoExpandThinking: false, expectedRevision: settingsBase.revision },
    409,
  );
  await putSettings({ autoExpandThinking: false });

  console.log('== persona + preset + macro substitution ==');
  const persona = await req<{ id: number }>('POST', '/api/personas', {
    name: 'Aiki',
    description: 'A performance-obsessed developer.',
  });
  const preset = await req<{ id: number }>('POST', '/api/presets', {
    name: 'Test preset',
    content: 'You are {{char}} speaking with {{user}}.',
  });
  await putSettings({ defaultPersonaId: persona.id, defaultPresetId: preset.id });

  console.log('== stale defaults and request validation ==');
  const disposablePersona = await req<{ id: number }>('POST', '/api/personas', {
    name: 'Disposable default',
  });
  await putSettings({ defaultPersonaId: disposablePersona.id });
  await req('DELETE', `/api/personas/${disposablePersona.id}`);
  const settingsAfterDelete = await req<{ defaultPersonaId: number | null }>(
    'GET',
    '/api/settings',
  );
  assert(
    settingsAfterDelete.defaultPersonaId === null,
    'deleting a default persona clears settings',
  );
  const noPersonaConv = await req<{ personaId: number | null }>('POST', '/api/conversations', {});
  assert(
    noPersonaConv.personaId === null,
    'conversation creation survives a deleted default persona',
  );
  await putSettings({ defaultPersonaId: persona.id });
  await expectStatus('PATCH', `/api/personas/${persona.id}`, { name: '   ' }, 400);
  await expectStatus(
    'PUT',
    '/api/settings',
    {
      defaultPersonaId: 999999999,
      expectedRevision: (await req<Settings>('GET', '/api/settings')).revision,
    },
    400,
  );
  const withPlugin = await putSettings({
    pluginSettings: { imageGeneration: { describePrompt: 'test prompt' } },
  });
  assert(
    (withPlugin.pluginSettings.imageGeneration as { describePrompt?: string }).describePrompt ===
      'test prompt',
    'plugin settings round-trip through PUT /api/settings',
  );
  await expectStatus(
    'PUT',
    '/api/settings',
    { pluginSettings: 'nope', expectedRevision: withPlugin.revision },
    400,
  );

  console.log('== core chat loop with streaming ==');
  const conv = await req<{ id: number }>('POST', '/api/conversations', { characterId: null });
  const ws = new WsClient();
  await ws.open();
  ws.sendRaw(null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const settingsAfterBadWs = await req<Settings>('GET', '/api/settings');
  assert(
    typeof settingsAfterBadWs.revision === 'number',
    'malformed WebSocket command does not crash the server',
  );
  ws.sub(conv.id);
  await ws.waitFor((e) => e.t === 'tree', 'initial tree push');
  const peer = new WsClient();
  await peer.open();
  peer.sub(conv.id);
  await peer.waitFor(
    (e) => e.t === 'tree' && e.conversationId === conv.id,
    'second frontend initial tree',
  );

  console.log('== duplicate and export include unflushed live generation buffers ==');
  const liveWs = new WsClient();
  await liveWs.open();
  const exportLiveConv = await req<{ id: number }>('POST', '/api/conversations', {});
  liveWs.sub(exportLiveConv.id);
  await liveWs.waitFor(
    (e) => e.t === 'tree' && e.conversationId === exportLiveConv.id,
    'live-export conversation tree',
  );
  const exportLiveSend = await sendMessage(exportLiveConv.id, 'export during first flush window');
  const exportDelta = await liveWs.waitFor(
    (e) => e.t === 'delta' && e.mid === exportLiveSend.assistantMessageId && !!e.d,
    'first visible live-export content delta',
  );
  if (exportDelta.t !== 'delta' || !exportDelta.d) throw new Error('unreachable');
  const exportResponse = await fetch(`${BASE}/api/conversations/${exportLiveConv.id}/export`);
  if (!exportResponse.ok) throw new Error(`live export failed: ${await exportResponse.text()}`);
  const liveExport = (await exportResponse.json()) as { messages: Message[] };
  assert(
    liveExport.messages
      .find((message) => message.id === exportLiveSend.assistantMessageId)
      ?.content.includes(exportDelta.d) === true,
    'conversation export includes content visible before the periodic DB flush',
  );
  await stopGeneration(exportLiveConv.id, exportLiveSend.assistantMessageId);

  const duplicateLiveConv = await req<{ id: number }>('POST', '/api/conversations', {});
  liveWs.sub(duplicateLiveConv.id);
  await liveWs.waitFor(
    (e) => e.t === 'tree' && e.conversationId === duplicateLiveConv.id,
    'live-duplicate source tree',
  );
  const duplicateLiveSend = await sendMessage(
    duplicateLiveConv.id,
    'duplicate during first flush window',
  );
  const duplicateDelta = await liveWs.waitFor(
    (e) => e.t === 'delta' && e.mid === duplicateLiveSend.assistantMessageId && !!e.d,
    'first visible live-duplicate content delta',
  );
  if (duplicateDelta.t !== 'delta' || !duplicateDelta.d) throw new Error('unreachable');
  const liveCopy = await req<{ id: number }>(
    'POST',
    `/api/conversations/${duplicateLiveConv.id}/duplicate`,
  );
  const liveCopyAssistant = (await tree(liveCopy.id)).messages.find(
    (message) => message.role === 'assistant',
  );
  assert(
    liveCopyAssistant?.status === 'stopped' && liveCopyAssistant.content.includes(duplicateDelta.d),
    'conversation duplicate preserves visible content before the periodic DB flush',
  );
  await stopGeneration(duplicateLiveConv.id, duplicateLiveSend.assistantMessageId);
  liveWs.close();

  const firstSend = await sendMessage(conv.id, '  Hello world  ');
  const [firstFinal, peerFinal] = await Promise.all([
    ws.waitFor(
      (e) => e.t === 'final' && e.message.id === firstSend.assistantMessageId,
      'first generation finished',
    ),
    peer.waitFor(
      (e) => e.t === 'final' && e.message.id === firstSend.assistantMessageId,
      'second frontend sees first generation finish',
    ),
  ]);
  assert(
    firstFinal.t === 'final' &&
      peerFinal.t === 'final' &&
      firstFinal.message.content === peerFinal.message.content &&
      peer.events.some(
        (event) => event.t === 'delta' && event.mid === firstSend.assistantMessageId,
      ),
    'two frontends receive the same streamed response',
  );
  peer.close();
  const deltas = ws.events.filter((e) => e.t === 'delta' && e.mid === firstSend.assistantMessageId);
  assert(deltas.length > 10, `stream relayed incrementally (${deltas.length} delta frames)`);
  assert(
    ws.events.some(
      (e) => e.t === 'delta' && e.mid === firstSend.assistantMessageId && 'r' in e && e.r,
    ),
    'reasoning deltas relayed',
  );

  let snap = await tree(conv.id);
  let path = pathOf(snap);
  assert(path.length === 2, 'path is [user, assistant]');
  assert(
    path[1]!.status === 'done' && path[1]!.content.includes('Hello world'),
    'assistant reply persisted',
  );
  assert(
    path[1]!.content.includes('You are Assistant speaking with Aiki.'),
    'macros substituted in system prompt',
  );
  assert(path[1]!.reasoning != null && path[1]!.reasoning.length > 0, 'reasoning persisted');
  const userMsg1 = path[0]!;
  const assistant1 = path[1]!;
  assert(userMsg1.content === 'Hello world', 'message boundaries are trimmed on write');

  console.log('== same-leaf stale mutations are revision-guarded ==');
  const beforeSameLeafEdit = await tree(conv.id);
  await req('PATCH', `/api/messages/${userMsg1.id}`, {
    content: userMsg1.content,
    expectedActiveLeafId: beforeSameLeafEdit.activeLeafId,
    expectedMutationRevision: beforeSameLeafEdit.mutationRevision,
  });
  await expectStatus(
    'PATCH',
    `/api/messages/${userMsg1.id}`,
    {
      content: 'stale same-leaf overwrite',
      expectedActiveLeafId: beforeSameLeafEdit.activeLeafId,
      expectedMutationRevision: beforeSameLeafEdit.mutationRevision,
    },
    409,
  );
  const afterSameLeafConflict = await tree(conv.id);
  assert(
    afterSameLeafConflict.mutationRevision > beforeSameLeafEdit.mutationRevision &&
      afterSameLeafConflict.messages.find((message) => message.id === userMsg1.id)?.content ===
        userMsg1.content,
    'same active leaf cannot conceal a stale content revision',
  );
  const staleDeleteConv = await req<{ id: number }>('POST', '/api/conversations', {});
  const beforeDeleteMetadataChange = await tree(staleDeleteConv.id);
  await patchConversation(staleDeleteConv.id, { title: 'changed before stale delete' });
  await expectStatus(
    'DELETE',
    `/api/conversations/${staleDeleteConv.id}?${branchQuery(beforeDeleteMetadataChange)}`,
    undefined,
    409,
  );
  const currentDeleteState = await tree(staleDeleteConv.id);
  await req(
    'DELETE',
    `/api/conversations/${staleDeleteConv.id}?${branchQuery(currentDeleteState)}`,
  );
  assert(true, 'conversation delete requires the current mutation revision');
  await expectStatus(
    'POST',
    `/api/conversations/${conv.id}/messages`,
    await branchBodyAt(conv.id, null, { content: 'stale send' }),
    409,
  );
  await expectStatus(
    'PATCH',
    `/api/conversations/${conv.id}`,
    await branchBody(conv.id, { personaId: 999999999 }),
    400,
  );

  // Verify streamed content equals persisted content.
  const streamed = deltas.map((e) => (e.t === 'delta' ? (e.d ?? '') : '')).join('');
  assert(streamed === assistant1.content, 'concatenated deltas equal persisted content');

  console.log('== advancing past the last swipe creates a sibling ==');
  await req('POST', `/api/messages/${assistant1.id}/advance`, await branchBody(conv.id));
  await ws.waitFor((e) => e.t === 'final' && e.message.id !== assistant1.id, 'new swipe finished');

  // Asserted here (not after the first reply) because the auto-title one-shot
  // fires after that reply and overwrites the mock's last-completion record.
  const effortSeen = (await (await fetch(`${MOCK_CONTROL}/control/last-completion`)).json()) as {
    completion: { reasoningEffort: string | null } | null;
  };
  assert(
    effortSeen.completion?.reasoningEffort === 'high',
    'endpoint reasoningEffort reaches upstream as reasoning_effort',
  );
  snap = await tree(conv.id);
  const assistantSiblings = snap.messages.filter((m) => m.parentId === userMsg1.id);
  assert(assistantSiblings.length === 2, 'two assistant siblings after advancing');
  const assistant2 = assistantSiblings.find((m) => m.id !== assistant1.id)!;
  assert(snap.activeLeafId === assistant2.id, 'new sibling is active');

  console.log('== extend branch on first sibling, then deep-restore ==');
  await activate(conv.id, assistant1.id);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === assistant1.id, 'branch switch back to first reply');

  await sendMessage(conv.id, 'Second question');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.parentId != null && e.message.parentId !== userMsg1.id,
    'reply to second question',
  );
  snap = await tree(conv.id);
  path = pathOf(snap);
  assert(path.length === 4, 'path deepened to 4 under first sibling');
  const deepLeafId = snap.activeLeafId!;

  // Switch to sibling 2 (short branch), then back to sibling 1: the deep chain must be restored.
  await activate(conv.id, assistant2.id);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === assistant2.id, 'switched to short branch');
  await activate(conv.id, assistant1.id);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === deepLeafId, 'deep chain restored after switching back');

  console.log('== edit user message as branch (root fork), then restore ==');
  await req(
    'POST',
    `/api/messages/${userMsg1.id}/edit-branch`,
    await branchBody(conv.id, { content: 'Edited hello' }),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.content.includes('Edited hello'),
    'generation for edited branch',
  );
  snap = await tree(conv.id);
  path = pathOf(snap);
  assert(
    path.length === 2 && path[0]!.content === 'Edited hello',
    'edited branch active with fresh reply',
  );
  const roots = snap.messages.filter((m) => m.parentId === null);
  assert(roots.length === 2, 'two root siblings after root edit');

  await activate(conv.id, userMsg1.id);
  snap = await tree(conv.id);
  assert(snap.activeLeafId === deepLeafId, 'full original chain restored across the root fork');

  console.log('== in-place edit ==');
  await expectStatus(
    'PATCH',
    `/api/messages/${assistant1.id}`,
    await branchBody(conv.id, { content: '   ' }),
    400,
  );
  await req(
    'PATCH',
    `/api/messages/${assistant1.id}`,
    await branchBody(conv.id, { content: 'Rewritten reply.' }),
  );
  snap = await tree(conv.id);
  assert(
    snap.messages.find((m) => m.id === assistant1.id)!.content === 'Rewritten reply.',
    'in-place edit persisted',
  );
  const editPatch = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.messages.some((m) => m.id === assistant1.id && m.content === 'Rewritten reply.'),
    'patch frame for the in-place edit',
  );
  if (editPatch.t !== 'treePatch') throw new Error('unreachable');
  assert(
    editPatch.messages.length === 1 && editPatch.nodes.length === snap.messages.length,
    'tree patches carry full structure but bodies only for changed messages',
  );

  console.log('== regenerate with instruction includes the original reply ==');
  const steered = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${assistant1.id}/regenerate`,
    await branchBody(conv.id, { instruction: 'Make this much shorter.' }),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === steered.assistantMessageId,
    'steered regeneration finished',
  );
  const steeredSeen = (await (await fetch(`${MOCK_CONTROL}/control/last-completion`)).json()) as {
    completion: {
      assistantMessages: string[];
      messages: { role: string; content: string }[];
      lastMessageRole: string | null;
      lastMessageContent: string | null;
    } | null;
  };
  assert(
    steeredSeen.completion?.assistantMessages.includes('Rewritten reply.') === true,
    'steered regeneration sends the original assistant reply upstream',
  );
  assert(
    steeredSeen.completion?.lastMessageRole === 'user' &&
      steeredSeen.completion.lastMessageContent?.includes('Make this much shorter.') === true,
    'one-off steer instruction follows the original reply as a user message',
  );
  const steeredAlternating = steeredSeen.completion!.messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  );
  assert(
    steeredAlternating.every(
      (message, index) =>
        message.content.trim().length > 0 &&
        (index === 0 || message.role !== steeredAlternating[index - 1]!.role),
    ),
    'steered text request keeps user/assistant messages non-empty and alternating',
  );
  snap = await tree(conv.id);
  const steeredMessage = snap.messages.find(
    (message) => message.id === steered.assistantMessageId,
  )!;
  assert(
    steeredMessage.parentId === assistant1.parentId,
    'steered result is stored as a sibling, not as a child of the original reply',
  );

  console.log('== swipe past an in-flight generation ==');
  const sendResult = await sendMessage(conv.id, 'Long answer please');
  await ws.waitFor(
    (e) => e.t === 'delta' && e.mid === sendResult.assistantMessageId,
    'stream started',
  );
  await expectStatus(
    'DELETE',
    await branchPath(
      conv.id,
      `/api/messages/${sendResult.userMessageId}`,
      sendResult.assistantMessageId,
    ),
    undefined,
    409,
  );
  await expectStatus(
    'PATCH',
    `/api/messages/${sendResult.userMessageId}`,
    await branchBodyAt(conv.id, sendResult.assistantMessageId, {
      content: 'changed while streaming',
    }),
    409,
  );
  const nextSwipe = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${sendResult.assistantMessageId}/advance`,
    await branchBodyAt(conv.id, sendResult.assistantMessageId),
  );
  if (nextSwipe.assistantMessageId == null) throw new Error('expected a generated swipe');
  const replaced = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === sendResult.assistantMessageId,
    'swiped-past generation stopped',
  );
  assert(
    replaced.t === 'final' && replaced.message.status === 'stopped',
    'swiping further stops and preserves the partial reply',
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === nextSwipe.assistantMessageId,
    'next swipe generation finished',
  );

  console.log('== stop mid-generation ==');
  const stoppedSend = await sendMessage(conv.id, 'Stop this answer');
  await ws.waitFor(
    (e) => e.t === 'delta' && e.mid === stoppedSend.assistantMessageId,
    'stoppable stream started',
  );
  await stopGeneration(conv.id, stoppedSend.assistantMessageId);
  const stopped = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === stoppedSend.assistantMessageId,
    'stopped finalization',
  );
  assert(stopped.t === 'final' && stopped.message.status === 'stopped', 'message marked stopped');

  console.log('== stale generation Stop cannot hit a resumed epoch ==');
  if (stopped.t !== 'final' || stopped.message.generationToken == null) {
    throw new Error('stopped generation has no token');
  }
  const firstGenerationToken = stopped.message.generationToken;
  await req(
    'POST',
    `/api/messages/${stoppedSend.assistantMessageId}/continue`,
    await branchBody(conv.id),
  );
  const resumedPatch = await ws.waitFor(
    (event) =>
      event.t === 'treePatch' &&
      event.nodes.some(
        (node) =>
          node.id === stoppedSend.assistantMessageId &&
          node.status === 'streaming' &&
          node.generationToken != null &&
          node.generationToken !== firstGenerationToken,
      ),
    'resumed generation token',
  );
  if (resumedPatch.t !== 'treePatch') throw new Error('unreachable');
  const resumedGenerationToken = resumedPatch.nodes.find(
    (node) => node.id === stoppedSend.assistantMessageId,
  )!.generationToken!;
  await expectStatus(
    'POST',
    `/api/generations/${stoppedSend.assistantMessageId}/stop`,
    { expectedGenerationToken: firstGenerationToken },
    409,
  );
  await req('POST', `/api/generations/${stoppedSend.assistantMessageId}/stop`, {
    expectedGenerationToken: resumedGenerationToken,
  });
  const resumedStopped = await ws.waitFor(
    (event) =>
      event.t === 'final' &&
      event.message.id === stoppedSend.assistantMessageId &&
      event.message.generationToken === resumedGenerationToken,
    'current resumed generation stops normally',
  );
  assert(
    resumedStopped.t === 'final' && resumedStopped.message.status === 'stopped',
    'only the matching generation token can stop a resumed message',
  );

  console.log('== mid-stream subscriber gets snapshot + remaining deltas ==');
  const send2 = await sendMessage(conv.id, 'Another one');
  await ws.waitFor(
    (e) => e.t === 'delta' && e.mid === send2.assistantMessageId,
    'second stream started',
  );
  const ws2 = new WsClient();
  await ws2.open();
  ws2.sub(conv.id);
  const treeEv = await ws2.waitFor((e) => e.t === 'tree', 'late-joiner tree snapshot');
  const finalEv = await ws2.waitFor(
    (e) => e.t === 'final' && e.message.id === send2.assistantMessageId,
    'late-joiner sees final',
  );
  if (treeEv.t !== 'tree' || finalEv.t !== 'final') throw new Error('unreachable');
  const snapshotContent = treeEv.messages.find((m) => m.id === send2.assistantMessageId)!.content;
  const lateDeltas = ws2.events
    .filter((e) => e.t === 'delta' && e.mid === send2.assistantMessageId)
    .map((e) => (e.t === 'delta' ? (e.d ?? '') : ''))
    .join('');
  assert(
    snapshotContent + lateDeltas === finalEv.message.content,
    'late-joiner snapshot + deltas reconstruct the full message',
  );
  ws2.close();

  console.log('== delete splices the message out of the chain ==');
  snap = await tree(conv.id);
  const before = snap.messages.length;
  await req('DELETE', `/api/messages/${send2.assistantMessageId}?${branchQuery(snap)}`);
  snap = await tree(conv.id);
  assert(snap.messages.length === before - 1, 'message deleted');
  assert(snap.activeLeafId !== send2.assistantMessageId, 'active leaf repaired');
  // Mid-path delete: the messages below reparent to the deleted one's parent.
  await req(
    'DELETE',
    `/api/messages/${stoppedSend.assistantMessageId}?${branchQuery(snap, send2.userMessageId)}`,
  );
  snap = await tree(conv.id);
  assert(snap.messages.length === before - 2, 'only the deleted message is removed');
  assert(
    snap.messages.find((m) => m.id === send2.userMessageId)?.parentId ===
      stoppedSend.userMessageId && snap.activeLeafId === send2.userMessageId,
    'descendants reparent upward and the active leaf survives',
  );
  // Deleting a block with swipes: the sibling alternatives (and their
  // subtrees) die too; only the visible chain below the block survives.
  const blockSend = await sendMessage(conv.id, 'block root');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === blockSend.assistantMessageId,
    'block reply finished',
  );
  const blockSwipe = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${blockSend.assistantMessageId}/advance`,
    await branchBodyAt(conv.id, blockSend.assistantMessageId),
  );
  const swipeId = blockSwipe.assistantMessageId!;
  await ws.waitFor((e) => e.t === 'final' && e.message.id === swipeId, 'block swipe finished');
  const below = await sendMessage(conv.id, 'below the block');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === below.assistantMessageId,
    'below-block reply finished',
  );
  await req(
    'DELETE',
    await branchPath(conv.id, `/api/messages/${swipeId}`, below.assistantMessageId),
  );
  snap = await tree(conv.id);
  assert(
    !snap.messages.some((m) => m.id === swipeId || m.id === blockSend.assistantMessageId),
    'deleting a block removes its sibling swipes too',
  );
  assert(
    snap.messages.find((m) => m.id === below.userMessageId)?.parentId === blockSend.userMessageId &&
      snap.activeLeafId === below.assistantMessageId,
    'the visible chain below the block survives, reparented',
  );
  // Regression: the treePatch after a splice must carry the survivors' new
  // parentId as a structural update (no full bodies are resent for them).
  const splicePatch = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === conv.id &&
      e.nodes.some((n) => n.id === below.userMessageId && n.parentId === blockSend.userMessageId) &&
      !e.nodes.some((n) => n.id === swipeId),
    'splice reparenting travels over the WS patch',
  );
  assert(splicePatch.t === 'treePatch', 'splice patch received');

  console.log('== delete one swipe keeps its sibling branch ==');
  const swipeBase = await sendMessage(conv.id, 'swipe deletion root');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === swipeBase.assistantMessageId,
    'swipe-deletion first reply finished',
  );
  const keptDescendant = await sendMessage(conv.id, 'keep this branch');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === keptDescendant.assistantMessageId,
    'kept swipe descendant finished',
  );
  const doomedSwipe = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${swipeBase.assistantMessageId}/advance`,
    await branchBody(conv.id),
  );
  if (doomedSwipe.assistantMessageId == null) throw new Error('expected a sibling swipe');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === doomedSwipe.assistantMessageId,
    'doomed sibling swipe finished',
  );
  const doomedDescendant = await sendMessage(conv.id, 'delete this branch');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === doomedDescendant.assistantMessageId,
    'doomed swipe descendant finished',
  );
  const swipeDelete = await req<{ activeLeafId: number | null }>(
    'DELETE',
    await branchPath(
      conv.id,
      `/api/messages/${doomedSwipe.assistantMessageId}/swipe`,
      doomedDescendant.assistantMessageId,
    ),
  );
  snap = await tree(conv.id);
  assert(
    !snap.messages.some(
      (message) =>
        message.id === doomedSwipe.assistantMessageId ||
        message.id === doomedDescendant.userMessageId ||
        message.id === doomedDescendant.assistantMessageId,
    ),
    'delete swipe removes the selected alternative and its subtree',
  );
  assert(
    snap.messages.some((message) => message.id === swipeBase.assistantMessageId) &&
      snap.messages.some((message) => message.id === keptDescendant.userMessageId) &&
      snap.messages.some((message) => message.id === keptDescendant.assistantMessageId) &&
      swipeDelete.activeLeafId === keptDescendant.assistantMessageId &&
      snap.activeLeafId === keptDescendant.assistantMessageId,
    'delete swipe preserves and activates the remaining sibling branch',
  );

  console.log('== message move and duplicate ==');
  const mv = await sendMessage(conv.id, 'move me');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === mv.assistantMessageId,
    'move-me reply finished',
  );
  const mvParent = (await tree(conv.id)).messages.find((m) => m.id === mv.userMessageId)!.parentId;
  await req(
    'POST',
    `/api/messages/${mv.assistantMessageId}/move`,
    await branchBodyAt(conv.id, mv.assistantMessageId, { direction: 'up' }),
  );
  snap = await tree(conv.id);
  assert(
    snap.messages.find((m) => m.id === mv.assistantMessageId)?.parentId === mvParent &&
      snap.messages.find((m) => m.id === mv.userMessageId)?.parentId === mv.assistantMessageId &&
      snap.activeLeafId === mv.userMessageId,
    'move up rotates the block above its parent',
  );
  const movedCopy = await req<{ id: number }>('POST', `/api/conversations/${conv.id}/duplicate`);
  assert(
    JSON.stringify(treeLinkShape(await tree(movedCopy.id))) === JSON.stringify(treeLinkShape(snap)),
    'conversation duplicate preserves links when an older row has a newer parent after a move',
  );
  await req(
    'POST',
    `/api/messages/${mv.userMessageId}/move`,
    await branchBodyAt(conv.id, mv.userMessageId, { direction: 'up' }),
  );
  snap = await tree(conv.id);
  assert(
    snap.messages.find((m) => m.id === mv.userMessageId)?.parentId === mvParent &&
      snap.messages.find((m) => m.id === mv.assistantMessageId)?.parentId === mv.userMessageId &&
      snap.activeLeafId === mv.assistantMessageId,
    'moving back restores the original order',
  );
  const middleDup = await req<{ messageId: number; activeLeafId: number }>(
    'POST',
    `/api/messages/${mv.userMessageId}/duplicate`,
    await branchBodyAt(conv.id, mv.assistantMessageId),
  );
  snap = await tree(conv.id);
  const middleDupMsg = snap.messages.find((message) => message.id === middleDup.messageId)!;
  assert(
    middleDupMsg.parentId === mv.userMessageId &&
      middleDupMsg.activeChildId === mv.assistantMessageId &&
      snap.messages.find((message) => message.id === mv.assistantMessageId)?.parentId ===
        middleDup.messageId &&
      snap.activeLeafId === mv.assistantMessageId,
    'duplicating a middle message inserts the copy without losing its active continuation',
  );
  await req(
    'DELETE',
    await branchPath(conv.id, `/api/messages/${middleDup.messageId}`, mv.assistantMessageId),
  );
  snap = await tree(conv.id);
  assert(
    snap.messages.find((message) => message.id === mv.assistantMessageId)?.parentId ===
      mv.userMessageId && snap.activeLeafId === mv.assistantMessageId,
    'deleting the inserted middle copy restores the original chain',
  );
  const dup = await req<{ messageId: number; activeLeafId: number }>(
    'POST',
    `/api/messages/${mv.assistantMessageId}/duplicate`,
    await branchBodyAt(conv.id, mv.assistantMessageId),
  );
  snap = await tree(conv.id);
  const dupMsg = snap.messages.find((m) => m.id === dup.messageId);
  assert(
    dupMsg?.parentId === mv.assistantMessageId &&
      dupMsg.content === snap.messages.find((m) => m.id === mv.assistantMessageId)!.content &&
      snap.messages.find((m) => m.id === mv.assistantMessageId)?.activeChildId === dup.messageId &&
      snap.activeLeafId === dup.messageId,
    'duplicating the leaf inserts its copy directly below the source',
  );
  const sourceById = new Map(snap.messages.map((message) => [message.id, message]));
  const sourceBranchPath: Message[] = [];
  for (let id: number | null = mv.assistantMessageId; id != null;) {
    const message: Message = sourceById.get(id)!;
    sourceBranchPath.push(message);
    id = message.parentId;
  }
  sourceBranchPath.reverse();
  await patchConversation(conv.id, { scenarioOverride: 'A scenario kept by branches' });
  const sourceConversation = (await req<Conversation[]>('GET', '/api/conversations')).find(
    (conversation) => conversation.id === conv.id,
  )!;
  const branchedConversation = await req<Conversation>(
    'POST',
    `/api/messages/${mv.assistantMessageId}/branch-conversation`,
  );
  const branchedSnap = await tree(branchedConversation.id);
  const branchedPath = pathOf(branchedSnap);
  assert(
    branchedSnap.messages.length === sourceBranchPath.length &&
      branchedPath.length === sourceBranchPath.length &&
      branchedPath.every(
        (message, index) =>
          message.content === sourceBranchPath[index]!.content &&
          message.role === sourceBranchPath[index]!.role &&
          message.reasoning === sourceBranchPath[index]!.reasoning &&
          message.name === sourceBranchPath[index]!.name &&
          message.parentId === (index === 0 ? null : branchedPath[index - 1]!.id) &&
          message.activeChildId ===
            (index === branchedPath.length - 1 ? null : branchedPath[index + 1]!.id),
      ),
    'branch to new conversation copies only the selected message ancestry as one linear path',
  );
  assert(
    branchedConversation.characterId === sourceConversation.characterId &&
      branchedConversation.personaId === sourceConversation.personaId &&
      branchedConversation.endpointId === sourceConversation.endpointId &&
      branchedConversation.speakerName === sourceConversation.speakerName &&
      branchedConversation.scenarioOverride === sourceConversation.scenarioOverride &&
      branchedConversation.title.endsWith(' (branch)'),
    'branched conversation preserves source configuration and gets a branch title',
  );
  await expectStatus(
    'POST',
    `/api/messages/${dup.messageId}/move`,
    await branchBodyAt(conv.id, dup.messageId, { direction: 'down' }),
    400,
  );

  console.log('== contiguous message-range move and delete ==');
  const rangeConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(rangeConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === rangeConv.id,
    'message-range conversation tree',
  );
  const rangeFirst = await sendMessage(rangeConv.id, 'range first');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === rangeFirst.assistantMessageId,
    'message-range first reply',
  );
  const rangeSecond = await sendMessage(rangeConv.id, 'range second');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === rangeSecond.assistantMessageId,
    'message-range second reply',
  );
  await req(
    'POST',
    '/api/message-ranges/move',
    await branchBody(rangeConv.id, {
      messageIds: [
        rangeFirst.assistantMessageId,
        rangeSecond.userMessageId,
        rangeSecond.assistantMessageId,
      ],
      direction: 'up',
      steps: 1,
    }),
  );
  let rangeSnap = await tree(rangeConv.id);
  assert(
    pathOf(rangeSnap)
      .map((message) => message.id)
      .join(',') ===
      [
        rangeFirst.assistantMessageId,
        rangeSecond.userMessageId,
        rangeSecond.assistantMessageId,
        rangeFirst.userMessageId,
      ].join(','),
    'moving a three-message selected range up keeps the full range together',
  );
  await req(
    'POST',
    '/api/message-ranges/move',
    await branchBody(rangeConv.id, {
      messageIds: [
        rangeFirst.assistantMessageId,
        rangeSecond.userMessageId,
        rangeSecond.assistantMessageId,
      ],
      direction: 'down',
      steps: 1,
    }),
  );
  rangeSnap = await tree(rangeConv.id);
  assert(
    pathOf(rangeSnap)
      .map((message) => message.id)
      .join(',') ===
      [
        rangeFirst.userMessageId,
        rangeFirst.assistantMessageId,
        rangeSecond.userMessageId,
        rangeSecond.assistantMessageId,
      ].join(','),
    'moving that selected range down restores the original order',
  );
  await expectStatus(
    'POST',
    '/api/message-ranges/move',
    await branchBody(rangeConv.id, {
      messageIds: [rangeFirst.userMessageId, rangeSecond.userMessageId],
      direction: 'up',
      steps: 1,
    }),
    400,
  );
  await expectStatus(
    'POST',
    '/api/message-ranges/move',
    await branchBody(rangeConv.id, {
      messageIds: [rangeSecond.userMessageId, rangeSecond.assistantMessageId],
      direction: 'up',
      steps: 3,
    }),
    400,
  );
  await req(
    'POST',
    '/api/message-ranges/move',
    await branchBody(rangeConv.id, {
      messageIds: [rangeSecond.userMessageId, rangeSecond.assistantMessageId],
      direction: 'up',
      steps: 2,
    }),
  );
  rangeSnap = await tree(rangeConv.id);
  assert(
    pathOf(rangeSnap)
      .map((message) => message.id)
      .join(',') ===
      [
        rangeSecond.userMessageId,
        rangeSecond.assistantMessageId,
        rangeFirst.userMessageId,
        rangeFirst.assistantMessageId,
      ].join(','),
    'a contiguous message range moves several slots as one block',
  );
  await req(
    'POST',
    '/api/message-ranges/move',
    await branchBody(rangeConv.id, {
      messageIds: [rangeSecond.userMessageId, rangeSecond.assistantMessageId],
      direction: 'down',
      steps: 2,
    }),
  );
  rangeSnap = await tree(rangeConv.id);
  assert(
    pathOf(rangeSnap)
      .map((message) => message.id)
      .join(',') ===
      [
        rangeFirst.userMessageId,
        rangeFirst.assistantMessageId,
        rangeSecond.userMessageId,
        rangeSecond.assistantMessageId,
      ].join(','),
    'a contiguous message range also moves several slots downward as one block',
  );
  await req(
    'POST',
    '/api/message-ranges/move',
    await branchBody(rangeConv.id, {
      messageIds: [rangeSecond.userMessageId, rangeSecond.assistantMessageId],
      direction: 'up',
      steps: 2,
    }),
  );
  await req(
    'POST',
    '/api/message-ranges/delete',
    await branchBody(rangeConv.id, {
      messageIds: [rangeSecond.userMessageId, rangeSecond.assistantMessageId],
    }),
  );
  rangeSnap = await tree(rangeConv.id);
  assert(
    pathOf(rangeSnap)
      .map((message) => message.id)
      .join(',') === [rangeFirst.userMessageId, rangeFirst.assistantMessageId].join(',') &&
      !rangeSnap.messages.some(
        (message) =>
          message.id === rangeSecond.userMessageId || message.id === rangeSecond.assistantMessageId,
      ),
    'deleting a contiguous range preserves and reconnects its continuation',
  );

  console.log('== delete-tail removes sibling swipes and descendant trees ==');
  const tailConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(tailConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === tailConv.id,
    'delete-tail conversation tree',
  );
  const tailFirst = await sendMessage(tailConv.id, 'tail root');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === tailFirst.assistantMessageId,
    'delete-tail first reply',
  );
  const oldBranch = await sendMessage(tailConv.id, 'old branch descendant');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === oldBranch.assistantMessageId,
    'delete-tail old descendant reply',
  );
  const sibling = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${tailFirst.assistantMessageId}/advance`,
    await branchBody(tailConv.id),
  );
  if (sibling.assistantMessageId == null) throw new Error('expected a fresh sibling swipe');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === sibling.assistantMessageId,
    'delete-tail sibling reply',
  );
  const newBranch = await sendMessage(tailConv.id, 'new branch descendant');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === newBranch.assistantMessageId,
    'delete-tail new descendant reply',
  );
  const tailBefore = await tree(tailConv.id);
  await expectStatus(
    'POST',
    `/api/conversations/${tailConv.id}/delete-tail`,
    await branchBodyAt(tailConv.id, tailFirst.assistantMessageId, { count: 3 }),
    409,
  );
  const tailDeleted = await req<{ activeLeafId: number | null; deletedSiblingRoots: number }>(
    'POST',
    `/api/conversations/${tailConv.id}/delete-tail`,
    {
      count: 3,
      expectedActiveLeafId: tailBefore.activeLeafId,
      expectedMutationRevision: tailBefore.mutationRevision,
    },
  );
  const tailAfter = await tree(tailConv.id);
  assert(
    tailDeleted.deletedSiblingRoots === 2 &&
      tailAfter.activeLeafId === tailFirst.userMessageId &&
      tailAfter.messages.length === 1 &&
      tailAfter.messages[0]!.id === tailFirst.userMessageId,
    'tail deletion removes all swipes at the cutoff and both descendant trees',
  );
  await req('POST', `/api/conversations/${tailConv.id}/delete-tail`, {
    count: 99,
    expectedActiveLeafId: tailAfter.activeLeafId,
    expectedMutationRevision: tailAfter.mutationRevision,
  });
  assert((await tree(tailConv.id)).messages.length === 0, 'large tail count clears the whole tree');

  console.log('== one-level character folders ==');
  const characterFolder = await req<CharacterFolder>('POST', '/api/character-folders', {
    name: '  Adventurers  ',
  });
  assert(characterFolder.name === 'Adventurers', 'character folder names are trimmed');
  await expectStatus('POST', '/api/character-folders', { name: 'adventurers' }, 409);
  await expectStatus('POST', '/api/characters', { name: 'Lost', folderId: 999999999 }, 400);
  const folderCharacter = await req<Character>('POST', '/api/characters', {
    name: 'Folder Hero',
    folderId: characterFolder.id,
  });
  assert(
    folderCharacter.folderId === characterFolder.id,
    'a character can be assigned to a folder',
  );
  const renamedFolder = await req<CharacterFolder>(
    'PATCH',
    `/api/character-folders/${characterFolder.id}`,
    { name: 'Heroes' },
  );
  assert(renamedFolder.name === 'Heroes', 'a character folder can be renamed');
  await req('DELETE', `/api/character-folders/${characterFolder.id}`);
  const ungroupedCharacter = (await req<Character[]>('GET', '/api/characters')).find(
    (candidate) => candidate.id === folderCharacter.id,
  );
  assert(
    ungroupedCharacter?.folderId === null,
    'deleting a folder moves its characters back to the root',
  );
  await req('DELETE', `/api/characters/${folderCharacter.id}`);

  console.log('== character card import + greeting seeding ==');
  const bombRes = await fetch(`${BASE}/api/characters/import-card`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(makeCompressedMetadataBombPng()),
  });
  assert(bombRes.status === 400, 'oversized compressed PNG metadata is rejected safely');
  const settingsAfterBomb = await req<Settings>('GET', '/api/settings');
  assert(
    typeof settingsAfterBomb.revision === 'number',
    'server remains responsive after compressed metadata rejection',
  );
  for (const malformedCard of [
    { spec: 'chara_card_v2', data: { name: {} } },
    { spec: 'chara_card_v2', data: { name: 'Bad fields', scenario: 42 } },
  ]) {
    const malformedRes = await fetch(`${BASE}/api/characters/import-card`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(makeCardPng(malformedCard)),
    });
    assert(malformedRes.status === 400, 'malformed character-card field types return 400');
  }
  const cardRes = await fetch(`${BASE}/api/characters/import-card`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(makeCardPng()),
  });
  if (!cardRes.ok) throw new Error(`card import failed: ${await cardRes.text()}`);
  const character = (await cardRes.json()) as {
    id: number;
    name: string;
    personality: string;
    scenario: string;
    avatar: string | null;
  };
  assert(character.name === 'Card Imported Hero', 'card name imported');
  assert(
    character.personality.includes('brave') && character.personality.includes('Fearless'),
    'description + personality merged',
  );
  assert(character.avatar != null, 'card PNG stored as avatar');
  const avatarRes = await fetch(`${BASE}${character.avatar}`);
  assert(avatarRes.ok, 'avatar served');

  const charConv = await req<{ id: number; title: string }>('POST', '/api/conversations', {
    characterId: character.id,
  });
  const charSnap = await tree(charConv.id);
  await expectStatus(
    'PATCH',
    `/api/conversations/${charConv.id}`,
    {
      characterId: null,
      expectedActiveLeafId: charSnap.activeLeafId,
      expectedMutationRevision: charSnap.mutationRevision,
    },
    400,
  );
  const greeting = pathOf(charSnap)[0]!;
  assert(
    greeting.role === 'assistant' &&
      greeting.content === 'Greetings, Aiki! I am Card Imported Hero.',
    'first message seeded with macros substituted',
  );
  assert(charConv.title === 'Card Imported Hero', 'conversation titled after character');
  const greetingRoots = charSnap.messages.filter((m) => m.parentId === null);
  assert(greetingRoots.length === 2, 'alternate greeting seeded as root sibling');
  assert(
    greetingRoots.some((m) => m.content === 'Alternate hello, Aiki!'),
    'alternate greeting macros substituted',
  );

  console.log('== character card export round-trip ==');
  const exportRes = await fetch(`${BASE}/api/characters/${character.id}/card`);
  assert(
    exportRes.ok && exportRes.headers.get('content-type') === 'image/png',
    'card export returns PNG',
  );
  const reimportRes = await fetch(`${BASE}/api/characters/import-card`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(await exportRes.arrayBuffer()),
  });
  const reimported = (await reimportRes.json()) as {
    id: number;
    name: string;
    personality: string;
  };
  assert(reimported.name === 'Card Imported Hero', 'exported card reimports with same name');
  assert(reimported.personality.includes('brave'), 'exported card keeps personality text');

  console.log('== character duplicate copies the avatar file ==');
  const characterCopy = await req<{
    id: number;
    name: string;
    personality: string;
    avatar: string | null;
  }>('POST', `/api/characters/${reimported.id}/duplicate`);
  assert(
    characterCopy.name === 'Card Imported Hero (copy)',
    'duplicate appends (copy) to the name',
  );
  assert(characterCopy.personality.includes('brave'), 'duplicate copies entity fields');
  assert(
    characterCopy.avatar != null && characterCopy.avatar.includes(`character-${characterCopy.id}.`),
    'duplicate points at its own avatar file, not the source file',
  );
  await req('DELETE', `/api/characters/${reimported.id}`);
  const copyAvatarRes = await fetch(`${BASE}${characterCopy.avatar}`);
  assert(copyAvatarRes.ok, 'copied avatar survives deleting the source character');
  await req('DELETE', `/api/characters/${characterCopy.id}`);

  await req('PATCH', `/api/characters/${character.id}`, { customPrompt: null });
  const clearedExportRes = await fetch(`${BASE}/api/characters/${character.id}/card`);
  const clearedReimportRes = await fetch(`${BASE}/api/characters/import-card`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(await clearedExportRes.arrayBuffer()),
  });
  if (!clearedReimportRes.ok) {
    throw new Error(`cleared card reimport failed: ${await clearedReimportRes.text()}`);
  }
  const clearedReimported = (await clearedReimportRes.json()) as { customPrompt: string | null };
  assert(
    clearedReimported.customPrompt === null,
    'card export preserves an explicitly cleared imported system prompt',
  );

  console.log('== avatars accept PNG only ==');
  // Magic bytes decide, not the content-type: a renamed JPEG stored as .png
  // would break PNG card export later.
  const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
  const webpBytes = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), Buffer.alloc(48)]);
  const putAvatar = (path: string, body: Uint8Array) =>
    fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    });
  const jpegCharRes = await putAvatar(`/api/characters/${character.id}/avatar`, jpegBytes);
  assert(jpegCharRes.status === 415, 'character avatar upload rejects JPEG magic bytes');
  const webpCharRes = await putAvatar(`/api/characters/${character.id}/avatar`, webpBytes);
  assert(webpCharRes.status === 415, 'character avatar upload rejects WebP magic bytes');
  const pngCharRes = await putAvatar(
    `/api/characters/${character.id}/avatar`,
    new Uint8Array(makeCardPng()),
  );
  assert(pngCharRes.ok, 'character avatar upload accepts a valid PNG');
  const pngChar = (await pngCharRes.json()) as { avatar: string | null };
  assert(pngChar.avatar?.includes('.png') === true, 'stored avatar is served as a .png file');
  assert(
    !readdirSync(join(process.env.DATA_DIR!, 'avatars')).some((name) => name.endsWith('.tmp')),
    'atomic avatar replacement leaves no temporary files behind',
  );
  const jpegPersonaRes = await putAvatar(`/api/personas/${persona.id}/avatar`, jpegBytes);
  assert(jpegPersonaRes.status === 415, 'persona avatar upload rejects JPEG magic bytes');

  console.log('== avatar generation (prompt stream + comfy render) ==');
  const AVATAR_WORKFLOW =
    '{"3":{"class_type":"KSampler","inputs":{"seed":{{seed}}}},"6":{"inputs":{"text":"{{prompt}}"}}}';
  const AVATAR_SYSTEM_TEMPLATE =
    'Write a portrait image-generation prompt for {{name}}. Reply with only the prompt.';
  const AVATAR_CONTEXT_TEMPLATE =
    'Name: {{name}}\nAvatar details: {{description}}\nScenario: {{scenario}}\nFirst message: {{firstMessage}}';
  // The client builds the request from the plugin settings — do the same.
  await putSettings({
    pluginSettings: {
      imageGeneration: {
        promptPresets: {
          avatar: {
            presets: [
              {
                name: 'Detailed',
                prompt: AVATAR_SYSTEM_TEMPLATE,
                context: AVATAR_CONTEXT_TEMPLATE,
              },
            ],
            active: 'Detailed',
          },
        },
        comfyUrl: MOCK_CONTROL,
        workflows: [{ name: 'Avatar', json: AVATAR_WORKFLOW }],
        activeWorkflow: 'Avatar',
      },
    },
  });
  const imageGenCfg = ((await req<Settings>('GET', '/api/settings')).pluginSettings
    .imageGeneration as {
    promptPresets: {
      avatar: {
        presets: { name: string; prompt: string; context: string }[];
        active: string;
      };
    };
    comfyUrl: string;
    workflows: { name: string; json: string }[];
    activeWorkflow: string;
  })!;
  const avatarPreset = imageGenCfg.promptPresets.avatar.presets.find(
    (preset) => preset.name === imageGenCfg.promptPresets.avatar.active,
  )!;
  const avatarImage = {
    workflow: imageGenCfg.workflows.find((w) => w.name === imageGenCfg.activeWorkflow)!.json,
    comfyUrl: imageGenCfg.comfyUrl,
  };
  const avatarChar = await req<{ id: number }>('POST', '/api/characters', {
    name: 'Avatar Hero',
    personality: 'a brave knight with silver hair',
    scenario: 'a mountain keep',
    firstMessage: 'Welcome to the keep. The winter wolves are close.',
  });

  /** Reads an avatar prompt SSE stream, returning the assembled text. */
  const streamAvatarPrompt = async (
    path: string,
    prompt: string,
    context: string,
  ): Promise<string> => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, context }),
    });
    assert(
      res.ok && res.headers.get('content-type')?.includes('text/event-stream') === true,
      `prompt stream at ${path} responds with SSE`,
    );
    const body = await res.text();
    let text = '';
    let sawDone = false;
    let sawError = false;
    for (const line of body.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = JSON.parse(line.slice(5)) as { d?: string; error?: string; done?: boolean };
      if (payload.error !== undefined) sawError = true;
      if (payload.d) text += payload.d;
      if (payload.done) sawDone = true;
    }
    assert(!sawError, `prompt stream at ${path} carries no error event`);
    assert(sawDone, `prompt stream at ${path} terminates with a done event`);
    return text;
  };

  // A second stream for the same entity 409s while the first is in flight.
  const firstStream = streamAvatarPrompt(
    `/api/characters/${avatarChar.id}/avatar/prompt`,
    avatarPreset.prompt,
    avatarPreset.context,
  );
  // Let the first request reach the server and claim the per-entity slot.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await expectStatus(
    'POST',
    `/api/characters/${avatarChar.id}/avatar/prompt`,
    { prompt: avatarPreset.prompt, context: avatarPreset.context },
    409,
  );
  const avatarPrompt = await firstStream;
  assert(avatarPrompt.includes('Avatar Hero'), 'prompt stream relays the LLM completion text');

  // A failed prompt stream has an error and no done marker. The avatar modal
  // uses that distinction to retain the useful failure instead of rendering a
  // plausible-looking partial prompt.
  await fetch(`${MOCK_CONTROL}/control/fail-next?count=1`, { method: 'POST' });
  const failedPromptRes = await fetch(`${BASE}/api/characters/${avatarChar.id}/avatar/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: avatarPreset.prompt, context: avatarPreset.context }),
  });
  const failedPromptBody = await failedPromptRes.text();
  assert(
    failedPromptBody.includes('"error"') && !failedPromptBody.includes('"done":true'),
    'failed avatar prompt stream cannot be mistaken for a completed prompt',
  );

  // Closing the modal aborts its SSE request. The server must abort the
  // upstream completion and release the per-entity lock immediately so a new
  // modal can start rather than receiving 409 until the old model times out.
  const cancelledPrompt = new AbortController();
  const cancelledPromptRes = await fetch(`${BASE}/api/characters/${avatarChar.id}/avatar/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: avatarPreset.prompt, context: avatarPreset.context }),
    signal: cancelledPrompt.signal,
  });
  assert(cancelledPromptRes.ok, 'cancellable avatar prompt stream opens');
  cancelledPrompt.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const reopenedPrompt = await streamAvatarPrompt(
    `/api/characters/${avatarChar.id}/avatar/prompt`,
    avatarPreset.prompt,
    avatarPreset.context,
  );
  assert(reopenedPrompt.length > 0, 'aborting an avatar prompt releases its entity lock');

  // The streamed request hit the mock with macros expanded from the character.
  const { completion: avatarCompletion } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as { completion: { system: string | null; user: string | null } };
  assert(
    avatarCompletion.system ===
      'Write a portrait image-generation prompt for Avatar Hero. Reply with only the prompt.',
    'avatar system prompt expands independently without duplicating character details',
  );
  assert(
    avatarCompletion.user ===
      'Name: Avatar Hero\n' +
        'Avatar details: a brave knight with silver hair\n' +
        'Scenario: a mountain keep\n' +
        'First message: Welcome to the keep. The winter wolves are close.',
    'the model is given avatar details, scenario, and first message as context',
  );

  // Render: the (possibly edited) prompt goes in, image bytes come out.
  const renderRes = await fetch(`${BASE}/api/avatar/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: avatarPrompt, image: avatarImage }),
  });
  assert(
    renderRes.ok && renderRes.headers.get('content-type') === 'image/png',
    'avatar render returns PNG bytes',
  );
  const renderedPng = Buffer.from(await renderRes.arrayBuffer());
  assert(renderedPng[0] === 0x89 && renderedPng[1] === 0x50, 'avatar render is a real PNG');
  const { workflow: avatarWorkflow, previewMethod: avatarPreviewMethod } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-workflow`)
  ).json()) as {
    workflow: { 6: { inputs: { text: string } } };
    previewMethod: string | null;
  };
  assert(
    avatarWorkflow[6].inputs.text.includes(avatarPrompt.slice(0, 30)),
    'the prompt lands in the workflow {{prompt}} slot',
  );
  assert(avatarPreviewMethod === 'taesd', 'avatar renders explicitly request TAESD previews');

  // Saving the rendered bytes goes through the normal avatar upload route.
  const genCharRes = await putAvatar(`/api/characters/${avatarChar.id}/avatar`, renderedPng);
  assert(genCharRes.ok, 'rendered avatar saves through the avatar upload route');

  // A jobId gets a private SSE stream rather than a global progress broadcast.
  const avatarJobId = 'e2e-avatar-job';
  const unrelatedJobId = 'e2e-avatar-unrelated-job';
  const unrelatedAbort = new AbortController();
  const unrelatedResponse = await fetch(`${BASE}/api/avatar/render-progress/${unrelatedJobId}`, {
    signal: unrelatedAbort.signal,
  });
  const unrelatedReader = unrelatedResponse.body!.getReader();
  // Consume the registration comment before checking for leaked data events.
  await unrelatedReader.read();
  const progressAbort = new AbortController();
  const progressResponse = await fetch(`${BASE}/api/avatar/render-progress/${avatarJobId}`, {
    signal: progressAbort.signal,
  });
  assert(progressResponse.ok && progressResponse.body != null, 'avatar progress SSE opens');
  const progressSeen = (async () => {
    const reader = progressResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawProgress = false;
    let sawPreview = false;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('avatar progress SSE ended before progress and preview');
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
  })();
  const progressRenderRes = await fetch(`${BASE}/api/avatar/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'progress check', image: avatarImage, jobId: avatarJobId }),
  });
  assert(progressRenderRes.ok, 'avatar render with jobId succeeds');
  await progressSeen;
  assert(true, 'jobId render sends progress and a live preview through its private SSE stream');
  progressAbort.abort();
  const unrelatedResult = await Promise.race([
    unrelatedReader.read().then(
      () => 'event',
      () => 'closed',
    ),
    new Promise<'quiet'>((resolve) => setTimeout(() => resolve('quiet'), 150)),
  ]);
  assert(unrelatedResult === 'quiet', 'avatar progress never leaks to an unrelated job stream');
  unrelatedAbort.abort();

  // Aborting the binary render response (modal close) propagates through the
  // route into Comfy polling rather than leaving background work attached to a
  // disposed component.
  const historyCount = async () =>
    (
      (await (await fetch(`${MOCK_CONTROL}/control/comfy-history-count`)).json()) as {
        count: number;
      }
    ).count;
  const cancelledRender = new AbortController();
  const cancelledRenderRequest = fetch(`${BASE}/api/avatar/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'cancel this avatar render',
      image: avatarImage,
      jobId: 'e2e-avatar-cancelled-job',
    }),
    signal: cancelledRender.signal,
  }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 150));
  cancelledRender.abort();
  await cancelledRenderRequest;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const countAfterAbort = await historyCount();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert(
    (await historyCount()) === countAfterAbort,
    'aborting an avatar render stops further Comfy history polling',
  );

  // Persona variant: {{user}}/{{description}} from the persona row.
  await streamAvatarPrompt(
    `/api/personas/${persona.id}/avatar/prompt`,
    'Portrait of {{user}}: {{description}}',
    'Name: {{name}}\nAvatar details: {{description}}',
  );
  const { completion: personaCompletion } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as { completion: { system: string | null } };
  assert(
    personaCompletion.system === 'Portrait of Aiki: A performance-obsessed developer.',
    'persona avatar prompt macros expand from the persona fields',
  );

  await expectStatus(
    'POST',
    `/api/characters/${avatarChar.id}/avatar/prompt`,
    { prompt: '  ' },
    400,
  );
  await expectStatus('POST', '/api/characters/999999999/avatar/prompt', { prompt: 'x' }, 404);
  await expectStatus('POST', '/api/personas/999999999/avatar/prompt', { prompt: 'x' }, 404);
  await expectStatus('POST', '/api/avatar/render', { prompt: '  ', image: avatarImage }, 400);
  await expectStatus(
    'POST',
    '/api/avatar/render',
    { prompt: 'x', image: { workflow: '', comfyUrl: MOCK_CONTROL } },
    400,
  );
  await expectStatus(
    'POST',
    '/api/avatar/render',
    { prompt: 'x', image: { workflow: '{not json', comfyUrl: MOCK_CONTROL } },
    400,
  );

  console.log('== templates: prologue, name prefixing, /char, resume ==');
  const tpl = await req<{ id: number }>('POST', '/api/templates', {
    name: 'e2e-prefix',
    content: '{{system}}',
    userPrologue: 'You are playing {{char}}.',
    reasoningPrefill: 'Reason first as {{char}} for {{user}}.',
    messagePrefill: 'Seeded reply to {{user}}: ',
    prefixNames: true,
  });
  const prevSettings = await req<{ defaultTemplateId: number | null }>('GET', '/api/settings');
  await putSettings({ defaultTemplateId: tpl.id });
  const conv2 = await req<{ id: number }>('POST', '/api/conversations', {});
  await patchConversation(conv2.id, { speakerName: 'Ari' });

  const trace = await fetchTrace(conv2.id);
  assert(
    trace.messages.some((m) => m.role === 'user' && m.content === 'You are playing Assistant.'),
    'template prologue emitted as fake user turn',
  );
  assert(trace.namePrefill === 'Ari:', 'name prefill uses the /char speaker');
  assert(
    trace.reasoningPrefill === 'Reason first as Assistant for Aiki.' &&
      trace.messagePrefill === 'Seeded reply to Aiki:',
    'template reasoning and message prefills render macros independently',
  );

  ws.sub(conv2.id);
  await fetch(`${MOCK_CONTROL}/control/clear-completions`, { method: 'POST' });
  const sent = await sendMessage(conv2.id, '  prefix check  ');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === sent.assistantMessageId,
    'prefixed generation finished',
  );
  let snap2 = await tree(conv2.id);
  const reply = snap2.messages.find((m) => m.id === sent.assistantMessageId)!;
  assert(reply.name === 'Ari', 'reply stamped with the /char speaker name');
  assert(
    reply.reasoning?.startsWith('Reason first as Assistant for Aiki.') === true &&
      reply.content.startsWith('Seeded reply to Aiki:'),
    'template prefills become part of the saved reasoning and message',
  );
  const seededCompletions = (await (await fetch(`${MOCK_CONTROL}/control/completions`)).json()) as {
    completions: {
      messages: { role: string; content: string; reasoning_content?: string }[];
    }[];
  };
  assert(
    seededCompletions.completions.some((completion) => {
      const prefill = completion.messages.at(-1);
      return (
        prefill?.role === 'assistant' &&
        prefill.content === 'Ari: Seeded reply to Aiki:' &&
        prefill.reasoning_content === 'Reason first as Assistant for Aiki.'
      );
    }),
    'fresh generation sends reasoning_content and visible content in one final assistant prefill',
  );

  console.log('== template reasoning prefill for image prompts ==');
  const imagePrefillConv = await req<{ id: number }>('POST', '/api/conversations', {});
  const imagePrefillWs = new WsClient();
  await imagePrefillWs.open();
  imagePrefillWs.sub(imagePrefillConv.id);
  await imagePrefillWs.waitFor(
    (event) => event.t === 'tree' && event.conversationId === imagePrefillConv.id,
    'image-prefill conversation subscribed',
  );
  await fetch(`${MOCK_CONTROL}/control/clear-completions`, { method: 'POST' });
  const imagePrompt = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${imagePrefillConv.id}/tool`,
    await branchBody(imagePrefillConv.id, {
      prompt: 'Describe {{char}} for {{user}}.',
      label: 'Image prompt',
    }),
  );
  const imagePromptFinal = await imagePrefillWs.waitFor(
    (event) => event.t === 'final' && event.message.id === imagePrompt.toolMessageId,
    'image prompt with reasoning prefill finished',
  );
  assert(
    imagePromptFinal.t === 'final' &&
      imagePromptFinal.message.role === 'tool' &&
      imagePromptFinal.message.reasoning?.startsWith('Reason first as Assistant for Aiki.') ===
        true &&
      !imagePromptFinal.message.content.startsWith('Seeded reply to Aiki:'),
    'image prompt saves the active template reasoning prefill but not its message prefill',
  );
  const imagePromptCompletion = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: {
      messages: { role: string; content: string; reasoning_content?: string }[];
    } | null;
  };
  assert(
    imagePromptCompletion.completion?.messages.at(-1)?.role === 'assistant' &&
      imagePromptCompletion.completion.messages.at(-1)?.content === '' &&
      imagePromptCompletion.completion.messages.at(-1)?.reasoning_content ===
        'Reason first as Assistant for Aiki.',
    'image prompt sends only the template reasoning prefill in its final assistant turn',
  );

  const revisedImagePrompt = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${imagePrompt.toolMessageId}/regenerate`,
    await branchBody(imagePrefillConv.id, { instruction: 'Make it moonlit.' }),
  );
  const revisedImagePromptFinal = await imagePrefillWs.waitFor(
    (event) => event.t === 'final' && event.message.id === revisedImagePrompt.assistantMessageId,
    'revised image prompt with reasoning prefill finished',
  );
  const revisedImagePromptCompletion = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: {
      messages: { role: string; content: string; reasoning_content?: string }[];
    } | null;
  };
  assert(
    revisedImagePromptFinal.t === 'final' &&
      revisedImagePromptFinal.message.reasoning?.startsWith(
        'Reason first as Assistant for Aiki.',
      ) === true &&
      revisedImagePromptCompletion.completion?.messages.at(-1)?.role === 'assistant' &&
      revisedImagePromptCompletion.completion.messages.at(-1)?.content === '' &&
      revisedImagePromptCompletion.completion.messages.at(-1)?.reasoning_content ===
        'Reason first as Assistant for Aiki.',
    'revised image prompt also applies only the active template reasoning prefill',
  );
  imagePrefillWs.close();
  const imagePrefillSnapshot = await tree(imagePrefillConv.id);
  await req(
    'DELETE',
    `/api/conversations/${imagePrefillConv.id}?${branchQuery(imagePrefillSnapshot)}`,
  );

  assert(
    reply.content.includes('Aiki: prefix check'),
    'history prefixed with persona name upstream',
  );
  const prefixedTrace = await fetchTrace(conv2.id);
  assert(
    prefixedTrace.messages.some(
      (message) => message.role === 'user' && message.content.endsWith('Aiki: prefix check'),
    ) && prefixedTrace.namePrefill === 'Ari:',
    'name prefixes use one space and prefills have no trailing space after role normalization',
  );
  assert(
    prefixedTrace.messages.some(
      (message) => message.role === 'assistant' && Boolean(message.reasoning_content),
    ),
    'assistant history replays persisted reasoning_content',
  );

  await patchConversation(conv2.id, { speakerName: 'Bob' });
  const regen = await req<{ assistantMessageId: number | null }>(
    'POST',
    `/api/messages/${sent.assistantMessageId}/advance`,
    await branchBody(conv2.id),
  );
  if (regen.assistantMessageId == null) throw new Error('expected a newly generated swipe');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === regen.assistantMessageId,
    'speaker-preserving swipe finished',
  );
  snap2 = await tree(conv2.id);
  assert(
    snap2.messages.find((m) => m.id === regen.assistantMessageId)!.name === 'Ari',
    'a new swipe keeps the original speaker name',
  );

  const beforeResume = snap2.messages.find((m) => m.id === regen.assistantMessageId)!.content
    .length;
  await req(
    'POST',
    `/api/messages/${regen.assistantMessageId}/continue`,
    await branchBody(conv2.id),
  );
  await ws.waitFor(
    (e) =>
      e.t === 'final' &&
      e.message.id === regen.assistantMessageId &&
      e.message.content.length > beforeResume &&
      e.message.status === 'done',
    'resume appended to the same message',
  );
  const resumedCompletion = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: {
      messages: { role: string; content: string; reasoning_content?: string }[];
    } | null;
  };
  assert(
    resumedCompletion.completion?.messages.at(-1)?.role === 'assistant' &&
      Boolean(resumedCompletion.completion.messages.at(-1)?.reasoning_content),
    'continuation prefill replays reasoning_content with assistant content',
  );

  console.log('== reasoning-only template prefill ==');
  await req('PATCH', `/api/templates/${tpl.id}`, {
    prefixNames: false,
    messagePrefill: '',
  });
  await fetch(`${MOCK_CONTROL}/control/clear-completions`, { method: 'POST' });
  const reasoningOnlyPrefillSend = await sendMessage(conv2.id, 'continue from hidden reasoning');
  const reasoningOnlyPrefillFinal = await ws.waitFor(
    (event) =>
      event.t === 'final' && event.message.id === reasoningOnlyPrefillSend.assistantMessageId,
    'reasoning-only prefill generation finished',
  );
  assert(
    reasoningOnlyPrefillFinal.t === 'final' &&
      reasoningOnlyPrefillFinal.message.reasoning?.startsWith(
        'Reason first as Assistant for Aiki.',
      ) === true &&
      reasoningOnlyPrefillFinal.message.content.length > 0,
    'reasoning-only prefill is saved before newly generated reasoning and message content',
  );
  const reasoningOnlyPrefillRequests = (await (
    await fetch(`${MOCK_CONTROL}/control/completions`)
  ).json()) as {
    completions: {
      messages: { role: string; content: string; reasoning_content?: string }[];
    }[];
  };
  assert(
    reasoningOnlyPrefillRequests.completions.some((completion) => {
      const prefill = completion.messages.at(-1);
      return (
        prefill?.role === 'assistant' &&
        prefill.content === '' &&
        prefill.reasoning_content === 'Reason first as Assistant for Aiki.'
      );
    }),
    'reasoning-only prefill sends an empty visible assistant content with reasoning_content',
  );
  await req('PATCH', `/api/templates/${tpl.id}`, {
    prefixNames: true,
    reasoningPrefill: '',
    messagePrefill: '',
  });

  console.log('== endpoint can disable assistant prefills ==');
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { prefillMode: 'disabled' });
  const disabledNamedTrace = await fetchTrace(conv2.id);
  assert(
    disabledNamedTrace.namePrefill === null,
    'prompt trace omits the disabled endpoint prefill',
  );
  assert(
    disabledNamedTrace.messages
      .findLast((message) => message.role === 'user')
      ?.content.endsWith('<Note: Reply as Bob>') === true,
    'disabled prefill adds an explicit note for a non-default speaker',
  );
  const noPrefillSend = await sendMessage(conv2.id, 'no prefill, please');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === noPrefillSend.assistantMessageId,
    'generation with prefills disabled finished',
  );
  const noPrefillCompletion = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: { lastMessageRole: string | null; continueFinalMessage: boolean } | null;
  };
  assert(
    noPrefillCompletion.completion?.lastMessageRole === 'user' &&
      noPrefillCompletion.completion.continueFinalMessage === false,
    'disabled endpoint omits speaker-name prefill and native continuation flag',
  );

  const noPrefillBeforeResume = (await tree(conv2.id)).messages.find(
    (m) => m.id === noPrefillSend.assistantMessageId,
  )!.content.length;
  await expectStatus(
    'POST',
    `/api/messages/${noPrefillSend.assistantMessageId}/continue`,
    await branchBody(conv2.id),
    400,
  );
  assert(
    (await tree(conv2.id)).messages.find((m) => m.id === noPrefillSend.assistantMessageId)?.content
      .length === noPrefillBeforeResume,
    'disabled endpoint rejects resume without modifying the existing reply',
  );

  await makeNextMockResponseDieAfterContent('Bob: DISABLED_PARTIAL');
  const disabledPartial = await sendMessage(conv2.id, 'disabled partial retry safety');
  const disabledPartialFinal = await ws.waitFor(
    (event) => event.t === 'final' && event.message.id === disabledPartial.assistantMessageId,
    'disabled-prefill partial failure finalizes',
  );
  assert(
    disabledPartialFinal.t === 'final' &&
      disabledPartialFinal.message.status === 'error' &&
      disabledPartialFinal.message.content === 'DISABLED_PARTIAL',
    'disabled prefills neither concatenate a restarted answer nor leak a matching speaker prefix',
  );

  await patchConversation(conv2.id, { speakerName: null });
  const disabledSwitchBackTrace = await fetchTrace(conv2.id);
  assert(
    disabledSwitchBackTrace.messages
      .findLast((message) => message.role === 'user')
      ?.content.endsWith('<Note: Reply as Assistant>') === true,
    'disabled prefill explicitly notes a switch back to the default speaker',
  );
  const defaultSpeakerConv = await req<{ id: number }>('POST', '/api/conversations', {});
  const disabledDefaultTrace = await fetchTrace(defaultSpeakerConv.id);
  assert(
    !disabledDefaultTrace.messages.some((message) => message.content.includes('<Note: Reply as ')),
    'ordinary default-to-default speaking adds no disabled-prefill note',
  );
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { prefillMode: 'none' });

  const clearedTemplates = await putSettings({ defaultTemplateId: null });
  assert(
    clearedTemplates.defaultTemplateId === null,
    'defaultTemplateId can be cleared to the built-in default',
  );
  await putSettings({ defaultTemplateId: prevSettings.defaultTemplateId });

  console.log('== character inline custom template ==');
  const inlineChar = await req<{ id: number }>('POST', '/api/characters', {
    name: 'Inline Hero',
    customTemplate: {
      content: '{{system}} INLINE {{char}} + {{user}}',
      userPrologue: 'Inline prologue for {{char}}.',
      reasoningPrefill: 'Inline reasoning for {{char}}.',
      messagePrefill: 'Inline answer for {{user}}:',
      prefixNames: true,
      usesPersonas: false,
    },
  });
  const inlineConv = await req<{ id: number }>('POST', '/api/conversations', {
    characterId: inlineChar.id,
  });
  const inlineTrace = await fetchTrace(inlineConv.id);
  assert(
    inlineTrace.messages.some(
      (m) => m.role === 'system' && m.content.endsWith('INLINE Inline Hero + User'),
    ),
    'inline template renders its content; usesPersonas=false ignores the persona',
  );
  assert(
    inlineTrace.messages.some(
      (m) => m.role === 'user' && m.content === 'Inline prologue for Inline Hero.',
    ),
    'inline template emits its prologue',
  );
  assert(inlineTrace.namePrefill === 'Inline Hero:', 'inline template enables name prefixing');
  assert(
    inlineTrace.reasoningPrefill === 'Inline reasoning for Inline Hero.' &&
      inlineTrace.messagePrefill === 'Inline answer for User:',
    'inline custom templates expose and macro-render both assistant prefills',
  );

  console.log('== per-conversation scenario override ==');
  const scenarioChar = await req<{ id: number }>('POST', '/api/characters', {
    name: 'Scenario Hero',
    scenario: 'The character scenario for {{char}}.',
    customTemplate: {
      content: '{{#if scenario}}Scene: {{scenario}}{{/if}}',
      userPrologue: '',
      reasoningPrefill: '',
      messagePrefill: '',
      prefixNames: false,
      usesPersonas: true,
    },
  });
  const scenarioConv = await req<Conversation>('POST', '/api/conversations', {
    characterId: scenarioChar.id,
  });
  let scenarioTrace = await fetchTrace(scenarioConv.id);
  assert(
    scenarioTrace.messages.some(
      (message) =>
        message.role === 'system' &&
        message.content === 'Scene: The character scenario for Scenario Hero.',
    ),
    'conversation inherits the character scenario by default',
  );
  const scenarioUpdated = (await patchConversation(scenarioConv.id, {
    scenarioOverride: 'A private scene for {{char}}.',
  })) as Conversation;
  assert(
    scenarioUpdated.scenarioOverride === 'A private scene for {{char}}.',
    'scenario override persists on the conversation',
  );
  scenarioTrace = await fetchTrace(scenarioConv.id);
  assert(
    scenarioTrace.messages.some(
      (message) =>
        message.role === 'system' &&
        message.content === 'Scene: A private scene for Scenario Hero.',
    ),
    'prompt assembly uses the conversation scenario override',
  );
  const scenarioCopy = await req<Conversation>(
    'POST',
    `/api/conversations/${scenarioConv.id}/duplicate`,
  );
  assert(
    scenarioCopy.scenarioOverride === scenarioUpdated.scenarioOverride,
    'conversation duplication preserves the scenario override',
  );
  const emptyScenario = (await patchConversation(scenarioConv.id, {
    scenarioOverride: '',
  })) as Conversation;
  scenarioTrace = await fetchTrace(scenarioConv.id);
  assert(
    emptyScenario.scenarioOverride === '' &&
      !scenarioTrace.messages.some((message) => message.role === 'system'),
    'an empty override deliberately suppresses the scenario',
  );
  const inheritedScenario = (await patchConversation(scenarioConv.id, {
    scenarioOverride: null,
  })) as Conversation;
  scenarioTrace = await fetchTrace(scenarioConv.id);
  assert(
    inheritedScenario.scenarioOverride === null &&
      scenarioTrace.messages.some((message) =>
        message.content.includes('The character scenario for Scenario Hero.'),
      ),
    'clearing the override restores the character scenario',
  );

  console.log('== terminal SSE data without a newline is preserved ==');
  await makeNextMockResponseEndWithoutNewline();
  const terminalSend = await sendMessage(conv2.id, 'terminal SSE event');
  const terminalFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === terminalSend.assistantMessageId,
    'terminal SSE generation finished',
  );
  assert(
    terminalFinal.t === 'final' && terminalFinal.message.content.endsWith('TERMINAL_NO_NEWLINE'),
    'final unterminated SSE event is persisted',
  );

  console.log('== per-conversation endpoint override ==');
  const smallEndpoint = await req<{ id: number }>('POST', '/api/endpoints', {
    name: 'mock-small',
    baseUrl: MOCK_URL,
  });
  const overridden = await req<{ endpointId: number | null }>(
    'PATCH',
    `/api/conversations/${conv2.id}`,
    await branchBody(conv2.id, { endpointId: smallEndpoint.id }),
  );
  assert(overridden.endpointId === smallEndpoint.id, 'endpoint override persisted');
  const defaultModelSend = await sendMessage(conv2.id, 'use the endpoint default');
  const defaultModelFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === defaultModelSend.assistantMessageId,
    'default-model generation finished',
  );
  const defaultModelSeen = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as { completion: { hasModel: boolean } | null };
  assert(
    defaultModelFinal.t === 'final' &&
      defaultModelFinal.message.model === null &&
      defaultModelSeen.completion?.hasModel === false,
    'an endpoint without a selected model omits model from the upstream request',
  );
  await req('PATCH', `/api/endpoints/${smallEndpoint.id}`, { model: 'mock-small' });
  const overrideSend = await sendMessage(conv2.id, 'which model?');
  const overrideFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === overrideSend.assistantMessageId,
    'override generation finished',
  );
  assert(
    overrideFinal.t === 'final' && overrideFinal.message.model === 'mock-small',
    'generation uses the conversation endpoint override',
  );
  await patchConversation(conv2.id, { endpointId: null });
  const revertSend = await sendMessage(conv2.id, 'back to global');
  const revertFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === revertSend.assistantMessageId,
    'reverted generation finished',
  );
  assert(
    revertFinal.t === 'final' && revertFinal.message.model === 'mock-large',
    'clearing the override falls back to the global endpoint',
  );

  console.log('== plugin tool generation (foreground, role=tool) ==');
  const toolSnap = await tree(conv2.id);
  const toolRes = await req<{ toolMessageId: number; activeLeafId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    {
      prompt: 'Describe {{char}} for {{user}}.',
      label: 'Image prompt',
      expectedActiveLeafId: toolSnap.activeLeafId,
      expectedMutationRevision: toolSnap.mutationRevision,
    },
  );
  // Foreground semantics: a concurrent send is rejected while the tool streams.
  await expectStatus(
    'POST',
    `/api/conversations/${conv2.id}/messages`,
    await branchBodyAt(conv2.id, toolRes.toolMessageId, { content: 'busy' }),
    409,
  );
  const toolFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === toolRes.toolMessageId,
    'tool generation finished',
  );
  assert(
    toolFinal.t === 'final' &&
      toolFinal.message.role === 'tool' &&
      toolFinal.message.status === 'done',
    'tool output streams into a role=tool message',
  );
  assert(
    toolFinal.message.content.includes('Describe Assistant for Aiki.'),
    'tool prompt gets {{char}}/{{user}} expanded and the chat context',
  );
  const toolTrace = await fetchTrace(conv2.id);
  assert(
    toolTrace.messages.every(
      (m) => m.role !== 'tool' && !m.content.includes('Describe Assistant for Aiki.'),
    ),
    'tool messages are excluded from prompt history',
  );

  console.log('== parallel tool prompts and deletion during generation ==');
  const toolSource = (await tree(conv2.id)).messages.find(
    (message) => message.id === toolRes.toolMessageId,
  )!;
  const parallelOne = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    await branchBodyAt(conv2.id, toolRes.toolMessageId, {
      prompt: 'Parallel image prompt one.',
      label: 'Image prompt',
    }),
  );
  const parallelTwo = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    await branchBodyAt(conv2.id, parallelOne.toolMessageId, {
      prompt: 'Parallel image prompt two.',
      label: 'Image prompt',
    }),
  );
  const parallelPending = await tree(conv2.id);
  assert(
    parallelPending.messages.find((message) => message.id === parallelOne.toolMessageId)?.status ===
      'streaming' &&
      parallelPending.messages.find((message) => message.id === parallelTwo.toolMessageId)
        ?.status === 'streaming',
    'multiple image prompts stream concurrently in one conversation',
  );
  await req(
    'DELETE',
    await branchPath(conv2.id, `/api/messages/${toolRes.toolMessageId}`, parallelTwo.toolMessageId),
  );
  const parallelAfterDelete = await tree(conv2.id);
  assert(
    !parallelAfterDelete.messages.some((message) => message.id === toolRes.toolMessageId) &&
      parallelAfterDelete.messages.find((message) => message.id === parallelOne.toolMessageId)
        ?.parentId === toolSource.parentId &&
      parallelAfterDelete.messages.find((message) => message.id === parallelTwo.toolMessageId)
        ?.parentId === parallelOne.toolMessageId,
    'deleting an earlier tool message preserves and reparents active prompt generations',
  );
  const parallelOneFinal = await ws.waitFor(
    (event) => event.t === 'final' && event.message.id === parallelOne.toolMessageId,
    'first parallel tool prompt finished',
  );
  const parallelTwoFinal = await ws.waitFor(
    (event) => event.t === 'final' && event.message.id === parallelTwo.toolMessageId,
    'second parallel tool prompt finished',
  );
  assert(
    parallelOneFinal.t === 'final' &&
      parallelOneFinal.message.content.includes('Parallel image prompt one.') &&
      parallelTwoFinal.t === 'final' &&
      parallelTwoFinal.message.content.includes('Parallel image prompt two.'),
    'parallel prompt streams finish independently after their old parent is deleted',
  );

  console.log('== comfy image rendering ==');
  const comfyDeleteCount = async () =>
    (
      (await (await fetch(`${MOCK_CONTROL}/control/comfy-deleted`)).json()) as {
        deleted: { filename: string; type: string }[];
      }
    ).deleted;
  const COMFY_WORKFLOW =
    '{"3":{"class_type":"KSampler","inputs":{"seed":{{seed}}}},"6":{"inputs":{"text":"{{prompt}}"}}}';
  const setNextComfyOutput = async (kind: string) => {
    const res = await fetch(
      `${MOCK_CONTROL}/control/comfy-output-next?kind=${encodeURIComponent(kind)}`,
      { method: 'POST' },
    );
    if (!res.ok) throw new Error(`could not configure mock Comfy output: ${await res.text()}`);
  };
  for (const [kind, mime] of [
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ] as const) {
    await setNextComfyOutput(kind);
    const response = await fetch(`${BASE}/api/avatar/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: `Render ${kind}`,
        image: { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL },
      }),
    });
    assert(
      response.ok && response.headers.get('content-type') === mime,
      `${kind} render bytes are accepted`,
    );
    await response.arrayBuffer();
  }
  const filesBeforeActiveContent = readdirSync(join(dataDir, 'images')).sort().join('\n');
  for (const kind of ['html', 'svg', 'polyglot']) {
    await setNextComfyOutput(kind);
    const response = await fetch(`${BASE}/api/avatar/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: `Reject ${kind}`,
        image: { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL },
      }),
    });
    assert(response.status === 502, `${kind} Comfy output is rejected`);
  }
  assert(
    readdirSync(join(dataDir, 'images')).sort().join('\n') === filesBeforeActiveContent,
    'rejected active-content renders create no generated files',
  );
  const deletesBeforeRender = (await comfyDeleteCount()).length;
  const imgSnap = await tree(conv2.id);
  const imgRes = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    {
      prompt: 'Depict this scene.',
      label: 'Image prompt',
      expectedActiveLeafId: imgSnap.activeLeafId,
      expectedMutationRevision: imgSnap.mutationRevision,
      image: { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL },
    },
  );
  const pendingSnap = await tree(conv2.id);
  assert(
    pendingSnap.messages.find((m) => m.id === imgRes.toolMessageId)?.imagePending === true,
    'image render is flagged pending while the tool text streams',
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === imgRes.toolMessageId,
    'image tool text finished',
  );
  await ws.waitFor(
    (e) => e.t === 'imageProgress' && e.mid === imgRes.toolMessageId,
    'image render progress relayed to subscribers',
    15_000,
  );
  await ws.waitFor(
    (e) =>
      e.t === 'imageProgress' &&
      e.mid === imgRes.toolMessageId &&
      e.preview?.startsWith('data:image/jpeg;base64,') === true,
    'image render preview relayed to subscribers',
    15_000,
  );
  let imageUrl: string | null = null;
  for (let i = 0; i < 60 && !imageUrl; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const snap = await tree(conv2.id);
    const message = snap.messages.find((m) => m.id === imgRes.toolMessageId);
    if (message && !message.imagePending && message.images.length > 0) {
      imageUrl = message.images[0]!;
    }
  }
  assert(imageUrl?.startsWith('/images/'), 'rendered image attached to the tool message');
  const served = await fetch(`${BASE}${imageUrl}`);
  assert(
    served.ok &&
      served.headers.get('content-type') === 'image/png' &&
      served.headers.get('cache-control') === 'no-store' &&
      served.headers.get('x-content-type-options') === 'nosniff' &&
      served.headers.get('content-security-policy')?.includes("default-src 'none'") === true &&
      (await served.arrayBuffer()).byteLength > 0,
    'generated image is served with a raster MIME type and restrictive headers',
  );
  // The download is followed by a best-effort DELETE /view, so ComfyUI doesn't
  // keep a second copy of every image we already own. It is fire-and-forget on
  // the server, hence the poll rather than a straight read.
  let comfyDeletes = await comfyDeleteCount();
  const targetWasDeleted = () =>
    comfyDeletes
      .slice(deletesBeforeRender)
      .some((entry) => entry.filename === 'mock.png' && entry.type === 'output');
  for (let i = 0; i < 40 && !targetWasDeleted(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    comfyDeletes = await comfyDeleteCount();
  }
  assert(targetWasDeleted(), 'the downloaded output is deleted from ComfyUI');

  const { workflow: substituted } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-workflow`)
  ).json()) as {
    workflow: { 3: { inputs: { seed: unknown } }; 6: { inputs: { text: string } } };
  };
  assert(typeof substituted[3].inputs.seed === 'number', '{{seed}} substituted as a number');
  assert(
    substituted[6].inputs.text.includes('You said:') && substituted[6].inputs.text.includes('"'),
    '{{prompt}} carries the JSON-escaped description with quotes intact',
  );

  // Image swipes: the current workflow replaces the stored snapshot, while
  // the message prompt stays fixed and the seed is refreshed.
  const firstSeed = substituted[3].inputs.seed;
  const CURRENT_COMFY_WORKFLOW =
    '{"3":{"class_type":"KSampler","inputs":{"seed":{{seed}}}},"6":{"inputs":{"text":"LATEST {{prompt}}"}}}';
  const originalImagePrompt = (await tree(conv2.id)).messages.find(
    (message) => message.id === imgRes.toolMessageId,
  )!.content;
  await req(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/render-image`,
    await branchBody(conv2.id, { workflow: CURRENT_COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL }),
  );
  const pendingRerender = await tree(conv2.id);
  assert(
    pendingRerender.messages.find((message) => message.id === imgRes.toolMessageId)
      ?.imagePending === true,
    'image rerender is marked pending before returning to the client',
  );
  await expectStatus(
    'PATCH',
    `/api/messages/${imgRes.toolMessageId}`,
    {
      content: 'A stale prompt that must not replace the render input.',
      expectedActiveLeafId: pendingRerender.activeLeafId,
      expectedMutationRevision: pendingRerender.mutationRevision,
    },
    409,
  );
  let regenMsg: Message | undefined;
  for (let i = 0; i < 60 && !regenMsg; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const snap = await tree(conv2.id);
    const message = snap.messages.find((m) => m.id === imgRes.toolMessageId);
    if (message && !message.imagePending && message.images.length === 2) regenMsg = message;
  }
  assert(
    regenMsg != null && regenMsg.activeImage === 1,
    'regenerated image is appended and selected',
  );
  assert(regenMsg.images[0] !== regenMsg.images[1], 'each render produces a distinct image file');
  assert(
    regenMsg.content === originalImagePrompt,
    'a pending image render cannot be attached to an edited prompt',
  );
  const { workflow: regenWorkflow } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-workflow`)
  ).json()) as {
    workflow: { 3: { inputs: { seed: unknown } }; 6: { inputs: { text: string } } };
  };
  assert(regenWorkflow[3].inputs.seed !== firstSeed, 'regeneration uses a fresh seed');
  assert(
    regenWorkflow[6].inputs.text.startsWith('LATEST '),
    'manual regeneration uses and stores the currently selected workflow',
  );
  const beforeImageSelection = await tree(conv2.id);
  await req('POST', `/api/messages/${imgRes.toolMessageId}/active-image`, {
    index: 0,
    expectedActiveLeafId: beforeImageSelection.activeLeafId,
    expectedMutationRevision: beforeImageSelection.mutationRevision,
  });
  await expectStatus(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/active-image`,
    {
      index: 1,
      expectedActiveLeafId: beforeImageSelection.activeLeafId,
      expectedMutationRevision: beforeImageSelection.mutationRevision,
    },
    409,
  );
  assert(
    (await tree(conv2.id)).messages.find((m) => m.id === imgRes.toolMessageId)?.activeImage === 0,
    'active image selection persists and a stale selection cannot overwrite it',
  );
  const secondImageUrl = regenMsg.images[1]!;

  const imageBranch = await req<Conversation>(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/branch-conversation`,
  );
  const imageBranchSnap = await tree(imageBranch.id);
  const branchedImageMessage = pathOf(imageBranchSnap).at(-1)!;
  assert(
    branchedImageMessage.images.length === regenMsg.images.length &&
      branchedImageMessage.images.every(
        (image, index) => image !== regenMsg.images[index] && image.startsWith('/images/'),
      ) &&
      (await fetch(`${BASE}${branchedImageMessage.images[0]}`)).status === 200,
    'branch to new conversation copies generated image files instead of sharing paths',
  );
  console.log('== durable saved-image gallery ==');
  const savedGallery = await req<{ item: GalleryItem; created: boolean }>('POST', '/api/gallery', {
    messageId: branchedImageMessage.id,
    index: branchedImageMessage.activeImage,
  });
  const savedGalleryImageUrl = savedGallery.item.image;
  assert(
    savedGallery.created &&
      savedGallery.item.prompt === branchedImageMessage.content &&
      savedGallery.item.sourceConversationId === imageBranch.id &&
      savedGallery.item.sourceMessageId === branchedImageMessage.id &&
      savedGallery.item.sourceImage ===
        branchedImageMessage.images[branchedImageMessage.activeImage] &&
      savedGalleryImageUrl !== branchedImageMessage.images[branchedImageMessage.activeImage] &&
      (await fetch(`${BASE}${savedGalleryImageUrl}`)).status === 200,
    'saving an image swipe copies its file and snapshots its prompt and source metadata',
  );
  const savedAgain = await req<{ item: GalleryItem; created: boolean }>('POST', '/api/gallery', {
    messageId: branchedImageMessage.id,
    index: branchedImageMessage.activeImage,
  });
  assert(
    !savedAgain.created && savedAgain.item.id === savedGallery.item.id,
    'saving the same source swipe is idempotent',
  );
  await expectStatus(
    'POST',
    '/api/gallery',
    { messageId: branchedImageMessage.id, index: 999 },
    400,
  );
  await req(
    'DELETE',
    `/api/conversations/${imageBranch.id}?expectedActiveLeafId=${imageBranch.activeLeafId}&expectedMutationRevision=${imageBranch.mutationRevision}`,
  );
  assert(
    (await fetch(`${BASE}${branchedImageMessage.images[0]}`)).status === 404 &&
      (await fetch(`${BASE}${regenMsg.images[0]}`)).status === 200,
    'deleting a branched conversation removes only its copied image files',
  );
  const detachedGallery = (await req<GalleryItem[]>('GET', '/api/gallery')).find(
    (item) => item.id === savedGallery.item.id,
  )!;
  assert(
    detachedGallery.sourceConversationId === null &&
      detachedGallery.sourceMessageId === null &&
      detachedGallery.prompt === branchedImageMessage.content &&
      (await fetch(`${BASE}${savedGalleryImageUrl}`)).status === 200,
    'deleting the source conversation detaches links but preserves the saved image and prompt',
  );
  const galleryRevisionInstruction = 'change only the lighting to a warm sunset';
  await expectStatus(
    'POST',
    `/api/gallery/${savedGallery.item.id}/revise-prompt`,
    { prompt: savedGallery.item.prompt, instruction: '   ' },
    400,
  );
  const galleryRevisionResponse = await fetch(
    `${BASE}/api/gallery/${savedGallery.item.id}/revise-prompt`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: savedGallery.item.prompt,
        instruction: galleryRevisionInstruction,
      }),
    },
  );
  assert(
    galleryRevisionResponse.ok &&
      galleryRevisionResponse.headers.get('content-type')?.includes('text/event-stream') === true,
    'gallery prompt revision responds with SSE',
  );
  let galleryRevisedPrompt = '';
  let galleryRevisionDone = false;
  let galleryRevisionError = '';
  for (const line of (await galleryRevisionResponse.text()).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const event = JSON.parse(line.slice(5)) as { d?: string; error?: string; done?: boolean };
    if (event.d) galleryRevisedPrompt += event.d;
    if (event.error) galleryRevisionError = event.error;
    if (event.done) galleryRevisionDone = true;
  }
  assert(
    galleryRevisionDone && !galleryRevisionError && galleryRevisedPrompt.trim().length > 0,
    'gallery prompt revision streams a complete replacement prompt',
  );
  const galleryRevisionCompletion = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: {
      messages: { role: string; content: string }[];
    } | null;
  };
  assert(
    galleryRevisionCompletion.completion?.messages.map((message) => message.role).join(',') ===
      'user,assistant,user' &&
      galleryRevisionCompletion.completion.messages[1]?.content ===
        `<original_image_prompt>\n${savedGallery.item.prompt}\n</original_image_prompt>` &&
      galleryRevisionCompletion.completion.messages[2]?.content.includes(
        `<revision_instruction>\n${galleryRevisionInstruction}\n</revision_instruction>`,
      ) === true,
    'gallery prompt revision reuses the alternating-safe image edit task without chat context',
  );
  const galleryJobId = 'e2e-gallery-job';
  const galleryProgressAbort = new AbortController();
  const galleryProgressResponse = await fetch(
    `${BASE}/api/gallery/render-progress/${galleryJobId}`,
    { signal: galleryProgressAbort.signal },
  );
  assert(
    galleryProgressResponse.ok && galleryProgressResponse.body != null,
    'gallery render progress SSE opens',
  );
  await expectStatus(
    'POST',
    `/api/gallery/${savedGallery.item.id}/render-image`,
    { prompt: '   ' },
    400,
  );
  const galleryProgressSeen = (async () => {
    const reader = galleryProgressResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawProgress = false;
    let sawPreview = false;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('gallery progress SSE ended before progress and preview');
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
  })();
  const galleryGenerated = await req<GalleryItem>(
    'POST',
    `/api/gallery/${savedGallery.item.id}/render-image`,
    { jobId: galleryJobId, prompt: galleryRevisedPrompt },
  );
  await galleryProgressSeen;
  galleryProgressAbort.abort();
  const generatedGalleryImageUrl = galleryGenerated.image;
  assert(
    galleryGenerated.id !== savedGallery.item.id &&
      galleryGenerated.prompt === galleryRevisedPrompt.trim() &&
      galleryGenerated.characterName === savedGallery.item.characterName &&
      galleryGenerated.sourceConversationId === null &&
      galleryGenerated.sourceMessageId === null &&
      generatedGalleryImageUrl !== savedGalleryImageUrl &&
      (await fetch(`${BASE}${generatedGalleryImageUrl}`)).status === 200,
    'gallery generation creates a separate saved image from the regenerated prompt instead of a swipe',
  );
  assert(
    (await req<GalleryItem[]>('GET', '/api/gallery')).some(
      (item) => item.id === savedGallery.item.id && item.image === savedGalleryImageUrl,
    ),
    'creating the new gallery image leaves its source gallery item unchanged',
  );

  // A duplicate is inserted immediately after its source with independent
  // image files. Removing it restores the source as the leaf without touching
  // the source files.
  const beforeImageBranchSwitch = await tree(conv2.id);
  const imageDuplicate = await req<{ messageId: number }>(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/duplicate`,
    {
      expectedActiveLeafId: beforeImageBranchSwitch.activeLeafId,
      expectedMutationRevision: beforeImageBranchSwitch.mutationRevision,
    },
  );
  const imageOffPath = await tree(conv2.id);
  const sourceBeforeImageCopy = beforeImageBranchSwitch.messages.find(
    (message) => message.id === imgRes.toolMessageId,
  )!;
  const duplicatedImageMessage = imageOffPath.messages.find(
    (message) => message.id === imageDuplicate.messageId,
  )!;
  const duplicatedImageUrls = duplicatedImageMessage.images;
  assert(
    duplicatedImageUrls.length === sourceBeforeImageCopy.images.length &&
      duplicatedImageUrls.every(
        (image, index) =>
          image !== sourceBeforeImageCopy.images[index] && image.startsWith('/images/'),
      ) &&
      duplicatedImageMessage.activeImage === sourceBeforeImageCopy.activeImage &&
      duplicatedImageMessage.parentId === imgRes.toolMessageId &&
      imageOffPath.messages.find((message) => message.id === imgRes.toolMessageId)
        ?.activeChildId === imageDuplicate.messageId &&
      imageOffPath.activeLeafId === imageDuplicate.messageId &&
      (await fetch(`${BASE}${duplicatedImageUrls[0]}`)).status === 200,
    'image duplicate inserts below its source with copied images and active selection',
  );
  await expectStatus(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/render-image`,
    {
      expectedActiveLeafId: beforeImageBranchSwitch.activeLeafId,
      expectedMutationRevision: beforeImageBranchSwitch.mutationRevision,
    },
    409,
  );
  await req(
    'DELETE',
    await branchPath(
      conv2.id,
      `/api/messages/${imageDuplicate.messageId}`,
      imageDuplicate.messageId,
    ),
  );
  const afterImageDuplicateDelete = await tree(conv2.id);
  assert(
    (await Promise.all(duplicatedImageUrls.map((image) => fetch(`${BASE}${image}`)))).every(
      (response) => response.status === 404,
    ) &&
      (
        await Promise.all(sourceBeforeImageCopy.images.map((image) => fetch(`${BASE}${image}`)))
      ).every((response) => response.status === 200) &&
      afterImageDuplicateDelete.activeLeafId === imgRes.toolMessageId,
    'deleting an inserted image duplicate restores the source and removes only copied files',
  );

  // A branch guard rejects an old client snapshot, while a current snapshot
  // still cannot spend render work (or change image selection) on an inactive
  // image message exposed in the tree map.
  const inactiveImageBranch = await req<{ messageId: number }>(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/edit-branch`,
    await branchBodyAt(conv2.id, imgRes.toolMessageId, { content: 'Inactive image branch' }),
  );
  const inactiveImageSnap = await tree(conv2.id);
  await expectStatus(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/render-image`,
    {
      expectedActiveLeafId: inactiveImageSnap.activeLeafId,
      expectedMutationRevision: inactiveImageSnap.mutationRevision,
    },
    400,
  );
  await expectStatus(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/active-image`,
    {
      index: 1,
      expectedActiveLeafId: inactiveImageSnap.activeLeafId,
      expectedMutationRevision: inactiveImageSnap.mutationRevision,
    },
    400,
  );
  await activate(conv2.id, imgRes.toolMessageId);
  await req(
    'DELETE',
    await branchPath(
      conv2.id,
      `/api/messages/${inactiveImageBranch.messageId}/swipe`,
      imgRes.toolMessageId,
    ),
  );

  await setNextComfyOutput('html');
  const filesBeforeRejectedMessageRender = readdirSync(join(dataDir, 'images')).sort().join('\n');
  await req(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/render-image`,
    await branchBody(conv2.id),
  );
  let rejectedMessageRender: Message | undefined;
  for (let i = 0; i < 60 && !rejectedMessageRender; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const message = (await tree(conv2.id)).messages.find((m) => m.id === imgRes.toolMessageId);
    if (!message?.imagePending && message?.genMeta?.imageError) rejectedMessageRender = message;
  }
  assert(
    rejectedMessageRender?.images.length === 2 &&
      rejectedMessageRender.genMeta?.imageError?.includes('unsupported or invalid raster image') ===
        true &&
      readdirSync(join(dataDir, 'images')).sort().join('\n') === filesBeforeRejectedMessageRender,
    'rejected active content creates no image reference or local file',
  );

  console.log('== regenerate image tool with instruction ==');
  const imageRevisionTrace = await fetchTrace(conv2.id);
  const STEER_CURRENT_WORKFLOW =
    '{"3":{"class_type":"KSampler","inputs":{"seed":{{seed}}}},"6":{"inputs":{"text":"STEER-LATEST {{prompt}}"}}}';
  const steeredImage = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/regenerate`,
    await branchBody(conv2.id, {
      instruction: 'Make the scene moonlit.',
      image: { workflow: STEER_CURRENT_WORKFLOW, comfyUrl: MOCK_CONTROL },
    }),
  );
  const steeredImageFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === steeredImage.assistantMessageId,
    'steered image prompt finished',
  );
  const imageSteerSeen = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: {
      messages: { role: string; content: string; reasoning_content?: string }[];
      lastMessageRole: string | null;
      lastMessageContent: string | null;
    } | null;
  };
  assert(
    imageSteerSeen.completion?.messages.at(-2)?.role === 'assistant' &&
      imageSteerSeen.completion.messages.at(-2)?.content.includes('<original_image_prompt>') ===
        true &&
      imageSteerSeen.completion.messages.at(-2)?.content.includes(regenMsg.content) === true &&
      Boolean(imageSteerSeen.completion.messages.at(-2)?.reasoning_content),
    'image steer sends the original generated prompt and reasoning as the preceding assistant turn',
  );
  assert(
    imageSteerSeen.completion?.lastMessageRole === 'user' &&
      imageSteerSeen.completion.lastMessageContent?.includes('[IMAGE PROMPT REVISION TASK]') ===
        true &&
      imageSteerSeen.completion.lastMessageContent.includes('reference context only') &&
      imageSteerSeen.completion.lastMessageContent.includes('Do not continue the roleplay') &&
      imageSteerSeen.completion.lastMessageContent.includes('Do not modify anything else.') &&
      imageSteerSeen.completion.lastMessageContent.includes('immediately preceding assistant') &&
      imageSteerSeen.completion.lastMessageContent.includes('<revision_instruction>') &&
      imageSteerSeen.completion.lastMessageContent?.includes('Make the scene moonlit.') === true,
    'image steer clearly separates the original prompt from the constrained instruction',
  );
  assert(
    JSON.stringify(
      imageSteerSeen.completion?.messages.slice(0, imageRevisionTrace.messages.length),
    ) === JSON.stringify(imageRevisionTrace.messages),
    'image steer preserves the exact roleplay-history prefix for context and caching',
  );
  const imageSteerAlternating = imageSteerSeen.completion!.messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  );
  assert(
    imageSteerAlternating.every(
      (message, index) =>
        message.content.trim().length > 0 &&
        (index === 0 || message.role !== imageSteerAlternating[index - 1]!.role),
    ),
    'steered image request keeps contextual user/assistant history alternating',
  );
  assert(
    steeredImageFinal.t === 'final' &&
      steeredImageFinal.message.role === 'tool' &&
      steeredImageFinal.message.parentId === imgRes.toolMessageId &&
      steeredImageFinal.message.hasImageRender,
    'steered image prompt is appended after the source with its render configuration retained',
  );
  let steeredImageRendered: Message | undefined;
  for (let i = 0; i < 60 && !steeredImageRendered; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const message = (await tree(conv2.id)).messages.find(
      (candidate) => candidate.id === steeredImage.assistantMessageId,
    );
    if (message && !message.imagePending && message.images.length === 1) {
      steeredImageRendered = message;
    }
  }
  assert(steeredImageRendered != null, 'steered image prompt automatically renders a fresh image');
  const { workflow: steeredRenderWorkflow } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-workflow`)
  ).json()) as { workflow: { 6: { inputs: { text: string } } } };
  assert(
    steeredRenderWorkflow[6].inputs.text.startsWith('STEER-LATEST '),
    'steered image regeneration uses the currently selected workflow',
  );
  // Remove this test revision so the following chain/deletion checks continue
  // to exercise their original shape from the source image message.
  await req(
    'DELETE',
    await branchPath(
      conv2.id,
      `/api/messages/${steeredImage.assistantMessageId}`,
      steeredImage.assistantMessageId,
    ),
  );
  assert(
    (await tree(conv2.id)).activeLeafId === imgRes.toolMessageId,
    'removing the revised image returns to the source image message',
  );

  // Consecutive tool runs chain parent→child; deleting a tool message must
  // splice it out (descendants survive) and still delete its image from disk.
  const chained = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    await branchBodyAt(conv2.id, imgRes.toolMessageId, {
      prompt: 'Another one.',
      label: 'Image prompt',
    }),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === chained.toolMessageId,
    'chained tool generation finished',
  );
  const chainSnap = await tree(conv2.id);
  assert(
    chainSnap.messages.find((m) => m.id === chained.toolMessageId)?.parentId ===
      imgRes.toolMessageId,
    'consecutive tool messages chain parent→child',
  );

  console.log('== regenerate image tool in the middle of an existing chain ==');
  const insertedRevision = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/regenerate`,
    await branchBody(conv2.id, { instruction: 'Make the scene warmer.' }),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === insertedRevision.assistantMessageId,
    'inserted image revision prompt finished',
  );
  const insertedSnap = await tree(conv2.id);
  const sourceAfterInsert = insertedSnap.messages.find((m) => m.id === imgRes.toolMessageId)!;
  const insertedMessage = insertedSnap.messages.find(
    (m) => m.id === insertedRevision.assistantMessageId,
  )!;
  const chainedAfterInsert = insertedSnap.messages.find((m) => m.id === chained.toolMessageId)!;
  assert(
    insertedMessage.parentId === imgRes.toolMessageId &&
      chainedAfterInsert.parentId === insertedMessage.id &&
      sourceAfterInsert.activeChildId === insertedMessage.id &&
      insertedMessage.activeChildId === chained.toolMessageId &&
      insertedSnap.activeLeafId === chained.toolMessageId,
    'image revision splices into the chain and preserves the active continuation',
  );
  let insertedRendered: Message | undefined;
  for (let i = 0; i < 60 && !insertedRendered; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const message = (await tree(conv2.id)).messages.find(
      (candidate) => candidate.id === insertedRevision.assistantMessageId,
    );
    if (message && !message.imagePending && message.images.length === 1) {
      insertedRendered = message;
    }
  }
  assert(insertedRendered != null, 'inserted image revision renders normally');
  const insertedCopy = await req<{ id: number }>(
    'POST',
    `/api/conversations/${conv2.id}/duplicate`,
  );
  assert(
    JSON.stringify(treeLinkShape(await tree(insertedCopy.id))) ===
      JSON.stringify(treeLinkShape(await tree(conv2.id))),
    'conversation duplicate preserves links through a newer inserted parent',
  );
  const beforeSoleSwipeDelete = await tree(conv2.id);
  await expectStatus(
    'DELETE',
    `/api/messages/${insertedRevision.assistantMessageId}/swipe?${branchQuery(beforeSoleSwipeDelete)}`,
    undefined,
    400,
  );
  assert(
    JSON.stringify(treeLinkShape(await tree(conv2.id))) ===
      JSON.stringify(treeLinkShape(beforeSoleSwipeDelete)),
    'Delete swipe rejects a sole child and preserves its continuation',
  );
  await req(
    'DELETE',
    await branchPath(
      conv2.id,
      `/api/messages/${insertedRevision.assistantMessageId}`,
      chained.toolMessageId,
    ),
  );
  const restoredChain = await tree(conv2.id);
  assert(
    restoredChain.messages.find((m) => m.id === chained.toolMessageId)?.parentId ===
      imgRes.toolMessageId && restoredChain.activeLeafId === chained.toolMessageId,
    'deleting the inserted revision restores the original chain',
  );

  const sourceBeforeImageSwipeDelete = restoredChain.messages.find(
    (message) => message.id === imgRes.toolMessageId,
  )!;
  const removedImageUrl =
    sourceBeforeImageSwipeDelete.images[sourceBeforeImageSwipeDelete.activeImage]!;
  const survivingImageUrl = sourceBeforeImageSwipeDelete.images.find(
    (_, index) => index !== sourceBeforeImageSwipeDelete.activeImage,
  )!;
  await req('POST', `/api/messages/${imgRes.toolMessageId}/delete-image`, {
    index: sourceBeforeImageSwipeDelete.activeImage,
    expectedActiveLeafId: restoredChain.activeLeafId,
    expectedMutationRevision: restoredChain.mutationRevision,
  });
  await expectStatus(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/delete-image`,
    {
      index: 0,
      expectedActiveLeafId: restoredChain.activeLeafId,
      expectedMutationRevision: restoredChain.mutationRevision,
    },
    409,
  );
  const afterImageSwipeDelete = await tree(conv2.id);
  const sourceAfterImageSwipeDelete = afterImageSwipeDelete.messages.find(
    (message) => message.id === imgRes.toolMessageId,
  )!;
  assert(
    sourceAfterImageSwipeDelete.images.length === 1 &&
      sourceAfterImageSwipeDelete.images[0] === survivingImageUrl &&
      sourceAfterImageSwipeDelete.activeImage === 0 &&
      (await fetch(`${BASE}${removedImageUrl}`)).status === 404 &&
      (await fetch(`${BASE}${survivingImageUrl}`)).status === 200,
    'Delete swipe removes only the selected image file and selects the nearest survivor',
  );
  const individuallyDeletedGallery = await req<{ item: GalleryItem; created: boolean }>(
    'POST',
    '/api/gallery',
    { messageId: imgRes.toolMessageId, index: 0 },
  );
  const individuallyDeletedGalleryUrl = individuallyDeletedGallery.item.image;
  assert(
    individuallyDeletedGallery.created &&
      individuallyDeletedGalleryUrl !== survivingImageUrl &&
      (await fetch(`${BASE}${individuallyDeletedGalleryUrl}`)).status === 200,
    'a second source image can be saved as another independent gallery item',
  );

  const imgParent = chainSnap.messages.find((m) => m.id === imgRes.toolMessageId)!.parentId;
  await req(
    'DELETE',
    await branchPath(conv2.id, `/api/messages/${imgRes.toolMessageId}`, chained.toolMessageId),
  );
  const splicedSnap = await tree(conv2.id);
  const survivor = splicedSnap.messages.find((m) => m.id === chained.toolMessageId);
  assert(
    survivor?.parentId === imgParent && splicedSnap.activeLeafId === chained.toolMessageId,
    'deleting a tool message splices it out, keeping its descendants',
  );
  const afterDelete = await fetch(`${BASE}${imageUrl}`);
  const afterDelete2 = await fetch(`${BASE}${secondImageUrl}`);
  assert(
    afterDelete.status === 404 && afterDelete2.status === 404,
    'deleting the tool message deletes all its image files from disk',
  );

  console.log('== comfy render failures surface and are retryable ==');
  const waitForImageState = async (
    mid: number,
    pred: (m: Message) => boolean,
    label: string,
  ): Promise<Message> => {
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const message = (await tree(conv2.id)).messages.find((m) => m.id === mid);
      if (message && pred(message)) return message;
    }
    throw new Error(`timeout waiting for: ${label}`);
  };

  await fetch(`${MOCK_CONTROL}/control/comfy-fail-next?stage=prompt&count=1`, { method: 'POST' });
  const failSnap = await tree(conv2.id);
  const failRes = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    {
      prompt: 'Depict a failure.',
      label: 'Image prompt',
      expectedActiveLeafId: failSnap.activeLeafId,
      expectedMutationRevision: failSnap.mutationRevision,
      image: { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL },
    },
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === failRes.toolMessageId,
    'failing image tool text finished',
  );
  // The failure must be pushed to subscribers (patch with the updated body),
  // not just persisted for the next refetch.
  const failPatch = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.messages.some((m) => m.id === failRes.toolMessageId && m.genMeta?.imageError != null),
    'render failure broadcast to subscribers',
  );
  const failedMsg =
    failPatch.t === 'treePatch'
      ? failPatch.messages.find((m) => m.id === failRes.toolMessageId)
      : undefined;
  assert(
    failedMsg?.imagePending === false &&
      failedMsg.images.length === 0 &&
      failedMsg.status === 'done' &&
      failedMsg.genMeta?.imageError?.includes('rejected the workflow (500)') === true,
    'a rejected submission clears imagePending and surfaces genMeta.imageError',
  );

  // Retry (the client's Retry button) re-renders from the stored config.
  await req(
    'POST',
    `/api/messages/${failRes.toolMessageId}/render-image`,
    await branchBody(conv2.id),
  );
  const retried = await waitForImageState(
    failRes.toolMessageId,
    (m) => !m.imagePending && m.images.length === 1,
    'retry render finished',
  );
  assert(retried.genMeta?.imageError == null, 'a successful retry clears the stored imageError');

  await fetch(`${MOCK_CONTROL}/control/comfy-fail-next?stage=render&count=1`, { method: 'POST' });
  await req(
    'POST',
    `/api/messages/${failRes.toolMessageId}/render-image`,
    await branchBody(conv2.id),
  );
  const execFailed = await waitForImageState(
    failRes.toolMessageId,
    (m) => !m.imagePending && m.genMeta?.imageError != null,
    'execution failure surfaced',
  );
  assert(
    execFailed.genMeta?.imageError?.includes('KSampler [3] RuntimeError: mock render explosion') ===
      true,
    'execution failures relay the ComfyUI node traceback',
  );
  assert(execFailed.images.length === 1, 'a failed re-render keeps previously rendered images');

  console.log('== tool message guards ==');
  await expectStatus(
    'POST',
    `/api/messages/${failRes.toolMessageId}/advance`,
    await branchBodyAt(conv2.id, failRes.toolMessageId),
    400,
  );
  await expectStatus(
    'POST',
    `/api/messages/${failRes.toolMessageId}/continue`,
    await branchBodyAt(conv2.id, failRes.toolMessageId),
    400,
  );

  // Stopping the text generation must clear its queued render — finalize on a
  // non-done ending would otherwise leave imagePending stuck forever.
  const stopSnap = await tree(conv2.id);
  const stopRes = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    {
      prompt: 'Will be stopped.',
      label: 'Image prompt',
      expectedActiveLeafId: stopSnap.activeLeafId,
      expectedMutationRevision: stopSnap.mutationRevision,
      image: { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL },
    },
  );
  await stopGeneration(conv2.id, stopRes.toolMessageId);
  const stoppedMsg = (await tree(conv2.id)).messages.find((m) => m.id === stopRes.toolMessageId);
  assert(
    stoppedMsg?.status === 'stopped' &&
      stoppedMsg.imagePending === false &&
      stoppedMsg.images.length === 0,
    'stopping a tool generation clears its queued image render',
  );

  // render-image is role-agnostic (fallback config stored on first use), and
  // resume is refused while the render is pending — finalize on the resumed
  // generation's non-done endings would disown it.
  const renderSend = await sendMessage(conv2.id, 'draw the last reply');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === renderSend.assistantMessageId,
    'assistant reply to render finished',
  );
  await req(
    'POST',
    `/api/messages/${renderSend.assistantMessageId}/render-image`,
    await branchBody(conv2.id, { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL }),
  );
  await expectStatus(
    'POST',
    `/api/messages/${renderSend.assistantMessageId}/continue`,
    await branchBodyAt(conv2.id, renderSend.assistantMessageId),
    409,
  );
  const assistantRendered = await waitForImageState(
    renderSend.assistantMessageId,
    (m) => !m.imagePending && m.images.length === 1,
    'assistant-message render finished',
  );
  assert(assistantRendered.hasImageRender, 'fallback render config is stored for future swipes');

  console.log('== transient upstream failures auto-resume ==');
  await fetch(`${MOCK_CONTROL}/control/clear-completions`, { method: 'POST' });
  await failNextMockRequests(1);
  const resilientSend = await sendMessage(conv2.id, 'survive a blip');
  await req('PATCH', `/api/endpoints/${endpoint.id}`, {
    model: 'mock-small',
    genParams: { maxTokens: 77, reasoningEffort: 'low' },
  });
  const resilientFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === resilientSend.assistantMessageId,
    'generation survives one upstream 503',
    20_000,
  );
  assert(
    resilientFinal.t === 'final' &&
      resilientFinal.message.status === 'done' &&
      resilientFinal.message.content.length > 0 &&
      resilientFinal.message.model === 'mock-large',
    'foreground generation retries transparently with its snapshotted model',
  );
  const retryRequests = (await (await fetch(`${MOCK_CONTROL}/control/completions`)).json()) as {
    completions: {
      model: string | null;
      maxTokens: number | null;
      reasoningEffort: string | null;
      messages: unknown[];
    }[];
  };
  assert(
    retryRequests.completions.length === 2 &&
      retryRequests.completions.every(
        (request) =>
          request.model === 'mock-large' &&
          request.maxTokens === 321 &&
          request.reasoningEffort === 'high',
      ) &&
      JSON.stringify(retryRequests.completions[0]!.messages) ===
        JSON.stringify(retryRequests.completions[1]!.messages),
    'retry reuses snapshotted endpoint, model, parameters and prompt messages',
  );
  await req('PATCH', `/api/endpoints/${endpoint.id}`, {
    model: 'mock-large',
    genParams: { maxTokens: 321, reasoningEffort: 'high' },
  });
  await failNextMockRequests(3);
  const doomedSend = await sendMessage(conv2.id, 'exhaust the retries');
  const doomedFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === doomedSend.assistantMessageId,
    'generation fails once retries are exhausted',
    30_000,
  );
  assert(
    doomedFinal.t === 'final' &&
      doomedFinal.message.status === 'error' &&
      doomedFinal.message.generationKind === 'normal' &&
      doomedFinal.message.genMeta?.error?.includes('503') === true,
    'exhausted retries surface the upstream error on the message',
  );

  console.log('== held-back name prefix survives a transient retry ==');
  await putSettings({ defaultTemplateId: tpl.id });
  const holdbackConv = await req<{ id: number }>('POST', '/api/conversations', {});
  await patchConversation(holdbackConv.id, { speakerName: 'Hal' });
  ws.sub(holdbackConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === holdbackConv.id,
    'holdback conversation tree',
  );
  // The mock dies after "Ha" — a case-insensitive prefix of the "Hal:" prefill,
  // so the server is still holding it back when the stream cuts out. The retry
  // resumes prefill-style from the flushed holdback and streams normally.
  await fetch(`${MOCK_CONTROL}/control/clear-completions`, { method: 'POST' });
  await makeNextMockResponseDieAfterContent('Ha');
  const holdbackSend = await sendMessage(holdbackConv.id, 'holdback check');
  const holdbackFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === holdbackSend.assistantMessageId,
    'held-back prefix generation retried to completion',
    20_000,
  );
  assert(
    holdbackFinal.t === 'final' &&
      holdbackFinal.message.status === 'done' &&
      holdbackFinal.message.content.startsWith('HaYou said:'),
    'held-back prefix characters are kept exactly once across the retry',
  );
  const holdbackRetryCompletions = (await (
    await fetch(`${MOCK_CONTROL}/control/completions`)
  ).json()) as {
    completions: {
      messages: { role: string; content: string; reasoning_content?: string }[];
    }[];
  };
  const reasoningPrefill = holdbackRetryCompletions.completions
    .findLast((completion) => completion.messages.at(-1)?.role === 'assistant')
    ?.messages.at(-1);
  assert(
    reasoningPrefill?.reasoning_content?.includes('PARTIAL_RETRY_REASONING') === true,
    'partial retry prefill replays accumulated reasoning_content',
  );

  await fetch(`${MOCK_CONTROL}/control/reasoning-only`, { method: 'POST' });
  const reasoningOnlySend = await sendMessage(holdbackConv.id, 'reasoning-only history check');
  const reasoningOnlyFinal = await ws.waitFor(
    (event) => event.t === 'final' && event.message.id === reasoningOnlySend.assistantMessageId,
    'reasoning-only generation finished',
  );
  assert(
    reasoningOnlyFinal.t === 'final' &&
      reasoningOnlyFinal.message.content === '' &&
      reasoningOnlyFinal.message.reasoning?.includes('REASONING_ONLY_OUTPUT') === true,
    'reasoning-only assistant output is persisted',
  );
  await fetch(`${MOCK_CONTROL}/control/clear-completions`, { method: 'POST' });
  const afterReasoningOnly = await sendMessage(holdbackConv.id, 'continue after reasoning only');
  await ws.waitFor(
    (event) => event.t === 'final' && event.message.id === afterReasoningOnly.assistantMessageId,
    'generation after reasoning-only history finished',
  );
  const afterReasoningOnlyCompletion = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: {
      messages: { role: string; content: string; reasoning_content?: string }[];
    } | null;
  };
  assert(
    afterReasoningOnlyCompletion.completion?.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.reasoning_content?.includes('REASONING_ONLY_OUTPUT') === true,
    ),
    'reasoning-only assistant history is replayed upstream',
  );
  await putSettings({ defaultTemplateId: prevSettings.defaultTemplateId });

  console.log('== background swipe generation stays one reply ahead ==');
  assert(
    !(await req<Settings>('GET', '/api/settings')).parallelBackgroundSwipeGeneration,
    'background swipes wait for the primary reply by default',
  );
  await putSettings({ backgroundSwipeGeneration: false });
  const backgroundConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(backgroundConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === backgroundConv.id,
    'background-swipe conversation tree',
  );
  const backgroundSend = await sendMessage(backgroundConv.id, 'prepare swipe choices');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === backgroundSend.assistantMessageId,
    'foreground swipe reply finished',
  );
  await putSettings({ backgroundSwipeGeneration: true });
  const preparedTree = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === backgroundConv.id &&
      e.activeLeafId === backgroundSend.assistantMessageId &&
      e.nodes.some(
        (node) =>
          node.parentId === backgroundSend.userMessageId &&
          node.id !== backgroundSend.assistantMessageId &&
          node.status === 'streaming',
      ),
    'one inactive swipe starts in the background',
  );
  if (preparedTree.t !== 'treePatch') throw new Error('unreachable');
  const prepared = preparedTree.nodes.find(
    (node) =>
      node.parentId === backgroundSend.userMessageId &&
      node.id !== backgroundSend.assistantMessageId,
  )!;
  assert(
    preparedTree.activeLeafId === backgroundSend.assistantMessageId,
    'API-only setting enable starts preparation without changing the visible reply',
  );
  await expectStatus(
    'POST',
    `/api/generations/${prepared.id}/stop`,
    { expectedGenerationToken: prepared.generationToken },
    409,
  );
  await req('POST', `/api/messages/${prepared.id}/activate`, {
    expectedActiveLeafId: backgroundSend.assistantMessageId,
    expectedMutationRevision: preparedTree.mutationRevision,
  });
  await expectStatus(
    'POST',
    `/api/messages/${prepared.id}/activate`,
    await branchBodyAt(backgroundConv.id, backgroundSend.assistantMessageId),
    409,
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === prepared.id,
    'activated background swipe finished',
  );
  const nextPreparedTree = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === backgroundConv.id &&
      e.activeLeafId === prepared.id &&
      e.nodes.filter((node) => node.parentId === backgroundSend.userMessageId).length === 3,
    'activating the prepared swipe starts exactly one successor',
  );
  if (nextPreparedTree.t !== 'treePatch') throw new Error('unreachable');
  const thirdSwipe = nextPreparedTree.nodes.find(
    (node) =>
      node.parentId === backgroundSend.userMessageId &&
      node.id !== backgroundSend.assistantMessageId &&
      node.id !== prepared.id,
  )!;
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === thirdSwipe.id,
    'successor background swipe finished',
  );
  const backgroundSnap = await tree(backgroundConv.id);
  assert(
    backgroundSnap.activeLeafId === prepared.id &&
      backgroundSnap.messages.filter((message) => message.parentId === backgroundSend.userMessageId)
        .length === 3,
    'only one unread swipe is prepared ahead of the reply being read',
  );

  const beforeProtectedResume = backgroundSnap.messages.find(
    (message) => message.id === prepared.id,
  )!.content.length;
  await req('POST', `/api/messages/${prepared.id}/continue`, {
    expectedActiveLeafId: prepared.id,
    expectedMutationRevision: backgroundSnap.mutationRevision,
  });
  await expectStatus(
    'PATCH',
    `/api/conversations/${backgroundConv.id}`,
    await branchBody(backgroundConv.id, { speakerName: 'Rejected while foreground streams' }),
    409,
  );
  assert(
    (await tree(backgroundConv.id)).messages.some((message) => message.id === thirdSwipe.id),
    'rejected context edits do not delete completed speculative swipes',
  );
  await ws.waitFor(
    (e) =>
      e.t === 'final' &&
      e.message.id === prepared.id &&
      e.message.content.length > beforeProtectedResume,
    'protected foreground resume finishes',
  );

  console.log('== in-place history edits invalidate completed background swipes ==');
  await req(
    'PATCH',
    `/api/messages/${backgroundSend.userMessageId}`,
    await branchBodyAt(backgroundConv.id, prepared.id, { content: 'edited swipe context' }),
  );
  const editedTree = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === backgroundConv.id &&
      !e.nodes.some((node) => node.id === thirdSwipe.id) &&
      e.nodes.some(
        (node) =>
          node.parentId === backgroundSend.userMessageId &&
          node.id > thirdSwipe.id &&
          node.generationKind === 'speculative',
      ),
    'history edit refills the speculative swipe',
  );
  if (editedTree.t !== 'treePatch') throw new Error('unreachable');
  assert(
    !editedTree.nodes.some((node) => node.id === thirdSwipe.id),
    'completed speculative reply is removed after an ancestor edit',
  );
  const editedSwipe = editedTree.nodes.find(
    (node) =>
      node.parentId === backgroundSend.userMessageId &&
      node.id > thirdSwipe.id &&
      node.generationKind === 'speculative',
  )!;
  const editedFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === editedSwipe.id,
    'fresh swipe after history edit',
  );
  assert(
    editedFinal.t === 'final' && editedFinal.message.content.includes('edited swipe context'),
    'replacement swipe is generated from the edited history',
  );
  await patchConversation(backgroundConv.id, { speakerName: 'Changed' });
  const invalidatedTree = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === backgroundConv.id &&
      !e.nodes.some((node) => node.id === editedSwipe.id) &&
      e.nodes.some((node) => node.id > editedSwipe.id && node.generationKind === 'speculative'),
    'conversation context change refills the speculative swipe',
  );
  if (invalidatedTree.t !== 'treePatch') throw new Error('unreachable');
  assert(
    !invalidatedTree.nodes.some((node) => node.id === editedSwipe.id) &&
      invalidatedTree.nodes.some(
        (node) => node.id > editedSwipe.id && node.generationKind === 'speculative',
      ),
    'context changes replace stale speculation and preserve one-ahead generation',
  );
  await putSettings({ backgroundSwipeGeneration: false });

  console.log('== failed background generations keep retrying ==');
  const retryConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(retryConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === retryConv.id,
    'retry conversation tree',
  );
  const retrySend = await sendMessage(retryConv.id, 'retry background preparation');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === retrySend.assistantMessageId,
    'retry conversation foreground reply',
  );
  await failNextMockRequests(2);
  await putSettings({ backgroundSwipeGeneration: true });
  const retriedFinal = await ws.waitFor(
    (e) =>
      e.t === 'final' &&
      e.message.parentId === retrySend.userMessageId &&
      e.message.id !== retrySend.assistantMessageId &&
      e.message.status === 'done',
    'background preparation succeeds after two failures',
    30_000,
  );
  assert(
    retriedFinal.t === 'final' && retriedFinal.message.generationKind === 'speculative',
    'background refill retries transient failures with backoff',
  );
  await putSettings({ backgroundSwipeGeneration: false });

  console.log('== speculative swipes wait for a subscribed client ==');
  await putSettings({ backgroundSwipeGeneration: true });
  // Fresh conversation, never subscribed: ws is still on retryConv, and each
  // ws client subscribes to at most one conversation.
  const gatedConv = await req<{ id: number }>('POST', '/api/conversations', {});
  const gatedSend = await sendMessage(gatedConv.id, 'no spectators here');
  let gatedReply: Message | undefined;
  for (let i = 0; i < 60 && !gatedReply; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const message = (await tree(gatedConv.id)).messages.find(
      (m) => m.id === gatedSend.assistantMessageId,
    );
    if (message?.status === 'done') gatedReply = message;
  }
  assert(gatedReply != null, 'unwatched foreground reply finished');
  // Grace period: an ungated onDone would spawn the speculative sibling within
  // a microtask of finalize; 1.5s is far beyond any legitimate delay.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const unwatchedSnap = await tree(gatedConv.id);
  assert(
    unwatchedSnap.messages.filter((m) => m.parentId === gatedSend.userMessageId).length === 1 &&
      !unwatchedSnap.messages.some((m) => m.generationKind === 'speculative'),
    'no speculative swipe is generated while nobody is subscribed',
  );
  ws.sub(gatedConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === gatedConv.id,
    'gated conversation tree after subscribing',
  );
  const gatedPreparedTree = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === gatedConv.id &&
      e.nodes.some(
        (node) =>
          node.parentId === gatedSend.userMessageId &&
          node.id !== gatedSend.assistantMessageId &&
          node.status === 'streaming',
      ),
    'subscribing starts the held-off speculative swipe',
  );
  if (gatedPreparedTree.t !== 'treePatch') throw new Error('unreachable');
  const gatedPrepared = gatedPreparedTree.nodes.find(
    (node) => node.parentId === gatedSend.userMessageId && node.id !== gatedSend.assistantMessageId,
  )!;
  const gatedFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === gatedPrepared.id,
    'gated speculative swipe finished',
  );
  assert(
    gatedFinal.t === 'final' && gatedFinal.message.generationKind === 'speculative',
    'the speculative swipe generates once a client is watching',
  );
  await putSettings({ backgroundSwipeGeneration: false });

  console.log('== Delete swipe safely promotes a completed speculative alternative ==');
  const promotedConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(promotedConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === promotedConv.id,
    'speculative-promotion conversation tree',
  );
  const promotedBase = await sendMessage(promotedConv.id, 'promote the prepared alternative');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === promotedBase.assistantMessageId,
    'speculative-promotion foreground reply',
  );
  await putSettings({ backgroundSwipeGeneration: true });
  const promotedPreparedPatch = await ws.waitFor(
    (e) =>
      e.t === 'treePatch' &&
      e.conversationId === promotedConv.id &&
      e.nodes.some(
        (node) =>
          node.parentId === promotedBase.userMessageId &&
          node.id !== promotedBase.assistantMessageId &&
          node.generationKind === 'speculative',
      ),
    'prepared replacement for Delete swipe',
  );
  if (promotedPreparedPatch.t !== 'treePatch') throw new Error('unreachable');
  const promotedPrepared = promotedPreparedPatch.nodes.find(
    (node) =>
      node.parentId === promotedBase.userMessageId &&
      node.id !== promotedBase.assistantMessageId &&
      node.generationKind === 'speculative',
  )!;
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === promotedPrepared.id,
    'prepared replacement finishes before deletion',
  );
  await req(
    'DELETE',
    await branchPath(
      promotedConv.id,
      `/api/messages/${promotedBase.assistantMessageId}/swipe`,
      promotedBase.assistantMessageId,
    ),
  );
  let promotedSnap = await tree(promotedConv.id);
  assert(
    promotedSnap.activeLeafId === promotedPrepared.id &&
      promotedSnap.messages.find((message) => message.id === promotedPrepared.id)
        ?.generationKind === 'normal',
    'Delete swipe normalizes the completed speculative replacement before activation',
  );
  const promotedDescendant = await sendMessage(promotedConv.id, 'keep this descendant');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === promotedDescendant.assistantMessageId,
    'descendant below promoted replacement finishes',
  );
  await req(
    'PATCH',
    `/api/messages/${promotedDescendant.userMessageId}`,
    await branchBodyAt(promotedConv.id, promotedDescendant.assistantMessageId, {
      content: 'keep this edited descendant',
    }),
  );
  promotedSnap = await tree(promotedConv.id);
  assert(
    promotedSnap.activeLeafId === promotedDescendant.assistantMessageId &&
      promotedSnap.messages.some((message) => message.id === promotedPrepared.id) &&
      promotedSnap.messages.some((message) => message.id === promotedDescendant.userMessageId) &&
      promotedSnap.messages.some((message) => message.id === promotedDescendant.assistantMessageId),
    'later speculation invalidation preserves the promoted branch and descendants',
  );
  await putSettings({ backgroundSwipeGeneration: false });

  console.log('== characters can disable background swipe generation ==');
  const swipeCharacter = await req<Character>('POST', '/api/characters', {
    name: 'No background swipes',
    disableBackgroundSwipeGeneration: true,
  });
  assert(swipeCharacter.disableBackgroundSwipeGeneration, 'character speculation opt-out persists');
  const swipeCharacterCopy = await req<Character>(
    'POST',
    `/api/characters/${swipeCharacter.id}/duplicate`,
  );
  assert(
    swipeCharacterCopy.disableBackgroundSwipeGeneration,
    'duplicating a character preserves its speculation opt-out',
  );
  await expectStatus(
    'PATCH',
    `/api/characters/${swipeCharacter.id}`,
    { disableBackgroundSwipeGeneration: 'true' },
    400,
  );
  const characterSwipeConv = await req<{ id: number }>('POST', '/api/conversations', {
    characterId: swipeCharacter.id,
  });
  ws.sub(characterSwipeConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === characterSwipeConv.id,
    'character speculation conversation tree',
  );
  await putSettings({ backgroundSwipeGeneration: true });
  const characterReply = await sendMessage(characterSwipeConv.id, 'no automatic swipes');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === characterReply.assistantMessageId,
    'opted-out character foreground reply',
  );
  assert(
    !(await tree(characterSwipeConv.id)).messages.some((m) => m.generationKind === 'speculative'),
    'character opt-out suppresses speculation while the global setting is enabled',
  );
  const manualCharacterSwipe = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${characterReply.assistantMessageId}/advance`,
    await branchBody(characterSwipeConv.id),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === manualCharacterSwipe.assistantMessageId,
    'manual swipe still generates for an opted-out character',
  );
  assert(
    !(await tree(characterSwipeConv.id)).messages.some((m) => m.generationKind === 'speculative'),
    'manual swipes remain available without starting background successors',
  );
  await req('PATCH', `/api/characters/${swipeCharacter.id}`, {
    disableBackgroundSwipeGeneration: false,
  });
  const characterSpeculation = await waitForSpeculation(
    characterSwipeConv.id,
    manualCharacterSwipe.assistantMessageId,
  );
  await req('PATCH', `/api/characters/${swipeCharacter.id}`, {
    disableBackgroundSwipeGeneration: true,
  });
  await ws.waitFor(
    (e) =>
      e.t === 'final' && e.message.id === characterSpeculation && e.message.status === 'stopped',
    'disabling speculation for the character cancels its current background stream',
  );
  assert(
    !(await tree(characterSwipeConv.id)).messages.some((m) => m.generationKind === 'speculative'),
    'disabling speculation removes the prepared swipe without refilling',
  );
  await putSettings({ backgroundSwipeGeneration: false });
  await req('PATCH', `/api/characters/${swipeCharacter.id}`, {
    disableBackgroundSwipeGeneration: false,
  });
  assert(
    !(await tree(characterSwipeConv.id)).messages.some((m) => m.generationKind === 'speculative'),
    'clearing the character opt-out still respects the disabled global setting',
  );

  console.log('== speculation follows only the active branch leaf ==');
  const branchConv = await req<{ id: number }>('POST', '/api/conversations', {});
  ws.sub(branchConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === branchConv.id,
    'branch speculation conversation tree',
  );
  const branchBase = await sendMessage(branchConv.id, 'branch root');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === branchBase.assistantMessageId,
    'branch root reply',
  );
  const branchAlternative = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${branchBase.assistantMessageId}/advance`,
    await branchBody(branchConv.id),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === branchAlternative.assistantMessageId,
    'alternate branch reply',
  );
  await activate(branchConv.id, branchBase.assistantMessageId);
  const branchTail = await sendMessage(branchConv.id, 'deep branch tail');
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === branchTail.assistantMessageId,
    'deep branch reply',
  );

  async function waitForSpeculation(conversationId: number, leafId: number): Promise<number> {
    const patch = await ws.waitFor(
      (e) =>
        e.t === 'treePatch' &&
        e.conversationId === conversationId &&
        e.activeLeafId === leafId &&
        e.nodes.some((m) => m.generationKind === 'speculative' && m.status === 'streaming'),
      `speculation at leaf ${leafId}`,
    );
    if (patch.t !== 'treePatch') throw new Error('unreachable');
    const speculative = patch.nodes.filter((m) => m.generationKind === 'speculative');
    const leaf = patch.nodes.find((m) => m.id === leafId)!;
    assert(
      speculative.length === 1 && speculative[0]!.parentId === leaf.parentId,
      'only the active leaf has a speculative sibling',
    );
    return speculative[0]!.id;
  }

  await putSettings({ backgroundSwipeGeneration: true });
  const tailSpeculation = await waitForSpeculation(branchConv.id, branchTail.assistantMessageId);
  await req(
    'POST',
    `/api/messages/${branchBase.assistantMessageId}/advance`,
    await branchBody(branchConv.id),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === tailSpeculation && e.message.status === 'stopped',
    'swiping an ancestor stops speculation on the abandoned tail',
  );
  const alternateSpeculation = await waitForSpeculation(
    branchConv.id,
    branchAlternative.assistantMessageId,
  );
  await activate(branchConv.id, branchBase.assistantMessageId);
  await ws.waitFor(
    (e) =>
      e.t === 'final' && e.message.id === alternateSpeculation && e.message.status === 'stopped',
    'activating the old branch stops speculation on the alternate branch',
  );
  const restoredBranch = await tree(branchConv.id);
  assert(
    restoredBranch.activeLeafId === branchTail.assistantMessageId &&
      !restoredBranch.messages.some(
        (m) => m.id === tailSpeculation || m.id === alternateSpeculation,
      ),
    'branch restoration retains the deep tail and removes both canceled speculative replies',
  );
  await putSettings({ backgroundSwipeGeneration: false });

  console.log('== leaving a conversation cancels its speculative stream ==');
  const emptyConv = await req<{ id: number }>('POST', '/api/conversations', {});
  for (const leave of ['switch', 'unsubscribe', 'disconnect'] as const) {
    const watched = await req<{ id: number }>('POST', '/api/conversations', {});
    ws.sub(watched.id);
    await ws.waitFor(
      (e) => e.t === 'tree' && e.conversationId === watched.id,
      `${leave} conversation tree`,
    );
    const reply = await sendMessage(watched.id, `cancel on ${leave}`);
    await ws.waitFor(
      (e) => e.t === 'final' && e.message.id === reply.assistantMessageId,
      `${leave} foreground reply`,
    );
    const viewer = new WsClient();
    await viewer.open();
    viewer.sub(watched.id);
    await viewer.waitFor(
      (e) => e.t === 'tree' && e.conversationId === watched.id,
      'second viewer subscribed',
    );
    await putSettings({ backgroundSwipeGeneration: true });
    const speculativeId = await waitForSpeculation(watched.id, reply.assistantMessageId);
    // Wait for a fresh snapshot to confirm the first viewer has switched away.
    ws.events = [];
    ws.sub(emptyConv.id);
    await ws.waitFor(
      (e) => e.t === 'tree' && e.conversationId === emptyConv.id,
      'first viewer switched away',
    );
    assert(
      (await tree(watched.id)).messages.some(
        (m) => m.id === speculativeId && m.status === 'streaming',
      ),
      'speculation continues while another viewer remains',
    );
    if (leave === 'disconnect') viewer.close();
    else viewer.sub(leave === 'switch' ? emptyConv.id : null);
    let abandoned = await tree(watched.id);
    for (let i = 0; i < 100 && abandoned.messages.some((m) => m.id === speculativeId); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      abandoned = await tree(watched.id);
    }
    assert(
      !abandoned.messages.some((m) => m.generationKind === 'speculative') &&
        abandoned.activeLeafId === reply.assistantMessageId,
      `${leave} cancels and removes speculation after the last viewer leaves`,
    );
    // Synchronous branch routes must obey the same visibility gate as onDone.
    await activate(watched.id, reply.assistantMessageId);
    assert(
      !(await tree(watched.id)).messages.some((m) => m.generationKind === 'speculative'),
      'an API branch activation cannot start speculation in an unwatched conversation',
    );
    viewer.close();
    await putSettings({ backgroundSwipeGeneration: false });
  }

  console.log('== optional parallel background swipe generation ==');
  await expectStatus(
    'PUT',
    '/api/settings',
    {
      expectedRevision: (await req<Settings>('GET', '/api/settings')).revision,
      parallelBackgroundSwipeGeneration: 2,
    },
    400,
  );

  async function newSwipeConversation(characterId?: number) {
    const conversation = await req<{ id: number }>('POST', '/api/conversations', { characterId });
    ws.sub(conversation.id);
    await ws.waitFor(
      (e) => e.t === 'tree' && e.conversationId === conversation.id,
      'parallel swipe conversation subscribed',
    );
    return conversation.id;
  }

  async function assertParallelPair(conversationId: number, primaryId: number): Promise<number> {
    const snapshot = await tree(conversationId);
    const speculative = snapshot.messages.filter((m) => m.generationKind === 'speculative');
    const primary = snapshot.messages.find((m) => m.id === primaryId)!;
    assert(
      snapshot.activeLeafId === primaryId &&
        primary.status === 'streaming' &&
        speculative.length === 1 &&
        speculative[0]!.status === 'streaming' &&
        speculative[0]!.parentId === primary.parentId &&
        snapshot.messages.filter((m) => m.status === 'streaming').length === 2,
      'exactly the active primary and one unread sibling stream concurrently',
    );
    const speculativeId = speculative[0]!.id;
    await ws.waitFor((e) => e.t === 'delta' && e.mid === primaryId, 'primary emits live tokens');
    await ws.waitFor(
      (e) => e.t === 'delta' && e.mid === speculativeId,
      'parallel background swipe emits live tokens',
    );
    return speculativeId;
  }

  const toggleConv = await newSwipeConversation();
  await putSettings({ backgroundSwipeGeneration: true });
  const toggleReply = await sendMessage(toggleConv, 'toggle parallel speculation mid-stream');
  assert(
    !(await tree(toggleConv)).messages.some((m) => m.generationKind === 'speculative'),
    'serial mode does not start speculation during the primary response',
  );
  await putSettings({ parallelBackgroundSwipeGeneration: true });
  const toggledSpeculation = await assertParallelPair(toggleConv, toggleReply.assistantMessageId);
  await putSettings({ parallelBackgroundSwipeGeneration: false });
  const serialAgain = await tree(toggleConv);
  assert(
    serialAgain.messages.find((m) => m.id === toggleReply.assistantMessageId)?.status ===
      'streaming' && !serialAgain.messages.some((m) => m.id === toggledSpeculation),
    'disabling parallel mode cancels only the background stream',
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === toggleReply.assistantMessageId,
    'primary finishes after returning to serial mode',
  );
  ws.events = [];
  const serialSuccessor = await tree(toggleConv);
  assert(
    serialSuccessor.messages.some((m) => m.generationKind === 'speculative'),
    'serial mode still prepares a swipe after the primary finishes',
  );
  await putSettings({ backgroundSwipeGeneration: false, parallelBackgroundSwipeGeneration: true });

  for (const action of ['advance', 'activate'] as const) {
    const parallelConv = await newSwipeConversation();
    await putSettings({ backgroundSwipeGeneration: true });
    const primary = await sendMessage(parallelConv, `parallel swipe via ${action}`);
    const speculativeId = await assertParallelPair(parallelConv, primary.assistantMessageId);
    // Resubscription must not create another speculative stream.
    ws.sub(parallelConv);
    await req(
      'POST',
      `/api/messages/${action === 'advance' ? primary.assistantMessageId : speculativeId}/${action}`,
      await branchBody(parallelConv),
    );
    const nextSpeculativeId = await assertParallelPair(parallelConv, speculativeId);
    const promoted = await tree(parallelConv);
    assert(
      promoted.messages.find((m) => m.id === primary.assistantMessageId)?.status === 'stopped' &&
        promoted.messages.find((m) => m.id === speculativeId)?.generationKind === 'normal',
      `${action} stops the primary, promotes the prepared swipe, and refills just one successor`,
    );
    await stopGeneration(parallelConv, speculativeId);
    const stoppedPair = await tree(parallelConv);
    assert(
      !stoppedPair.messages.some((m) => m.status === 'streaming' || m.id === nextSpeculativeId),
      'stopping the promoted primary also cancels its parallel successor',
    );
    // Resume is another entry point into concurrent generation.
    await req('POST', `/api/messages/${speculativeId}/continue`, await branchBody(parallelConv));
    await assertParallelPair(parallelConv, speculativeId);
    await stopGeneration(parallelConv, speculativeId);
    await putSettings({ backgroundSwipeGeneration: false });
  }

  console.log('== a parallel swipe may finish before its primary ==');
  const earlyConv = await newSwipeConversation();
  await putSettings({ backgroundSwipeGeneration: true });
  const delayResponse = await fetch(`${MOCK_CONTROL}/control/token-delay-next?ms=40`, {
    method: 'POST',
  });
  if (!delayResponse.ok) throw new Error('could not slow the next mock stream');
  const slowPrimary = await sendMessage(earlyConv, 'background reply finishes first');
  const earlySwipe = await assertParallelPair(earlyConv, slowPrimary.assistantMessageId);
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === earlySwipe && e.message.status === 'done',
    'background swipe finishes ahead of its primary',
  );
  const earlySnapshot = await tree(earlyConv);
  assert(
    earlySnapshot.messages.find((m) => m.id === slowPrimary.assistantMessageId)?.status ===
      'streaming' &&
      earlySnapshot.messages.filter((m) => m.generationKind === 'speculative').length === 1,
    'a completed unread swipe does not spawn additional background alternatives',
  );
  await activate(earlyConv, earlySwipe);
  const selectedEarly = await tree(earlyConv);
  assert(
    selectedEarly.activeLeafId === earlySwipe &&
      selectedEarly.messages.find((m) => m.id === slowPrimary.assistantMessageId)?.status ===
        'stopped' &&
      selectedEarly.messages.filter((m) => m.status === 'streaming').length === 1,
    'activating an already-completed parallel swipe stops its primary and prepares one successor',
  );
  await putSettings({ backgroundSwipeGeneration: false });

  const disabledParallelConv = await newSwipeConversation(swipeCharacter.id);
  await req('PATCH', `/api/characters/${swipeCharacter.id}`, {
    disableBackgroundSwipeGeneration: true,
  });
  await putSettings({ backgroundSwipeGeneration: true });
  const disabledParallelReply = await sendMessage(
    disabledParallelConv,
    'parallel character opt-out',
  );
  assert(
    !(await tree(disabledParallelConv)).messages.some((m) => m.generationKind === 'speculative'),
    'character opt-out also prevents parallel speculation',
  );
  await stopGeneration(disabledParallelConv, disabledParallelReply.assistantMessageId);
  await putSettings({ backgroundSwipeGeneration: false });

  const leavingParallelConv = await newSwipeConversation();
  await putSettings({ backgroundSwipeGeneration: true });
  const leavingPrimary = await sendMessage(
    leavingParallelConv,
    'leave while both responses stream',
  );
  const leavingSpeculation = await assertParallelPair(
    leavingParallelConv,
    leavingPrimary.assistantMessageId,
  );
  ws.events = [];
  ws.sub(emptyConv.id);
  await ws.waitFor(
    (e) => e.t === 'tree' && e.conversationId === emptyConv.id,
    'leave parallel conversation',
  );
  const leftParallel = await tree(leavingParallelConv);
  assert(
    leftParallel.messages.find((m) => m.id === leavingPrimary.assistantMessageId)?.status ===
      'streaming' && !leftParallel.messages.some((m) => m.id === leavingSpeculation),
    'leaving a parallel conversation cancels speculation and preserves the foreground reply',
  );
  await stopGeneration(leavingParallelConv, leavingPrimary.assistantMessageId);
  await putSettings({ backgroundSwipeGeneration: false, parallelBackgroundSwipeGeneration: false });

  console.log('== conversation search ==');
  const found = await req<{ conversation: { id: number }; snippet: string | null }[]>(
    'GET',
    `/api/search?q=${encodeURIComponent('prefix check')}`,
  );
  assert(
    found.some((r) => r.conversation.id === conv2.id && r.snippet?.includes('prefix check')),
    'search finds conversation by message content with snippet',
  );
  const prefixFound = await req<{ conversation: { id: number } }[]>(
    'GET',
    `/api/search?q=${encodeURIComponent('prefi')}`,
  );
  assert(
    prefixFound.some((r) => r.conversation.id === conv2.id),
    'content search matches word prefixes',
  );
  const pctConv = await req<{ id: number }>('POST', '/api/conversations', {});
  const pctConv2 = await req<{ id: number }>('POST', '/api/conversations', {});
  await patchConversation(pctConv.id, { title: 'pct 100% marker' });
  await patchConversation(pctConv2.id, { title: 'pct 100x marker' });
  const pctFound = await req<{ conversation: { id: number } }[]>(
    'GET',
    `/api/search?q=${encodeURIComponent('100%')}`,
  );
  assert(
    pctFound.some((r) => r.conversation.id === pctConv.id) &&
      !pctFound.some((r) => r.conversation.id === pctConv2.id),
    'title search treats LIKE wildcards as literals',
  );

  const searchSeed = new DatabaseSync(join(dataDir, 'minitavern.db'));
  searchSeed.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN');
  let crowdedSearchId: number;
  let otherSearchId: number;
  try {
    const insertConversation = searchSeed.prepare(
      `INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)`,
    );
    const now = Date.now();
    crowdedSearchId = Number(
      insertConversation.run('crowded search fixture', now, now).lastInsertRowid,
    );
    otherSearchId = Number(
      insertConversation.run('other search fixture', now, now + 1).lastInsertRowid,
    );
    const insertMessage = searchSeed.prepare(
      `INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', ?, ?)`,
    );
    for (let i = 0; i < 501; i++) {
      insertMessage.run(crowdedSearchId, 'starvationneedle starvationneedle', now + i);
    }
    insertMessage.run(otherSearchId, 'starvationneedle', now + 502);
    searchSeed.exec('COMMIT');
  } catch (err) {
    searchSeed.exec('ROLLBACK');
    searchSeed.close();
    throw err;
  }
  try {
    const completeSearch = await req<{ conversation: { id: number } }[]>(
      'GET',
      `/api/search?q=starvationneedle`,
    );
    assert(
      completeSearch.some((result) => result.conversation.id === crowdedSearchId) &&
        completeSearch.some((result) => result.conversation.id === otherSearchId),
      'content search dedupes before limiting so one conversation cannot starve another',
    );
    const controlSearch = await fetch(`${BASE}/api/search?q=%00`);
    assert(controlSearch.status === 400, 'content search rejects unsupported control characters');
  } finally {
    searchSeed
      .prepare('DELETE FROM conversations WHERE id IN (?, ?)')
      .run(crowdedSearchId, otherSearchId);
    searchSeed.close();
  }

  console.log('== delete all conversations ==');
  const bulkDelete = await req<{ deleted: number }>('DELETE', '/api/conversations');
  assert(bulkDelete.deleted > 0, 'bulk delete reports the number of deleted conversations');
  assert(
    (await req<unknown[]>('GET', '/api/conversations')).length === 0,
    'bulk delete removes every conversation',
  );
  assert(
    (await fetch(`${BASE}${imageUrl}`)).status === 404,
    'bulk delete removes generated images',
  );
  const galleryAfterBulkDelete = await req<GalleryItem[]>('GET', '/api/gallery');
  assert(
    galleryAfterBulkDelete.some(
      (item) => item.id === savedGallery.item.id && item.sourceConversationId === null,
    ) &&
      galleryAfterBulkDelete.some((item) => item.id === galleryGenerated.id) &&
      galleryAfterBulkDelete.some((item) => item.id === individuallyDeletedGallery.item.id) &&
      (await fetch(`${BASE}${savedGalleryImageUrl}`)).status === 200 &&
      (await fetch(`${BASE}${generatedGalleryImageUrl}`)).status === 200 &&
      (await fetch(`${BASE}${individuallyDeletedGalleryUrl}`)).status === 200,
    'bulk conversation deletion leaves independently saved gallery images intact',
  );
  await req('DELETE', `/api/gallery/${individuallyDeletedGallery.item.id}`);
  assert(
    (await fetch(`${BASE}${individuallyDeletedGalleryUrl}`)).status === 404,
    'deleting one gallery item removes its independent image file',
  );
  await expectStatus('POST', '/api/gallery/bulk-delete', { ids: [] }, 400);
  const galleryBulkDelete = await req<{ deleted: number }>('POST', '/api/gallery/bulk-delete', {
    ids: [savedGallery.item.id, galleryGenerated.id],
  });
  assert(
    galleryBulkDelete.deleted === 2 &&
      (await req<GalleryItem[]>('GET', '/api/gallery')).length === 0 &&
      (await fetch(`${BASE}${savedGalleryImageUrl}`)).status === 404 &&
      (await fetch(`${BASE}${generatedGalleryImageUrl}`)).status === 404,
    'bulk deleting selected gallery items removes every row and owned image file',
  );

  ws.close();

  console.log('== optional password authentication ==');
  const authBase = await req<Settings>('GET', '/api/settings');
  const enableAuth = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: authBase.revision,
      accessPassword: 'correct horse battery staple',
    }),
  });
  assert(enableAuth.status === 200, 'an access password can be enabled in settings');
  const enablingCookie = enableAuth.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const enabledSettings = (await enableAuth.json()) as Settings;
  assert(
    enabledSettings.hasPassword &&
      !JSON.stringify(enabledSettings).includes('correct horse battery staple') &&
      enablingCookie.startsWith('minitavern_session='),
    'enabling a password returns only password status and an HTTP-only session',
  );

  const passwordRow = new DatabaseSync(join(dataDir, 'minitavern.db'));
  try {
    const stored = passwordRow
      .prepare("SELECT value FROM settings WHERE key = 'access_password_hash'")
      .get() as { value: string } | undefined;
    assert(
      stored?.value.startsWith('scrypt-v1$') &&
        !stored.value.includes('correct horse battery staple'),
      'the access password is stored as a salted scrypt hash',
    );
  } finally {
    passwordRow.close();
  }

  const unauthenticatedApi = await fetch(`${BASE}/api/conversations`);
  assert(unauthenticatedApi.status === 401, 'conversation API access requires a login session');
  const unauthenticatedImage = await fetch(`${BASE}${imageUrl}`);
  assert(unauthenticatedImage.status === 401, 'image downloads require a login session');
  const unauthenticatedAvatar = await fetch(`${BASE}${pngChar.avatar}`);
  assert(unauthenticatedAvatar.status === 401, 'avatar downloads require a login session');
  assert((await websocketHandshake(BASE)) === 401, 'WebSocket upgrades require a login session');

  const wrongLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong password' }),
  });
  assert(wrongLogin.status === 401, 'an incorrect access password is rejected');
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  assert(
    login.status === 200 && cookie.startsWith('minitavern_session='),
    'the correct access password creates a session',
  );
  const authModule = new URL('../server/src/auth.ts', import.meta.url).href;
  const freshProcessAuth = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { isRequestAuthenticated } = await import(process.env.AUTH_MODULE);
       process.stdout.write(isRequestAuthenticated({ headers: { cookie: process.env.AUTH_COOKIE }, socket: {} }) ? 'yes' : 'no');`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, AUTH_MODULE: authModule, AUTH_COOKIE: cookie },
      encoding: 'utf8',
    },
  );
  assert(
    freshProcessAuth === 'yes',
    'a login cookie remains valid in a fresh server process using the same database',
  );
  const sessionToken = cookie.slice(cookie.indexOf('=') + 1);
  const sessionDb = new DatabaseSync(join(dataDir, 'minitavern.db'), { readOnly: true });
  try {
    const persisted = sessionDb
      .prepare('SELECT token_hash, expires_at FROM auth_sessions')
      .all() as { token_hash: string; expires_at: number }[];
    assert(
      persisted.length >= 1 &&
        persisted.every(
          (session) =>
            session.token_hash !== sessionToken &&
            !session.token_hash.includes(sessionToken) &&
            session.expires_at > Date.now(),
        ),
      'persistent sessions store only unexpired token hashes',
    );
  } finally {
    sessionDb.close();
  }
  const authenticatedApi = await fetch(`${BASE}/api/conversations`, {
    headers: { cookie },
  });
  assert(
    authenticatedApi.status === 200 &&
      authenticatedApi.headers.get('cache-control')?.includes('no-store') === true,
    'the login session authorizes API access without cacheable private data',
  );
  const authenticatedImage = await fetch(`${BASE}${pngChar.avatar}`, { headers: { cookie } });
  assert(
    authenticatedImage.status === 200 &&
      authenticatedImage.headers.get('cache-control')?.includes('no-store') === true,
    'authenticated media is never cached across session changes',
  );
  assert(
    (await websocketHandshake(BASE, cookie)) === 'open',
    'the login session authorizes WebSocket access',
  );

  const currentProtected = await fetch(`${BASE}/api/settings`, { headers: { cookie } });
  const currentProtectedSettings = (await currentProtected.json()) as Settings;
  const disableAuth = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      expectedRevision: currentProtectedSettings.revision,
      accessPassword: null,
    }),
  });
  assert(disableAuth.status === 200, 'the access password can be removed in settings');
  const sessionsAfterDisable = new DatabaseSync(join(dataDir, 'minitavern.db'), {
    readOnly: true,
  });
  try {
    const count = sessionsAfterDisable.prepare('SELECT count(*) AS n FROM auth_sessions').get() as {
      n: number;
    };
    assert(count.n === 0, 'removing the access password revokes persisted sessions');
  } finally {
    sessionsAfterDisable.close();
  }
  const passwordFreeAgain = await fetch(`${BASE}/api/conversations`);
  assert(passwordFreeAgain.status === 200, 'removing the password restores password-free access');

  console.log(`\nALL ${passed} ASSERTIONS PASSED`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
