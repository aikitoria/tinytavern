import { readSseData } from '@tinytavern/shared';
import { publicMessage } from './mediaUrls.ts';
import type { Conversation, Endpoint, GenMeta, Message } from '@tinytavern/shared';
import { stmt, toEndpoint } from './db.ts';
import { getMessage, getPathToMessage } from './tree.ts';
import { appendChatMessage, buildChatMessages, withDisabledPrefillSpeakerNote } from './prompt.ts';
import type { BuiltPrompt, ChatMessage } from './prompt.ts';
import { getSettings } from './settingsStore.ts';
import { broadcastConv, invalidate } from './events.ts';
import { bumpConversationRevision } from './conversationRevision.ts';

interface ActiveGen {
  mid: number;
  conversationId: number;
  content: string;
  reasoning: string;
  /** Unknown (null) until run() resolves the active endpoint. */
  model: string | null;
  abort: AbortController;
  flushTimer: NodeJS.Timeout;
  meta: GenMeta;
  background: boolean;
  generationToken: number;
  /** New tokens since the last periodic DB flush. */
  dirty: boolean;
  /** Fixed upstream request (plugin tool generations) instead of the chat history. */
  promptOverride?: BuiltPrompt;
  /** Immutable endpoint + prompt context reused by every upstream attempt. */
  requestContext?: {
    endpoint: Endpoint;
    built: BuiltPrompt;
  };
  onDone?: () => void;
  onError?: () => void;
}

const active = new Map<number, ActiveGen>();

/** Optionally exclude the active reply when checking capacity for its parallel swipe. */
export function hasActiveGeneration(conversationId: number, exceptMessageId?: number): boolean {
  for (const gen of active.values()) {
    if (gen.conversationId === conversationId && gen.mid !== exceptMessageId) return true;
  }
  return false;
}

/** Tool streams may overlap: prompts are snapshots and tool rows stay out of chat history. */
export function hasActiveNonToolGeneration(conversationId: number): boolean {
  for (const gen of active.values()) {
    if (gen.conversationId !== conversationId) continue;
    // Treat missing rows as conflicting to avoid overlapping unknown generations.
    if (getMessage(gen.mid)?.role !== 'tool') return true;
  }
  return false;
}

/** Lets structural mutations stop only streams whose rows will be removed. */
export function activeGenerationMessageIds(conversationId: number): number[] {
  return [...active.values()]
    .filter((gen) => gen.conversationId === conversationId)
    .map((gen) => gen.mid);
}

export function hasForegroundGeneration(conversationId: number): boolean {
  for (const gen of active.values()) {
    if (gen.conversationId === conversationId && !gen.background) return true;
  }
  return false;
}

export function isBackgroundGeneration(mid: number): boolean {
  return active.get(mid)?.background === true;
}

export function activeGenerationToken(mid: number): number | null {
  return active.get(mid)?.generationToken ?? null;
}

export function promoteBackgroundGeneration(mid: number): boolean {
  const gen = active.get(mid);
  if (!gen?.background) return false;
  gen.background = false;
  stmt("UPDATE messages SET generation_kind = 'normal' WHERE id = ?").run(mid);
  return true;
}

/** Omitting the conversation stops all; returns the last stopped message id. */
export function stopBackgroundGenerations(conversationId?: number): number | null {
  let stopped: number | null = null;
  for (const gen of [...active.values()]) {
    if (!gen.background) continue;
    if (conversationId != null && gen.conversationId !== conversationId) continue;
    stopGeneration(gen.mid);
    stopped = gen.mid;
  }
  return stopped;
}

/** Overlays in-flight stream buffers onto persisted rows so snapshots are current. */
export function mergeLiveBuffers(messages: Message[]): Message[] {
  if (active.size === 0) return messages;
  return messages.map((m) => {
    const gen = active.get(m.id);
    if (!gen) return m;
    return {
      ...m,
      content: gen.content,
      reasoning: gen.reasoning || m.reasoning,
      model: gen.model,
    };
  });
}

function flushToDb(gen: ActiveGen): void {
  if (!gen.dirty) return;
  gen.dirty = false;
  stmt('UPDATE messages SET content = ?, reasoning = ?, model = ? WHERE id = ?').run(
    gen.content,
    gen.reasoning || null,
    gen.model,
    gen.mid,
  );
}

function finalize(gen: ActiveGen, status: 'done' | 'error' | 'stopped'): void {
  // `continue` reuses message ids; late aborts must not touch a successor.
  if (active.get(gen.mid) !== gen) return;
  active.delete(gen.mid);
  clearInterval(gen.flushTimer);
  gen.content = gen.content.trim();
  gen.reasoning = gen.reasoning.trim();
  // The message may have been deleted mid-stream (cascade or explicit delete).
  const exists = stmt('SELECT id FROM messages WHERE id = ?').get(gen.mid);
  if (exists) {
    stmt(
      'UPDATE messages SET content = ?, reasoning = ?, model = ?, status = ?, gen_meta_json = ? WHERE id = ?',
    ).run(gen.content, gen.reasoning || null, gen.model, status, JSON.stringify(gen.meta), gen.mid);
    // A stopped/failed generation never starts its image render — drop the pending flag.
    if (status !== 'done') {
      stmt('UPDATE messages SET image_pending = 0 WHERE id = ? AND image_pending = 1').run(gen.mid);
    }
    const mutationRevision = bumpConversationRevision(gen.conversationId);
    broadcastConv(gen.conversationId, {
      t: 'final',
      conversationId: gen.conversationId,
      mutationRevision,
      message: publicMessage(getMessage(gen.mid)!),
    });
  }
  // Speculation leaves updated_at unchanged, so skip conversation-list refetches.
  if (!gen.background) invalidate('conversations');
  const callback = status === 'done' ? gen.onDone : status === 'error' ? gen.onError : undefined;
  if (callback) {
    queueMicrotask(() => {
      try {
        callback();
      } catch (err) {
        console.error(`[generation] ${status} callback failed:`, err);
      }
    });
  }
}

export function stopGeneration(mid: number): boolean {
  const gen = active.get(mid);
  if (!gen) return false;
  gen.abort.abort();
  finalize(gen, 'stopped');
  return true;
}

export function stopConversationGenerations(conversationId: number): void {
  for (const gen of [...active.values()]) {
    if (gen.conversationId === conversationId) {
      gen.abort.abort();
      finalize(gen, 'stopped');
    }
  }
}

interface SseDelta {
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
}

/**
 * Independent of client connections: forwards deltas immediately, batches DB writes.
 * `resumeFrom` sends existing content as an assistant prefill and appends new tokens.
 */
export function startGeneration(
  conversation: Conversation,
  mid: number,
  resumeFrom?: { content: string; reasoning: string },
  options?: {
    background?: boolean;
    prompt?: BuiltPrompt;
    onDone?: () => void;
    onError?: () => void;
  },
): void {
  const generationToken = bumpConversationRevision(conversation.id);
  stmt('UPDATE messages SET generation_token = ? WHERE id = ?').run(generationToken, mid);
  const gen: ActiveGen = {
    mid,
    conversationId: conversation.id,
    content: resumeFrom?.content ?? '',
    reasoning: resumeFrom?.reasoning ?? '',
    model: null,
    abort: new AbortController(),
    flushTimer: setInterval(() => flushToDb(gen), 500),
    meta: {},
    background: options?.background ?? false,
    generationToken,
    dirty: false,
    promptOverride: options?.prompt,
    onDone: options?.onDone,
    onError: options?.onError,
  };
  active.set(mid, gen);
  const isResumeInitially = resumeFrom != null;
  const launch = (attempt: number): void => {
    run(
      conversation,
      gen,
      isResumeInitially || gen.content.length > 0 || gen.reasoning.length > 0,
    ).catch((err: unknown) => {
      if (active.get(mid) !== gen) return;
      // Foreground retries resume partial content; speculation.ts owns background retries.
      if (!gen.background && attempt < MAX_UPSTREAM_RETRIES && isTransientFailure(err, gen)) {
        // Without prefills, retrying would append a fresh answer to the partial result.
        if (
          gen.requestContext?.endpoint.prefillMode === 'disabled' &&
          (gen.content.length > 0 || gen.reasoning.length > 0)
        ) {
          gen.meta.error ??= err instanceof Error ? err.message : String(err);
          finalize(gen, 'error');
          return;
        }
        const reason = gen.meta.error ?? (err instanceof Error ? err.message : String(err));
        console.warn(
          `[generation] transient upstream failure for message ${mid} (${reason}), retry ${attempt + 1}/${MAX_UPSTREAM_RETRIES}`,
        );
        gen.meta.error = undefined;
        gen.abort = new AbortController();
        setTimeout(
          () => {
            if (active.get(mid) === gen) launch(attempt + 1);
          },
          1000 * (attempt + 1),
        );
        return;
      }
      // May already carry a specific message (e.g. idle timeout).
      gen.meta.error ??= err instanceof Error ? err.message : String(err);
      finalize(gen, 'error');
    });
  };
  launch(0);
}

const IDLE_TIMEOUT_MS = 120_000;
const MAX_UPSTREAM_RETRIES = 2;

function resolveEndpoint(conversation: Conversation | null): Endpoint {
  const endpointId = conversation?.endpointId ?? getSettings().activeEndpointId;
  const endpointRow = endpointId
    ? (stmt('SELECT * FROM endpoints WHERE id = ?').get(endpointId) as
        Record<string, unknown> | undefined)
    : undefined;
  if (!endpointRow) {
    throw new Error('No active endpoint — pick one in Settings → General');
  }
  return toEndpoint(endpointRow);
}

export function supportsAssistantContinuation(conversation: Conversation): boolean {
  return resolveEndpoint(conversation).prefillMode !== 'disabled';
}

/** Shared wire construction; callers retain their own deadlines and retry policy. */
function completionRequest(
  endpoint: Endpoint,
  messages: ChatMessage[],
  stream: boolean,
  parameters: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
    },
    body: JSON.stringify({
      ...(endpoint.model ? { model: endpoint.model } : {}),
      messages,
      stream,
      ...parameters,
    }),
    signal,
  });
}

/**
 * Side-task completion without message rows or retries; callers handle failures.
 * A null conversation uses the global endpoint.
 */
export async function chatCompletionOnce(
  conversation: Conversation | null,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<string> {
  const endpoint = resolveEndpoint(conversation);
  const res = await completionRequest(
    endpoint,
    messages,
    false,
    { max_tokens: maxTokens },
    AbortSignal.timeout(30_000),
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upstream error ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: unknown; refusal?: unknown; reasoning_content?: unknown } }[];
  };
  const message = json.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (typeof message?.refusal === 'string' && message.refusal.trim()) {
    throw new Error(`The model refused: ${message.refusal.trim().slice(0, 300)}`);
  }
  if (typeof message?.reasoning_content === 'string' && message.reasoning_content.trim()) {
    throw new Error(
      'The model returned only reasoning and no message content (reasoning models may need a larger token budget)',
    );
  }
  throw new Error('The model returned an empty reply');
}

/**
 * Side-task streaming completion: emits content deltas and returns the full text.
 * Reasoning is skipped; refusal and empty replies are errors.
 */
export async function streamChatCompletion(
  conversation: Conversation | null,
  messages: ChatMessage[],
  maxTokens: number,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = resolveEndpoint(conversation);
  const res = await completionRequest(
    endpoint,
    messages,
    true,
    { max_tokens: maxTokens },
    signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upstream error ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!res.body) throw new Error('Upstream returned no response body');
  let content = '';
  let refusal = '';
  let sawReasoning = false;
  await readSseData(res.body, (data) => {
    if (!data || data === '[DONE]') return;
    let json: {
      choices?: { delta?: { content?: unknown; refusal?: unknown; reasoning_content?: unknown } }[];
    };
    try {
      json = JSON.parse(data);
    } catch {
      return; // Ignore malformed upstream frames.
    }
    const delta = json?.choices?.[0]?.delta;
    if (typeof delta?.content === 'string' && delta.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    if (typeof delta?.refusal === 'string') refusal += delta.refusal;
    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
      sawReasoning = true;
    }
  });
  if (content.trim()) return content;
  if (refusal.trim()) throw new Error(`The model refused: ${refusal.trim().slice(0, 300)}`);
  if (sawReasoning) {
    throw new Error(
      'The model returned only reasoning and no message content (reasoning models may need a larger token budget)',
    );
  }
  throw new Error('The model returned an empty reply');
}

function isTransientFailure(err: unknown, gen: ActiveGen): boolean {
  if (gen.meta.error?.startsWith('Upstream idle timeout')) return true;
  const message = err instanceof Error ? err.message : String(err);
  const status = message.match(/^Upstream error (\d{3})/);
  if (status) {
    const code = Number(status[1]);
    return code >= 500 || code === 429;
  }
  return err instanceof TypeError; // fetch network-level failure
}

async function run(conversation: Conversation, gen: ActiveGen, isResume: boolean): Promise<void> {
  // Retries must reuse the original configuration and history.
  const context = (gen.requestContext ??= snapshotRequestContext(conversation, gen));
  const { endpoint, built } = context;
  gen.model = endpoint.model;

  // Seed fresh replies only; retries/resumes already carry the template in their buffers.
  if (endpoint.prefillMode !== 'disabled' && !isResume) {
    if (built.reasoningPrefill) gen.reasoning = built.reasoningPrefill;
    if (built.messagePrefill) gen.content = built.messagePrefill;
    if (built.reasoningPrefill || built.messagePrefill) gen.dirty = true;
  }

  // Copy the snapshotted list because continuation flags are added per attempt.
  const messages: (ChatMessage & { prefix?: boolean })[] =
    endpoint.prefillMode === 'disabled'
      ? withDisabledPrefillSpeakerNote(built)
      : built.messages.map((message) => ({ ...message }));
  const namePrefill = built.namePrefill;
  // Reasoning-only prefills keep content empty so compatible APIs continue thinking.
  // Continuation is nonstandard: vLLM/DeepSeek require backend-specific flags.
  let prefilled = false;
  if (
    endpoint.prefillMode !== 'disabled' &&
    (isResume || built.reasoningPrefill || built.messagePrefill) &&
    (gen.content.length > 0 || gen.reasoning.length > 0)
  ) {
    appendChatMessage(messages, {
      role: 'assistant',
      content: namePrefill
        ? gen.content
          ? `${namePrefill} ${gen.content}`
          : namePrefill
        : gen.content,
      ...(gen.reasoning ? { reasoning_content: gen.reasoning } : {}),
    });
    prefilled = true;
  } else if (endpoint.prefillMode !== 'disabled' && namePrefill) {
    appendChatMessage(messages, { role: 'assistant', content: namePrefill });
    prefilled = true;
  }
  if (prefilled && endpoint.prefillMode === 'deepseek') messages.at(-1)!.prefix = true;
  const p = endpoint.genParams;

  // Idle watchdog: abort if the backend goes silent (including before headers).
  const onIdle = () => {
    gen.meta.error = `Upstream idle timeout — no data received for ${IDLE_TIMEOUT_MS / 1000}s`;
    gen.abort.abort();
  };
  let idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
  };

  try {
    const res = await completionRequest(
      endpoint,
      messages,
      true,
      {
        ...(p.temperature != null ? { temperature: p.temperature } : {}),
        ...(p.topP != null ? { top_p: p.topP } : {}),
        ...(p.minP != null ? { min_p: p.minP } : {}),
        ...(p.maxTokens != null ? { max_tokens: p.maxTokens } : {}),
        ...(p.frequencyPenalty != null ? { frequency_penalty: p.frequencyPenalty } : {}),
        ...(p.presencePenalty != null ? { presence_penalty: p.presencePenalty } : {}),
        ...(p.reasoningEffort != null ? { reasoning_effort: p.reasoningEffort } : {}),
        ...(prefilled && endpoint.prefillMode === 'vllm'
          ? { continue_final_message: true, add_generation_prompt: false }
          : {}),
      },
      gen.abort.signal,
    );
    resetIdle();

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Upstream error ${res.status}: ${text.slice(0, 500)}`);
    }
    // Prefixed history can cause "Name:" echoes even with prefills disabled.
    await consumeStream(res.body, gen, namePrefill, isResume, resetIdle);
  } finally {
    clearTimeout(idleTimer);
  }
}

function snapshotRequestContext(
  conversation: Conversation,
  gen: ActiveGen,
): NonNullable<ActiveGen['requestContext']> {
  const resolved = resolveEndpoint(conversation);
  const endpoint: Endpoint = {
    ...resolved,
    genParams: { ...resolved.genParams },
  };
  // Use this reply's ancestors, regardless of the currently active sibling.
  const message = gen.promptOverride ? null : getMessage(gen.mid);
  const source =
    gen.promptOverride ??
    buildChatMessages(
      conversation,
      getPathToMessage(message?.parentId ?? null),
      // Regenerations keep the speaker name stamped on their sibling.
      message?.name ?? null,
    );
  const built: BuiltPrompt = {
    ...source,
    messages: source.messages.map((message) => ({ ...message })),
  };
  return { endpoint, built };
}

async function consumeStream(
  body: NonNullable<Awaited<ReturnType<typeof fetch>>['body']>,
  gen: ActiveGen,
  namePrefill: string | null,
  isResume: boolean,
  resetIdle: () => void,
): Promise<void> {
  // Hold initial characters to strip echoed "Name:" prefixes.
  let holdback: string | null = namePrefill && !isResume ? '' : null;
  const passContent = (d: string): string => {
    if (holdback == null) return d;
    holdback += d;
    const probe = holdback.trimStart();
    const target = namePrefill!;
    if (probe.length < target.length && target.toLowerCase().startsWith(probe.toLowerCase())) {
      return ''; // still ambiguous, keep holding
    }
    const out = probe.toLowerCase().startsWith(target.toLowerCase())
      ? probe.slice(target.length).replace(/^[ \t]+/, '')
      : holdback;
    holdback = null;
    return out;
  };

  const processData = (data: string): void => {
    if (!data || data === '[DONE]') return;
    let parsed: { choices?: { delta?: SseDelta }[] };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const delta = parsed?.choices?.[0]?.delta;
    const d = delta?.content ?? undefined;
    const r = delta?.reasoning_content ?? delta?.reasoning ?? undefined;
    if (d == null && r == null) return;
    const dOut = d != null ? passContent(d) : '';
    if (dOut) gen.content += dOut;
    if (r) gen.reasoning += r;
    if (dOut || r) gen.dirty = true;
    if (active.get(gen.mid) !== gen || (!dOut && !r)) return;
    broadcastConv(gen.conversationId, {
      t: 'delta',
      mid: gen.mid,
      ...(dOut ? { d: dOut } : {}),
      ...(r ? { r } : {}),
    });
  };
  try {
    await readSseData(
      body,
      (data) => {
        if (active.get(gen.mid) !== gen) return false;
        processData(data);
        return active.get(gen.mid) === gen;
      },
      resetIdle,
    );
  } catch (err) {
    // Preserve held text for retries, except an exact name prefill that the retry re-sends.
    if (holdback?.trim() && active.get(gen.mid) === gen) {
      const probe = holdback.trimStart();
      if (probe.toLowerCase() !== namePrefill!.toLowerCase()) {
        gen.content += holdback;
        broadcastConv(gen.conversationId, { t: 'delta', mid: gen.mid, d: holdback });
      }
    }
    throw err;
  }
  // A reply shorter than the name prefix may still be held back — flush it.
  if (holdback?.trim() && active.get(gen.mid) === gen) {
    gen.content += holdback;
    broadcastConv(gen.conversationId, { t: 'delta', mid: gen.mid, d: holdback });
  }
  finalize(gen, 'done');
}
