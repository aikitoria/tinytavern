// E2E mock for OpenAI completions and ComfyUI rendering, progress, and output cleanup.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';

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
const MOCK_JPEG = readFileSync(new URL('../../docs/chat.jpg', import.meta.url));
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
/** Next N /prompt submissions are rejected with a 500. */
let comfyFailPrompts = 0;
/** Next N accepted jobs fail during execution (error status in /history). */
let comfyFailRenders = 0;
const comfyJobs = new Map<string, { readyAt: number; fail: boolean; output: ComfyOutputKind }>();
let comfyHistoryRequests = 0;
let nextComfyOutput: ComfyOutputKind = 'png';
/** Output files the server asked ComfyUI to delete after downloading them. */
const comfyDeleted: { filename: string; subfolder: string; type: string }[] = [];

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/alt/v1/models')) {
    lastModelAuthorization = req.headers.authorization ?? null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-large' }, { id: 'mock-small' }] }));
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/control/fail-next')) {
    const count = Number(new URL(req.url, 'http://mock').searchParams.get('count'));
    failuresRemaining = Number.isSafeInteger(count) && count > 0 ? count : 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ failuresRemaining }));
    return;
  }
  if (req.method === 'POST' && req.url === '/control/terminal-without-newline') {
    terminalWithoutNewline = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ terminalWithoutNewline }));
    return;
  }
  if (req.method === 'POST' && req.url === '/control/reasoning-only') {
    reasoningOnly = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ reasoningOnly }));
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/control/token-delay-next')) {
    const ms = Number(new URL(req.url, 'http://mock').searchParams.get('ms'));
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 1000) {
      res.writeHead(400).end();
      return;
    }
    nextTokenMs = ms;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ nextTokenMs }));
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/control/die-after-content')) {
    dieAfterContent = new URL(req.url, 'http://mock').searchParams.get('content');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ dieAfterContent }));
    return;
  }
  if (req.method === 'GET' && req.url === '/control/last-workflow') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ workflow: lastComfyWorkflow, previewMethod: lastComfyPreviewMethod }));
    return;
  }
  if (req.method === 'GET' && req.url === '/control/last-model-authorization') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ authorization: lastModelAuthorization }));
    return;
  }
  if (req.method === 'GET' && req.url === '/control/last-completion') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ completion: lastCompletion }));
    return;
  }
  if (req.method === 'GET' && req.url === '/control/completions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ completions: completionLog }));
    return;
  }
  if (req.method === 'POST' && req.url === '/control/clear-completions') {
    completionLog.length = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ cleared: true }));
    return;
  }
  if (req.method === 'GET' && req.url === '/control/comfy-deleted') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ deleted: comfyDeleted }));
    return;
  }
  if (req.method === 'GET' && req.url === '/control/comfy-history-count') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ count: comfyHistoryRequests }));
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/control/comfy-fail-next')) {
    const url = new URL(req.url, 'http://mock');
    const count = Number(url.searchParams.get('count') ?? '1');
    const n = Number.isSafeInteger(count) && count > 0 ? count : 0;
    if (url.searchParams.get('stage') === 'render') comfyFailRenders = n;
    else comfyFailPrompts = n;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ comfyFailPrompts, comfyFailRenders }));
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/control/comfy-output-next')) {
    const kind = new URL(req.url, 'http://mock').searchParams.get('kind') as ComfyOutputKind;
    if (!Object.hasOwn(COMFY_OUTPUTS, kind)) {
      res.writeHead(400).end('unknown output kind');
      return;
    }
    nextComfyOutput = kind;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ nextComfyOutput }));
    return;
  }
  if (req.method === 'POST' && req.url === '/prompt') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed: {
        prompt: unknown;
        client_id?: string;
        extra_data?: { preview_method?: string };
      };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      lastComfyWorkflow = parsed.prompt;
      lastComfyPreviewMethod = parsed.extra_data?.preview_method ?? null;
      if (comfyFailPrompts > 0) {
        comfyFailPrompts--;
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock comfy submission failure' }));
        return;
      }
      // UUIDs avoid collisions in promptId-derived image filenames.
      const promptId = randomUUID();
      comfyJobs.set(promptId, {
        readyAt: Date.now() + 400,
        fail: comfyFailRenders > 0,
        output: nextComfyOutput,
      });
      nextComfyOutput = 'png';
      if (comfyFailRenders > 0) comfyFailRenders--;
      setTimeout(() => {
        for (const client of wss.clients) {
          client.send(
            JSON.stringify({ type: 'progress', data: { value: 1, max: 2, prompt_id: promptId } }),
          );
          if (parsed.extra_data?.preview_method === 'taesd') {
            const header = Buffer.alloc(8);
            header.writeUInt32BE(1, 0); // BinaryEventTypes.PREVIEW_IMAGE
            header.writeUInt32BE(1, 4); // JPEG
            client.send(Buffer.concat([header, MOCK_JPEG]));
          }
          client.send(
            JSON.stringify({ type: 'progress', data: { value: 2, max: 2, prompt_id: promptId } }),
          );
        }
      }, 100);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: promptId }));
    });
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/history/')) {
    comfyHistoryRequests++;
    const promptId = req.url.slice('/history/'.length);
    const job = comfyJobs.get(promptId);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (job == null || Date.now() < job.readyAt) {
      res.end('{}');
      return;
    }
    if (job.fail) {
      res.end(
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
      return;
    }
    res.end(
      JSON.stringify({
        [promptId]: {
          status: { status_str: 'success', completed: true },
          outputs: {
            '9': {
              images: [
                { filename: COMFY_OUTPUTS[job.output].filename, subfolder: '', type: 'output' },
              ],
            },
          },
        },
      }),
    );
    return;
  }
  if ((req.method === 'GET' || req.method === 'DELETE') && req.url?.startsWith('/view')) {
    // Match ComfyUI's strict file parameters to test the server's URL construction.
    const q = new URL(req.url, 'http://mock').searchParams;
    const output = Object.values(COMFY_OUTPUTS).find(
      (candidate) => candidate.filename === q.get('filename'),
    );
    if (!output || q.get('type') !== 'output' || q.get('subfolder') !== '') {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'DELETE') {
      // Record deletion only: later jobs reuse these output files.
      comfyDeleted.push({ filename: output.filename, subfolder: '', type: 'output' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
      return;
    }
    res.writeHead(200, { 'content-type': output.type });
    res.end(output.data);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    console.log('[mock] POST /v1/chat/completions');
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
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
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      const firstNonSystem = parsed.messages.findIndex((message) => message.role !== 'system');
      const conversational = parsed.messages.slice(
        firstNonSystem === -1 ? parsed.messages.length : firstNonSystem,
      );
      const invalidShape =
        parsed.messages.some(
          (message, index) =>
            typeof message.content !== 'string' ||
            (!message.content.trim() &&
              !(message.role === 'assistant' && message.reasoning_content?.trim())) ||
            (message.role === 'system' && firstNonSystem !== -1 && index >= firstNonSystem),
        ) ||
        conversational.some(
          (message, index) =>
            (message.role !== 'user' && message.role !== 'assistant') ||
            (index > 0 && message.role === conversational[index - 1]!.role),
        );
      if (invalidShape) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'User and assistant messages must alternate and be non-empty' }),
        );
        return;
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
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
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
        return;
      }
      if (failuresRemaining > 0) {
        failuresRemaining--;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'controlled mock failure' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const tokenMs = nextTokenMs ?? TOKEN_MS;
      nextTokenMs = null;
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      // Force retries to resume from partial output.
      if (dieAfterContent != null) {
        const partialContent = dieAfterContent;
        dieAfterContent = null;
        send({ choices: [{ delta: { reasoning_content: 'PARTIAL_RETRY_REASONING' } }] });
        setTimeout(() => {
          send({ choices: [{ delta: { content: partialContent } }] });
          setTimeout(() => res.socket?.destroy(), 50);
        }, 10);
        return;
      }
      if (reasoningOnly) {
        reasoningOnly = false;
        send({ choices: [{ delta: { reasoning_content: 'REASONING_ONLY_OUTPUT' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const system = parsed.messages[0]?.role === 'system' ? parsed.messages[0].content : '';
      const text =
        `You said: **"${lastUser?.content ?? '(nothing)'}"** — reply #${Math.floor(Math.random() * 1000)}.\n\n` +
        (system ? `> system: ${system.replaceAll('\n', ' · ')}\n\n` : '') +
        `${LOREM}\n\n\`\`\`js\nconsole.log('hello from the mock');\n\`\`\``;
      const words = text.split(/(?<=\s)/);
      const reasoning =
        'Thinking about the request… composing a demo answer with markdown and code. '.split(
          /(?<=\s)/,
        );
      let ri = 0;
      let wi = 0;
      const timer = setInterval(() => {
        if (ri < reasoning.length) {
          send({ choices: [{ delta: { reasoning_content: reasoning[ri++] } }] });
        } else if (wi < words.length) {
          send({ choices: [{ delta: { content: words[wi++] } }] });
        } else {
          if (terminalWithoutNewline) {
            terminalWithoutNewline = false;
            res.end(
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'TERMINAL_NO_NEWLINE' } }] })}`,
            );
            clearInterval(timer);
            return;
          }
          send({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 42, completion_tokens: words.length },
          });
          res.write('data: [DONE]\n\n');
          res.end();
          clearInterval(timer);
        }
      }, tokenMs);
      // 'close' on req fires once the body is consumed; the response signals disconnects.
      res.on('close', () => clearInterval(timer));
    });
    return;
  }
  res.writeHead(404).end();
});

// ComfyUI-style progress socket (any path; the real one uses /ws?clientId=…).
const wss = new WebSocketServer({ server });

server.listen(PORT, () => console.log(`mock openai listening on :${PORT}`));
