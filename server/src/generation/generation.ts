import { readSseData, prepareChatMessages } from '@tinytavern/shared';
import { publicMessage } from '../media/mediaUrls.ts';
import type { Conversation, Endpoint, GenMeta, Message } from '@tinytavern/shared';
import { stmt, toEndpoint, toMessage, transaction } from '../db/db.ts';
import { getMessage, getPathToMessage } from '../conversations/tree.ts';
import { buildChatMessages } from './prompt.ts';
import type { BuiltPrompt, ChatMessage } from './prompt.ts';
import { getSettings } from '../settings/settingsStore.ts';
import { broadcastConv, invalidate } from '../realtime/events.ts';
import { bumpConversationRevision } from '../conversations/conversationRevision.ts';
import {
  generationParameters,
  prepareStandaloneCompletion,
  withEndpointSystemPrompt,
  endpointReasoningPrefill,
} from './completionConfig.ts';
import type { CompletionOptions } from './completionConfig.ts';
import { completionDataReader, startCompletionIdleWatchdog } from './completionStream.ts';

interface ActiveGen {
  mid: number;
  conversationId: number;
  content: string;
  reasoning: string;
  /** Unknown (null) until run() resolves the active endpoint. */
  model: string | null;
  abort: AbortController;
  meta: GenMeta;
  background: boolean;
  generationToken: number;
  /** Fixed upstream request (tool generations) instead of the chat history. */
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

function finalize(gen: ActiveGen, status: 'done' | 'error' | 'stopped'): void {
  // `continue` reuses message ids; late aborts must not touch a successor.
  if (active.get(gen.mid) !== gen) return;
  gen.content = gen.content.trim();
  gen.reasoning = gen.reasoning.trim();
  // Persist the body, terminal status, render flag, and revision in one commit.
  const finalized = transaction(() => {
    const row = stmt(
      `UPDATE messages SET content = ?, reasoning = ?, model = ?, status = ?, gen_meta_json = ?,
       image_pending = CASE WHEN ? = 'done' THEN image_pending ELSE 0 END
       WHERE id = ? RETURNING *`,
    ).get(
      gen.content,
      gen.reasoning || null,
      gen.model,
      status,
      JSON.stringify(gen.meta),
      status,
      gen.mid,
    ) as Record<string, unknown> | undefined;
    // A deleted message must never be recreated by a late stream callback.
    if (!row) return null;
    return {
      message: toMessage(row),
      mutationRevision: bumpConversationRevision(gen.conversationId),
    };
  });
  active.delete(gen.mid);
  if (finalized) {
    broadcastConv(gen.conversationId, {
      t: 'final',
      conversationId: gen.conversationId,
      mutationRevision: finalized.mutationRevision,
      message: publicMessage(finalized.message),
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

/** Graceful shutdown cancels and persists every active stream before SQLite closes. */
export function stopAllGenerations(): void {
  for (const mid of [...active.keys()]) stopGeneration(mid);
}

/**
 * Independent of client connections: forwards deltas immediately and persists only at finalization.
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
  const generationToken = transaction(() => {
    const token = bumpConversationRevision(conversation.id);
    stmt('UPDATE messages SET generation_token = ? WHERE id = ?').run(token, mid);
    return token;
  });
  const gen: ActiveGen = {
    mid,
    conversationId: conversation.id,
    content: resumeFrom?.content ?? '',
    reasoning: resumeFrom?.reasoning ?? '',
    model: null,
    abort: new AbortController(),
    meta: {},
    background: options?.background ?? false,
    generationToken,
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
      if (!gen.background && attempt < MAX_UPSTREAM_RETRIES && isTransientFailure(err)) {
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

const MAX_UPSTREAM_RETRIES = 2;

export function resolveEndpoint(conversation: Conversation | null): Endpoint {
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
      messages: withEndpointSystemPrompt(endpoint, messages),
      stream,
      ...parameters,
    }),
    signal,
  });
}

/** Chat and media prompts share cancellation, header/body deadlines and HTTP errors. */
async function readCompletion(
  endpoint: Endpoint,
  messages: ChatMessage[],
  parameters: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onData: (data: string) => void | boolean,
): Promise<void> {
  const abort = new AbortController();
  const idle = startCompletionIdleWatchdog((error) => abort.abort(error));
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  try {
    combined.throwIfAborted();
    const response = await completionRequest(endpoint, messages, true, parameters, combined);
    idle.touch();
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Upstream error ${response.status}: ${text.slice(0, 500)}`);
    }
    if (!response.body) throw new Error('Upstream returned no response body');
    await readSseData(response.body, onData, idle.touch);
  } catch (error) {
    if (abort.signal.aborted) throw abort.signal.reason;
    throw error;
  } finally {
    idle.stop();
  }
}

/**
 * Side-task completion without message rows or retries; callers handle failures.
 * A null conversation uses the global endpoint.
 */
export async function chatCompletionOnce(
  conversation: Conversation | null,
  messages: ChatMessage[],
  maxTokens: number,
  options?: Pick<CompletionOptions, 'reasoningPrefill'>,
): Promise<string> {
  const endpoint = resolveEndpoint(conversation);
  const prepared = prepareStandaloneCompletion(endpoint, messages, maxTokens, options);
  const res = await completionRequest(
    endpoint,
    prepared.messages,
    false,
    prepared.parameters,
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

interface StreamingCompletionOptions extends CompletionOptions {
  requireComplete?: boolean;
  onReasoning?: (text: string) => void;
}

/** Side-task completion keeps transient reasoning separate from the returned prompt. */
export async function streamChatCompletion(
  conversation: Conversation | null,
  messages: ChatMessage[],
  maxTokens: number,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  options?: StreamingCompletionOptions,
): Promise<string> {
  const endpoint = resolveEndpoint(conversation);
  return streamEndpointCompletion(endpoint, messages, maxTokens, onDelta, signal, options);
}

/** Execute a captured endpoint configuration; durable jobs require a complete reply. */
export async function streamEndpointCompletion(
  endpoint: Endpoint,
  messages: ChatMessage[],
  maxTokens: number,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  options?: StreamingCompletionOptions,
): Promise<string> {
  const prepared = prepareStandaloneCompletion(endpoint, messages, maxTokens, options);
  signal?.throwIfAborted();
  if (prepared.reasoningPrefill) options?.onReasoning?.(prepared.reasoningPrefill);
  let content = prepared.messagePrefill;
  let emittedPrefill = false;
  let emittedContent = false;
  let receivedVisibleContent = false;
  let refusal = '';
  let sawReasoning = false;
  let completed = false;
  let finishReason: string | null = null;
  await readCompletion(
    endpoint,
    prepared.messages,
    prepared.parameters,
    signal,
    completionDataReader(
      (delta, reasoning, rejected) => {
        if (delta) {
          emittedContent = true;
          if (!emittedPrefill && prepared.messagePrefill) {
            emittedPrefill = true;
            onDelta(prepared.messagePrefill);
          }
          if (delta.trim()) receivedVisibleContent = true;
          content += delta;
          onDelta(delta);
        }
        refusal += rejected;
        if (reasoning) {
          sawReasoning = true;
          if (!emittedContent) options?.onReasoning?.(reasoning);
        }
      },
      (reason) => {
        if (reason === null) completed = true;
        else finishReason = reason;
      },
    ),
  );
  if (options?.requireComplete && receivedVisibleContent) {
    if (finishReason === 'length') {
      throw new Error(
        'Prompt was truncated by the token limit; review the partial text or prepare again',
      );
    }
    const missingCompletion = !completed && !finishReason;
    const interruptedCompletion = finishReason && finishReason !== 'stop';
    if (missingCompletion || interruptedCompletion) {
      throw new Error('Prompt completion ended before a complete reply; review or prepare again');
    }
  }
  if (receivedVisibleContent) return content;
  if (refusal.trim()) throw new Error(`The model refused: ${refusal.trim().slice(0, 300)}`);
  if (sawReasoning) {
    throw new Error(
      'The model returned only reasoning and no message content (reasoning models may need a larger token budget)',
    );
  }
  throw new Error('The model returned an empty reply');
}

function isTransientFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('Upstream idle timeout')) return true;
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
  if (endpoint.prefillMode !== 'disabled') {
    gen.reasoning = endpointReasoningPrefill(
      endpoint,
      isResume ? gen.reasoning : built.reasoningPrefill,
      isResume,
    );
    if (!isResume && built.messagePrefill) gen.content = built.messagePrefill;
  }

  const { messages, prefilled } = prepareChatMessages(built, {
    prefillMode: endpoint.prefillMode,
    content: gen.content,
    reasoning: gen.reasoning,
  });
  const namePrefill = built.namePrefill;
  const p = endpoint.genParams;

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

  const processData = completionDataReader((d, r) => {
    const dOut = d ? passContent(d) : '';
    if (dOut) gen.content += dOut;
    if (r) gen.reasoning += r;
    if (active.get(gen.mid) !== gen || (!dOut && !r)) return;
    broadcastConv(gen.conversationId, {
      t: 'delta',
      mid: gen.mid,
      ...(dOut ? { d: dOut } : {}),
      ...(r ? { r } : {}),
    });
  });
  try {
    await readCompletion(
      endpoint,
      messages,
      {
        ...generationParameters(p),
        ...(prefilled && endpoint.prefillMode === 'vllm'
          ? { continue_final_message: true, add_generation_prompt: false }
          : {}),
      },
      gen.abort.signal,
      (data) => {
        if (active.get(gen.mid) !== gen) return false;
        processData(data);
        return active.get(gen.mid) === gen;
      },
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
