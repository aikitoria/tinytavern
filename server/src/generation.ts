import type { Conversation, Endpoint, GenMeta, Message } from '@minitavern/shared';
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

/** Tool prompts are route-time snapshots and tool rows never enter later chat
 * history, so they may safely overlap each other. Structural actions use this
 * stricter predicate when only a normal assistant stream should conflict. */
export function hasActiveNonToolGeneration(conversationId: number): boolean {
  for (const gen of active.values()) {
    if (gen.conversationId !== conversationId) continue;
    // A missing row is an unexpected transitional state; treat it as
    // conflicting rather than allowing a second kind of generation through.
    if (getMessage(gen.mid)?.role !== 'tool') return true;
  }
  return false;
}

/** Active message ids in one conversation. Used by structural mutations to
 * stop only streams whose rows are actually about to be removed. */
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

/** Marks a speculative stream as foreground once the user activates it. */
export function promoteBackgroundGeneration(mid: number): boolean {
  const gen = active.get(mid);
  if (!gen?.background) return false;
  gen.background = false;
  stmt("UPDATE messages SET generation_kind = 'normal' WHERE id = ?").run(mid);
  return true;
}

/** Stops speculative generations — one conversation's, or all when omitted.
 * Returns the stopped message id (meaningful for the single-conversation case). */
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
  // Identity check, not just key presence: `continue` reuses the message id,
  // so a late abort from a stopped generation must not touch its successor.
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
      message: getMessage(gen.mid)!,
    });
  }
  // Speculative fills never touch updated_at, so a conversation-list refetch
  // would be a no-op — don't make every client do one per background swipe.
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
 * Starts streaming an assistant response into the (status='streaming')
 * message `mid`. Server-owned: independent of any client connection. Every
 * upstream delta is forwarded immediately over WS; the DB gets periodic
 * flushes plus a final write.
 *
 * With `resumeFrom`, the existing content is kept and sent upstream as a
 * trailing assistant message (prefill-style continue); new tokens append.
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
      if (active.get(mid) !== gen) return; // already stopped/finalized (or superseded by a resume)
      // Transient upstream failures on foreground generations are retried in
      // place, resuming from the partial content. Background swipes have
      // their own retry loop in speculation.ts. Permanent errors (4xx, e.g.
      // context length exceeded) surface immediately.
      if (!gen.background && attempt < MAX_UPSTREAM_RETRIES && isTransientFailure(err, gen)) {
        // Disabled assistant prefills cannot carry either accumulated field.
        // Keeping those buffers and appending a fresh answer would corrupt the
        // message, so preserve the partial result as an error instead.
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

/** A wedged backend must not leave a message spinning forever. */
const IDLE_TIMEOUT_MS = 120_000;
const MAX_UPSTREAM_RETRIES = 2;

/** Per-conversation endpoint override first, then the global active endpoint.
 * A null conversation resolves the global active endpoint directly. */
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

/** Whether this conversation's endpoint can continue an existing assistant message. */
export function supportsAssistantContinuation(conversation: Conversation): boolean {
  return resolveEndpoint(conversation).prefillMode !== 'disabled';
}

/**
 * One-shot non-streaming completion for silent side tasks (auto-titling,
 * avatar prompt writing). Deliberately outside the generation machinery: no
 * message rows, no deltas, no retries — the caller decides what a failure
 * means. A null conversation uses the globally active endpoint.
 */
export async function chatCompletionOnce(
  conversation: Conversation | null,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<string> {
  const endpoint = resolveEndpoint(conversation);
  const res = await fetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
    },
    body: JSON.stringify({
      ...(endpoint.model ? { model: endpoint.model } : {}),
      messages,
      stream: false,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(30_000),
  });
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
  // Empty content has a few distinct causes worth naming: a moderation
  // refusal, a reasoning model that spent the whole token budget on
  // reasoning_content, or an upstream that returned nothing at all.
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
 * Streaming variant of chatCompletionOnce: relays content deltas to onDelta
 * as they arrive and resolves with the full text. Reasoning deltas are
 * skipped; the same refusal/empty diagnosis applies to the final text.
 */
export async function streamChatCompletion(
  conversation: Conversation | null,
  messages: ChatMessage[],
  maxTokens: number,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = resolveEndpoint(conversation);
  const res = await fetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
    },
    body: JSON.stringify({
      ...(endpoint.model ? { model: endpoint.model } : {}),
      messages,
      stream: true,
      max_tokens: maxTokens,
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upstream error ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!res.body) throw new Error('Upstream returned no response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let refusal = '';
  let sawReasoning = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data) as {
          choices?: {
            delta?: { content?: unknown; refusal?: unknown; reasoning_content?: unknown };
          }[];
        };
        const delta = json.choices?.[0]?.delta;
        if (typeof delta?.content === 'string' && delta.content) {
          content += delta.content;
          onDelta(delta.content);
        }
        if (typeof delta?.refusal === 'string') refusal += delta.refusal;
        if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
          sawReasoning = true;
        }
      } catch {
        // Keepalive comments and partial frames are skippable.
      }
    }
  }
  if (content.trim()) return content;
  if (refusal.trim()) throw new Error(`The model refused: ${refusal.trim().slice(0, 300)}`);
  if (sawReasoning) {
    throw new Error(
      'The model returned only reasoning and no message content (reasoning models may need a larger token budget)',
    );
  }
  throw new Error('The model returned an empty reply');
}

/** Retryable: network failures, upstream 5xx/429, and idle timeouts — not 4xx. */
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
  // Resolve mutable configuration and history exactly once. A retry belongs to
  // the same logical generation and must not silently switch endpoint, model,
  // parameters, template, character, or ancestor content midway through it.
  const context = (gen.requestContext ??= snapshotRequestContext(conversation, gen));
  const { endpoint, built } = context;
  gen.model = endpoint.model;

  // A fresh character reply starts with the template's assistant seed in both
  // the persisted buffers and the upstream trailing assistant message. A
  // retry/resume already carries the complete accumulated buffers, so never
  // apply the template twice. Disabled endpoints ignore all assistant seeds.
  if (endpoint.prefillMode !== 'disabled' && !isResume) {
    if (built.reasoningPrefill) gen.reasoning = built.reasoningPrefill;
    if (built.messagePrefill) gen.content = built.messagePrefill;
    if (built.reasoningPrefill || built.messagePrefill) gen.dirty = true;
  }

  // Copy the snapshotted list because continuation flags are added per attempt.
  const messages =
    endpoint.prefillMode === 'disabled'
      ? withDisabledPrefillSpeakerNote(built)
      : built.messages.map((message) => ({ ...message }));
  const namePrefill = built.namePrefill;
  // Prefill-style trailing assistant message (template seed, resumed content,
  // reasoning, and/or "Name:"). A reasoning-only prefill deliberately has an
  // empty content field: compatible reasoning APIs use reasoning_content to
  // decide that they should continue thinking rather than start the answer.
  // Not part of the official OpenAI spec — 'disabled' omits it entirely,
  // 'none' lets the backend interpret it without extra flags, and
  // 'vllm'/'deepseek' send their native continuation flags.
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
  const upstreamMessages: Record<string, unknown>[] = messages.map((m) => ({ ...m }));
  if (prefilled && endpoint.prefillMode === 'deepseek') {
    upstreamMessages[upstreamMessages.length - 1] = {
      ...upstreamMessages[upstreamMessages.length - 1],
      prefix: true,
    };
  }
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
    const res = await fetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...(endpoint.model ? { model: endpoint.model } : {}),
        messages: upstreamMessages,
        stream: true,
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
      }),
      signal: gen.abort.signal,
    });
    resetIdle();

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Upstream error ${res.status}: ${text.slice(0, 500)}`);
    }
    // Even when assistant prefills are disabled, prefixed history can teach the
    // model to emit "Name:" itself. Keep the expected prefix for output
    // normalization without adding it to the upstream request.
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
  // A reply is based on its ancestors, not whichever sibling happens to be
  // active. Tool generations already carry a fixed prompt override.
  const source =
    gen.promptOverride ??
    buildChatMessages(
      conversation,
      getPathToMessage(getMessage(gen.mid)?.parentId ?? null),
      // Regenerations keep the speaker name stamped on their sibling.
      getMessage(gen.mid)?.name ?? null,
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
  // Backends without real prefill support tend to echo the "Name:" prefix at
  // the start of their reply; hold back the first characters and strip it.
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

  const decoder = new TextDecoder();
  let buffer = '';
  const processLine = (rawLine: string): void => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let parsed: { choices?: { delta?: SseDelta }[] };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const delta = parsed.choices?.[0]?.delta;
    const d = delta?.content ?? undefined;
    const r = delta?.reasoning_content ?? delta?.reasoning ?? undefined;
    if (d == null && r == null) return;
    const dOut = d != null ? passContent(d) : '';
    if (dOut) gen.content += dOut;
    if (r) gen.reasoning += r;
    if (dOut || r) gen.dirty = true;
    if (active.get(gen.mid) !== gen || (!dOut && !r)) return;
    // Latency first: forward each delta the moment it arrives.
    broadcastConv(gen.conversationId, {
      t: 'delta',
      mid: gen.mid,
      ...(dOut ? { d: dOut } : {}),
      ...(r ? { r } : {}),
    });
  };
  try {
    for await (const chunk of body) {
      resetIdle();
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        processLine(line);
        if (active.get(gen.mid) !== gen) return; // stopped while iterating
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      for (const line of buffer.split('\n')) processLine(line);
    }
  } catch (err) {
    // The stream died mid-holdback: a transient retry resumes from
    // gen.content, so apply the same flush semantics as stream end or the
    // held-back characters are silently lost. A holdback equal to the full
    // prefill (case-insensitive) is dropped instead — the retry re-sends the
    // prefill itself.
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
  finalize(gen, 'done'); // no-op if already stopped/superseded
}
