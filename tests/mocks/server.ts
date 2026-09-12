// Manual development mock for OpenAI completions and ComfyUI rendering, progress, and output cleanup.
import { randomUUID } from 'node:crypto';
import { previewJpeg as MOCK_JPEG } from '../support/videoPreview.ts';

const PORT = Number(process.env.PORT ?? 9800);

/** Keep >= ~3 ms so tests can act while generation is in flight. */
const TOKEN_MS = Number(process.env.MOCK_TOKEN_MS ?? (process.env.E2E_MOCK ? 3 : 15));

const LOREM =
  'Streaming works token by token, so latency stays low even through the relay. ' +
  'Branching, swiping and edits can all be exercised against this mock without a real model.';

// 1x1 transparent PNG.
const MOCK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const MOCK_WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
type ComfyOutputKind = 'png' | 'jpeg' | 'webp' | 'html' | 'svg' | 'polyglot';
const COMFY_OUTPUTS: Record<ComfyOutputKind, { filename: string; type: string; data: Buffer }> = {
  png: { filename: 'mock.png', type: 'image/png', data: MOCK_PNG },
  jpeg: { filename: 'mock.jpeg', type: 'image/jpeg', data: MOCK_JPEG },
  webp: { filename: 'mock.webp', type: 'image/webp', data: MOCK_WEBP },
  html: {
    filename: 'payload.html',
    type: 'text/html',
    data: Buffer.from('<script>parent.postMessage(document.origin, "*")</script>'),
  },
  svg: {
    filename: 'payload.svg',
    type: 'image/svg+xml',
    data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  },
  polyglot: {
    filename: 'payload.png',
    type: 'image/png',
    data: Buffer.concat([MOCK_PNG, Buffer.from('<script>alert(1)</script>')]),
  },
};

let failuresRemaining = 0;
let terminalWithoutNewline = false;
let reasoningOnly = false;
/** Slow one streaming response so e2e can exercise out-of-order completion. */
let nextTokenMs: number | null = null;
/** Next request streams this partial output, then dies mid-stream. */
let dieAfterContent: string | null = null;
let nextCompletionContent: string | null = null;
let lastComfyWorkflow: unknown = null;
let lastComfyPreviewMethod: string | null = null;
let lastModelAuthorization: string | null = null;
interface CompletionRecord {
  system: string | null;
  user: string | null;
  assistantMessages: string[];
  messages: { role: string; content: string; reasoning_content?: string; prefix?: boolean }[];
  model: string | null;
  hasModel: boolean;
  maxTokens: number | null;
  reasoningEffort: string | null;
  lastMessageRole: string | null;
  lastMessageContent: string | null;
  continueFinalMessage: boolean;
}
let lastCompletion: CompletionRecord | null = null;
const completionLog: CompletionRecord[] = [];
/** Next N /prompt submissions are rejected before acceptance with a 400. */
let comfyFailPrompts = 0;
/** Next N accepted jobs fail during execution (error status in /history). */
let comfyFailRenders = 0;
const comfyJobs = new Map<string, { readyAt: number; fail: boolean; output: ComfyOutputKind }>();
let comfyHistoryRequests = 0;
let nextComfyOutput: ComfyOutputKind = 'png';
/** Output files the server asked ComfyUI to delete after downloading them. */
const comfyDeleted: { filename: string; subfolder: string; type: string }[] = [];
const comfyCancelled: string[] = [];

const clients = new Set<import('bun').ServerWebSocket<undefined>>();
const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  websocket: {
    open(socket) {
      clients.add(socket);
    },
    close(socket) {
      clients.delete(socket);
    },
    message() {},
  },
  async fetch(req, server) {
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket' && server.upgrade(req, { data: undefined })) return;
    const parsedUrl = new URL(req.url);
    const path = parsedUrl.pathname + parsedUrl.search;
    let status = 200;
    let mime = 'application/json';
    const reply = (body?: string | Buffer) => new Response(body ?? null, { status, headers: { 'content-type': mime } });
    if (req.method === 'GET' && path === '/control/comfy-cancelled') {
      return reply(JSON.stringify({ ids: comfyCancelled }));
    }
    if (req.method === 'GET' && (path === '/v1/models' || path === '/alt/v1/models')) {
      lastModelAuthorization = req.headers.get('authorization') ?? null;
      return reply(JSON.stringify({ data: [{ id: 'mock-large' }, { id: 'mock-small' }] }));
    }
    if (req.method === 'POST' && path?.startsWith('/control/fail-next')) {
      const count = Number(new URL(path, 'http://mock').searchParams.get('count'));
      failuresRemaining = Number.isSafeInteger(count) && count > 0 ? count : 0;
      return reply(JSON.stringify({ failuresRemaining }));
    }
    if (req.method === 'POST' && path === '/control/terminal-without-newline') {
      terminalWithoutNewline = true;
      return reply(JSON.stringify({ terminalWithoutNewline }));
    }
    if (req.method === 'POST' && path === '/control/reasoning-only') {
      reasoningOnly = true;
      return reply(JSON.stringify({ reasoningOnly }));
    }
    if (req.method === 'POST' && path?.startsWith('/control/token-delay-next')) {
      const ms = Number(new URL(path, 'http://mock').searchParams.get('ms'));
      if (!Number.isSafeInteger(ms) || ms < 1 || ms > 1000) {
        status = 400;
        return reply();
      }
      nextTokenMs = ms;
      return reply(JSON.stringify({ nextTokenMs }));
    }
    if (req.method === 'POST' && path?.startsWith('/control/completion-next')) {
      nextCompletionContent = new URL(path, 'http://mock').searchParams.get('content');
      return reply(JSON.stringify({ ok: true }));
    }
    if (req.method === 'POST' && path?.startsWith('/control/die-after-content')) {
      dieAfterContent = new URL(path, 'http://mock').searchParams.get('content');
      return reply(JSON.stringify({ dieAfterContent }));
    }
    if (req.method === 'GET' && path === '/control/last-workflow') {
      return reply(JSON.stringify({ workflow: lastComfyWorkflow, previewMethod: lastComfyPreviewMethod }));
    }
    if (req.method === 'GET' && path === '/control/last-model-authorization') {
      return reply(JSON.stringify({ authorization: lastModelAuthorization }));
    }
    if (req.method === 'GET' && path === '/control/last-completion') {
      return reply(JSON.stringify({ completion: lastCompletion }));
    }
    if (req.method === 'GET' && path === '/control/completions') {
      return reply(JSON.stringify({ completions: completionLog }));
    }
    if (req.method === 'POST' && path === '/control/clear-completions') {
      completionLog.length = 0;
      return reply(JSON.stringify({ cleared: true }));
    }
    if (req.method === 'GET' && path === '/control/comfy-deleted') {
      return reply(JSON.stringify({ deleted: comfyDeleted }));
    }
    if (req.method === 'GET' && path === '/control/comfy-history-count') {
      return reply(JSON.stringify({ count: comfyHistoryRequests }));
    }
    if (req.method === 'POST' && path?.startsWith('/control/comfy-fail-next')) {
      const url = new URL(path, 'http://mock');
      const count = Number(url.searchParams.get('count') ?? '1');
      const n = Number.isSafeInteger(count) && count > 0 ? count : 0;
      if (url.searchParams.get('stage') === 'render') comfyFailRenders = n;
      else comfyFailPrompts = n;
      return reply(JSON.stringify({ comfyFailPrompts, comfyFailRenders }));
    }
    if (req.method === 'POST' && path?.startsWith('/control/comfy-output-next')) {
      const kind = new URL(path, 'http://mock').searchParams.get('kind') as ComfyOutputKind;
      if (!Object.hasOwn(COMFY_OUTPUTS, kind)) {
        status = 400;
        return reply('unknown output kind');
      }
      nextComfyOutput = kind;
      return reply(JSON.stringify({ nextComfyOutput }));
    }
    if (req.method === 'POST' && path === '/prompt') {
      const body = await req.text();
      let parsed: {
        prompt: unknown;
        prompt_id?: string;
        client_id?: string;
        extra_data?: { preview_method?: string };
      };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        status = 400;
        return reply(JSON.stringify({ error: 'invalid JSON' }));
      }
      lastComfyWorkflow = parsed.prompt;
      lastComfyPreviewMethod = parsed.extra_data?.preview_method ?? null;
      if (comfyFailPrompts > 0) {
        comfyFailPrompts--;
        status = 400;
        return reply(JSON.stringify({ error: 'mock comfy submission failure' }));
      }
      // Match Comfy's required UUID submission-ID protocol.
      const promptId = parsed.prompt_id ?? randomUUID();
      comfyJobs.set(promptId, {
        readyAt: Date.now() + 400,
        fail: comfyFailRenders > 0,
        output: nextComfyOutput,
      });
      nextComfyOutput = 'png';
      if (comfyFailRenders > 0) comfyFailRenders--;
      setTimeout(() => {
        for (const client of clients) {
          client.send(JSON.stringify({ type: 'progress', data: { value: 1, max: 2, prompt_id: promptId } }));
          if (parsed.extra_data?.preview_method === 'taesd') {
            const header = Buffer.alloc(8);
            header.writeUInt32BE(1, 0); // BinaryEventTypes.PREVIEW_IMAGE
            header.writeUInt32BE(1, 4); // JPEG
            client.send(Buffer.concat([header, MOCK_JPEG]));
          }
          client.send(JSON.stringify({ type: 'progress', data: { value: 2, max: 2, prompt_id: promptId } }));
        }
      }, 100);
      return reply(JSON.stringify({ prompt_id: promptId }));
    }
    if (req.method === 'GET' && path === '/queue') {
      const queued = [...comfyJobs].filter(([, job]) => Date.now() < job.readyAt);
      return reply(JSON.stringify({ queue_running: [], queue_pending: queued.map(([id]) => [1, id]) }));
    }
    if (req.method === 'POST' && /^\/api\/jobs\/[^/]+\/cancel$/.test(path ?? '')) {
      const id = path!.split('/')[3]!;
      const job = comfyJobs.get(id);
      const cancelled = Boolean(job && Date.now() < job.readyAt);
      if (cancelled) {
        comfyJobs.delete(id);
        comfyCancelled.push(id);
      }
      return reply(JSON.stringify({ cancelled }));
    }
    if (req.method === 'GET' && path?.startsWith('/history/')) {
      comfyHistoryRequests++;
      const promptId = path.slice('/history/'.length);
      const job = comfyJobs.get(promptId);
      if (job == null || Date.now() < job.readyAt) {
        return reply('{}');
      }
      if (job.fail) {
        return reply(
          JSON.stringify({
            [promptId]: {
              status: {
                status_str: 'error',
                completed: false,
                messages: [
                  [
                    'execution_error',
                    {
                      node_type: 'KSampler',
                      node_id: '3',
                      exception_type: 'RuntimeError',
                      exception_message: 'mock render explosion',
                    },
                  ],
                ],
              },
              outputs: {},
            },
          }),
        );
      }
      return reply(
        JSON.stringify({
          [promptId]: {
            status: { status_str: 'success', completed: true },
            outputs: {
              '9': {
                images: [{ filename: COMFY_OUTPUTS[job.output].filename, subfolder: '', type: 'output' }],
              },
            },
          },
        }),
      );
    }
    if ((req.method === 'GET' || req.method === 'DELETE') && path?.startsWith('/view')) {
      // Match ComfyUI's strict file parameters to test the server's URL construction.
      const q = new URL(path, 'http://mock').searchParams;
      const output = Object.values(COMFY_OUTPUTS).find((candidate) => candidate.filename === q.get('filename'));
      if (!output || q.get('type') !== 'output' || q.get('subfolder') !== '') {
        status = 404;
        return reply();
      }
      if (req.method === 'DELETE') {
        // Record deletion only: later jobs reuse these output files.
        comfyDeleted.push({ filename: output.filename, subfolder: '', type: 'output' });
        return reply(JSON.stringify({ deleted: true }));
      }
      mime = output.type;
      return reply(output.data);
    }
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      console.log('[mock] POST /v1/chat/completions');
      const body = await req.text();
      console.log('[mock] body received:', body.length, 'bytes');
      // Catch malformed JSON here so the event callback cannot crash the mock.
      let parsed: {
        model?: string;
        max_tokens?: number;
        messages: { role: string; content: string; reasoning_content?: string; prefix?: boolean }[];
        stream?: boolean;
        reasoning_effort?: string;
        continue_final_message?: boolean;
      };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        status = 400;
        return reply(JSON.stringify({ error: 'invalid JSON' }));
      }
      const firstNonSystem = parsed.messages.findIndex((message) => message.role !== 'system');
      const conversational = parsed.messages.slice(firstNonSystem === -1 ? parsed.messages.length : firstNonSystem);
      const invalidShape =
        parsed.messages.some(
          (message, index) =>
            typeof message.content !== 'string' ||
            (!message.content.trim() && !(message.role === 'assistant' && message.reasoning_content?.trim())) ||
            (message.role === 'system' && firstNonSystem !== -1 && index >= firstNonSystem),
        ) ||
        conversational.some(
          (message, index) =>
            (message.role !== 'user' && message.role !== 'assistant') ||
            (index > 0 && message.role === conversational[index - 1]!.role),
        );
      if (invalidShape) {
        status = 400;
        return reply(JSON.stringify({ error: 'User and assistant messages must alternate and be non-empty' }));
      }
      const lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user');
      lastCompletion = {
        system: parsed.messages.find((m) => m.role === 'system')?.content ?? null,
        user: lastUser?.content ?? null,
        assistantMessages: parsed.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.content),
        messages: parsed.messages,
        model: parsed.model ?? null,
        hasModel: Object.hasOwn(parsed, 'model'),
        maxTokens: parsed.max_tokens ?? null,
        reasoningEffort: parsed.reasoning_effort ?? null,
        lastMessageRole: parsed.messages.at(-1)?.role ?? null,
        lastMessageContent: parsed.messages.at(-1)?.content ?? null,
        continueFinalMessage: parsed.continue_final_message === true,
      };
      completionLog.push(lastCompletion);
      // Auto-title and other non-streaming calls must not consume streaming failure controls.
      if (parsed.stream === false) {
        return reply(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: `Mock title: ${(lastUser?.content ?? '(nothing)').slice(0, 40)}`,
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 42, completion_tokens: 8 },
          }),
        );
      }
      if (failuresRemaining > 0) {
        failuresRemaining--;
        status = 503;
        return reply(JSON.stringify({ error: 'controlled mock failure' }));
      }
      const tokenMs = nextTokenMs ?? TOKEN_MS;
      nextTokenMs = null;
      const partial = dieAfterContent;
      const onlyReasoning = reasoningOnly;
      dieAfterContent = null;
      reasoningOnly = false;
      const system = parsed.messages[0]?.role === 'system' ? parsed.messages[0].content : '';
      const text =
        nextCompletionContent ??
        `You said: **"${lastUser?.content ?? '(nothing)'}"** — reply #${Math.floor(Math.random() * 1000)}.\n\n` +
          (system ? `> system: ${system.replaceAll('\n', ' · ')}\n\n` : '') +
          `${LOREM}\n\n\`\`\`js\nconsole.log('hello from the mock');\n\`\`\``;
      nextCompletionContent = null;
      const words = text.split(/(?<=\s)/);
      const reasoning = 'Thinking about the request… composing a demo answer with markdown and code. '.split(/(?<=\s)/);
      const encoder = new TextEncoder();
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          const abort = () => {
            if (!closed) {
              closed = true;
              controller.close();
            }
          };
          req.signal.addEventListener('abort', abort, { once: true });
          const write = (frame: string) => {
            if (!closed) controller.enqueue(encoder.encode(frame));
          };
          const send = (obj: unknown) => write(`data: ${JSON.stringify(obj)}\n\n`);
          void (async () => {
            try {
              if (partial !== null) {
                send({ choices: [{ delta: { reasoning_content: 'PARTIAL_RETRY_REASONING' } }] });
                await Bun.sleep(10);
                send({ choices: [{ delta: { content: partial } }] });
                await Bun.sleep(50);
                if (!closed) {
                  closed = true;
                  controller.error(new Error('controlled disconnect'));
                }
                return;
              }
              if (onlyReasoning) send({ choices: [{ delta: { reasoning_content: 'REASONING_ONLY_OUTPUT' } }] });
              else {
                for (const token of reasoning) {
                  await Bun.sleep(tokenMs);
                  if (closed) return;
                  send({ choices: [{ delta: { reasoning_content: token } }] });
                }
                for (const token of words) {
                  await Bun.sleep(tokenMs);
                  if (closed) return;
                  send({ choices: [{ delta: { content: token } }] });
                }
                if (terminalWithoutNewline) {
                  terminalWithoutNewline = false;
                  write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'TERMINAL_NO_NEWLINE' } }] })}`);
                  return;
                }
              }
              send({
                choices: [{ delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 42, completion_tokens: words.length },
              });
              write('data: [DONE]\n\n');
            } finally {
              req.signal.removeEventListener('abort', abort);
              abort();
            }
          })();
        },
      });
      return new Response(bodyStream, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      });
    }
    return new Response(null, { status: 404 });
  },
});
console.log(`mock openai listening on :${server.port}`);
