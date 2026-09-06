import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { expandWorkflowTemplate, workflowValidationError } from '@tinytavern/shared';
import { stmt } from './db.ts';
import { getMessage, markMessageDirty } from './tree.ts';
import { broadcastTree } from './sync.ts';
import { broadcastConv, invalidate } from './events.ts';
import { deleteImageFiles, rasterImageFormat, saveImage } from './images.ts';
import { bumpConversationRevision } from './conversationRevision.ts';

const RENDER_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = Number(process.env.COMFY_POLL_MS ?? (process.env.E2E_BASE ? 100 : 1500));
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;

/** ComfyUI binary event ids (protocol.py). Legacy preview frames are:
 * event u32, image type u32, encoded raster bytes. Metadata frames are:
 * event u32, metadata length u32, metadata JSON, encoded raster bytes. */
const COMFY_PREVIEW_IMAGE = 1;
const COMFY_PREVIEW_IMAGE_WITH_METADATA = 4;

function parsePreviewFrame(frame: Buffer): string | null {
  if (frame.length < 9) return null;
  const event = frame.readUInt32BE(0);
  let image: Buffer;
  if (event === COMFY_PREVIEW_IMAGE) {
    image = frame.subarray(8);
  } else if (event === COMFY_PREVIEW_IMAGE_WITH_METADATA) {
    const metadataLength = frame.readUInt32BE(4);
    const imageOffset = 8 + metadataLength;
    if (imageOffset > frame.length) return null;
    image = frame.subarray(imageOffset);
  } else {
    return null;
  }
  if (image.length === 0 || image.length > MAX_PREVIEW_BYTES) return null;
  const format = rasterImageFormat(image);
  return format ? `data:${format.mime};base64,${image.toString('base64')}` : null;
}

export interface RenderJob {
  conversationId: number;
  mid: number;
  comfyUrl: string;
  /** Workflow JSON template with {{prompt}}/{{seed}} slots. */
  workflow: string;
  /** The generated image description substituted into {{prompt}}. */
  description: string;
  signal?: AbortSignal;
}

/** Reject invalid workflows at route/save time before rendering starts. */
export function parseImageConfig(raw: unknown): { workflow: string; comfyUrl: string } {
  const obj =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const workflow = typeof obj.workflow === 'string' ? obj.workflow : '';
  if (!workflow.trim()) throw new Error('image.workflow is required');
  const invalid = workflowValidationError(workflow);
  if (invalid) throw new Error(`image.workflow ${invalid}`);
  const comfyUrl =
    typeof obj.comfyUrl === 'string' && obj.comfyUrl.trim()
      ? obj.comfyUrl.trim()
      : 'http://comfy:8588';
  return { workflow, comfyUrl };
}

interface ComfyOutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

interface ComfyHistoryEntry {
  status?: {
    status_str?: string;
    completed?: boolean;
    /** [kind, payload] tuples; execution_error payloads carry node tracebacks. */
    messages?: [string, Record<string, unknown>][];
  };
  outputs?: Record<string, { images?: ComfyOutputFile[]; gifs?: ComfyOutputFile[] }>;
}

/** Best-effort cleanup after download; our copy is the durable one. */
function deleteRemoteOutput(base: string, params: URLSearchParams): void {
  void fetch(`${base}/view?${params}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => {
      if (!res.ok && res.status !== 404) {
        console.warn(`[comfy] DELETE ${params.get('filename')} failed (${res.status})`);
      }
    })
    .catch((err: unknown) => {
      console.warn(
        `[comfy] DELETE ${params.get('filename')} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

/** Best-effort progress socket; rendering works without it (polling drives completion). */
function openProgressSocket(
  base: string,
  clientId: string,
  onProgress: RenderRequest['onProgress'],
  onPreview: RenderRequest['onPreview'],
  signal?: AbortSignal,
): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?clientId=${clientId}`);
    } catch {
      resolve(null);
      return;
    }
    // A socket opening after we resolve null has no owner and must be terminated.
    let settled = false;
    const onAbort = () => {
      settled = true;
      clearTimeout(settle);
      ws.terminate();
      resolve(null);
    };
    const settle = setTimeout(() => {
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      ws.terminate();
      resolve(null);
    }, 2000);
    // `terminate()` on a socket that has not connected emits `error`; install
    // the handler before honoring an already-aborted signal.
    ws.on('error', () => {
      clearTimeout(settle);
      signal?.removeEventListener('abort', onAbort);
      resolve(null);
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    ws.on('open', () => {
      if (settled) {
        ws.terminate();
        return;
      }
      clearTimeout(settle);
      signal?.removeEventListener('abort', onAbort);
      resolve(ws);
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const frame = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : Buffer.from(raw);
        const preview = parsePreviewFrame(frame);
        if (preview) onPreview?.(preview);
        return;
      }
      try {
        const ev = JSON.parse(String(raw)) as {
          type?: string;
          data?: { value?: number; max?: number };
        };
        if (ev.type === 'progress' && typeof ev.data?.value === 'number' && ev.data.max) {
          onProgress?.(ev.data.value, ev.data.max);
        }
      } catch {
        /* Malformed JSON events are ignored. */
      }
    });
  });
}

export interface RenderRequest {
  comfyUrl: string;
  /** Workflow JSON template with {{prompt}}/{{seed}} slots. */
  workflow: string;
  /** The text substituted into {{prompt}}. */
  prompt: string;
  /** The renderer owns the job-scoped progress socket. */
  onProgress?: (value: number, max: number) => void;
  onPreview?: (dataUrl: string) => void;
  /** Cancels submission, polling, download and response-body reads. */
  signal?: AbortSignal;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Render without message persistence or broadcasts. */
export async function renderToBuffer(
  request: RenderRequest,
): Promise<{ ext: string; data: Buffer; promptId: string }> {
  request.signal?.throwIfAborted();
  if (!request.prompt.trim()) throw new Error('empty image description');
  const workflowObj: unknown = JSON.parse(
    expandWorkflowTemplate(
      request.workflow,
      request.prompt,
      Math.floor(Math.random() * 0xffff_ffff),
    ),
  );
  const base = request.comfyUrl.replace(/\/+$/, '');
  const clientId = randomUUID();
  const ws =
    request.onProgress || request.onPreview
      ? await openProgressSocket(
          base,
          clientId,
          request.onProgress,
          request.onPreview,
          request.signal,
        )
      : null;
  try {
    const submit = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: workflowObj,
        client_id: clientId,
        // ComfyUI's frontend preview setting does not apply to API submissions.
        extra_data: { preview_method: 'taesd' },
      }),
      signal: withTimeout(request.signal, 30_000),
    }).catch((err: unknown) => {
      request.signal?.throwIfAborted();
      // Node's "fetch failed" hides the network error in cause.
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(
        `ComfyUI unreachable at ${base}: ${cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err))}`,
      );
    });
    if (!submit.ok) {
      const text = await submit.text().catch(() => '');
      throw new Error(`ComfyUI rejected the workflow (${submit.status}): ${text.slice(0, 300)}`);
    }
    const { prompt_id: promptId } = (await submit.json()) as { prompt_id: string };
    if (!promptId) throw new Error('ComfyUI returned no prompt id');

    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    let outputs: ComfyHistoryEntry['outputs'];
    while (!outputs) {
      if (Date.now() > deadline) throw new Error('ComfyUI render timed out');
      await sleep(POLL_INTERVAL_MS, undefined, { signal: request.signal });
      const res = await fetch(`${base}/history/${promptId}`, {
        signal: withTimeout(request.signal, 10_000),
      }).catch(() => {
        request.signal?.throwIfAborted();
        return null;
      });
      if (!res?.ok) continue;
      const history = (await res.json()) as Record<string, ComfyHistoryEntry>;
      const entry = history[promptId];
      if (!entry) continue;
      if (entry.status?.status_str === 'error') {
        const details = (entry.status.messages ?? [])
          .filter((message) => message[0] === 'execution_error')
          .map((message) => message[1])
          .map((d) => `${d.node_type} [${d.node_id}] ${d.exception_type}: ${d.exception_message}`)
          .join('; ');
        throw new Error(`ComfyUI workflow execution failed${details ? `: ${details}` : ''}`);
      }
      if (entry.outputs && Object.keys(entry.outputs).length > 0) outputs = entry.outputs;
      // Workflows without output nodes finish with empty outputs.
      else if (entry.status?.completed) throw new Error('ComfyUI produced no output image');
    }

    // Fall back to preview/temp and animated files for workflows without saved outputs.
    const files = Object.values(outputs).flatMap((node) => [
      ...(node.images ?? []),
      ...(node.gifs ?? []),
    ]);
    const image = files.find((file) => file.type === 'output') ?? files[0];
    if (!image) throw new Error('ComfyUI produced no output image');

    const params = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder,
      type: image.type,
    });
    const download = await fetch(`${base}/view?${params}`, {
      signal: withTimeout(request.signal, 60_000),
    });
    if (!download.ok) throw new Error(`failed to download image (${download.status})`);
    // Bound memory use even when content-length is absent or incorrect.
    const declared = Number(download.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new Error(`rendered image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of download.body!) {
      request.signal?.throwIfAborted();
      size += chunk.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        throw new Error(`rendered image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`);
      }
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks);
    // Clean up asynchronously so the DELETE round trip doesn't delay image display.
    deleteRemoteOutput(base, params);
    const format = rasterImageFormat(data);
    if (!format) throw new Error('ComfyUI returned an unsupported or invalid raster image');
    return { ext: format.ext, data, promptId };
  } catch (err) {
    // Preserve the caller's abort reason when timer cancellation throws AbortError.
    request.signal?.throwIfAborted();
    throw err;
  } finally {
    ws?.close();
  }
}

async function render(job: RenderJob): Promise<void> {
  const { ext, data, promptId } = await renderToBuffer({
    comfyUrl: job.comfyUrl,
    workflow: job.workflow,
    prompt: job.description,
    signal: job.signal,
    onProgress: (value, max) =>
      broadcastConv(job.conversationId, {
        t: 'imageProgress',
        conversationId: job.conversationId,
        mid: job.mid,
        value,
        max,
      }),
    onPreview: (preview) =>
      broadcastConv(job.conversationId, {
        t: 'imageProgress',
        conversationId: job.conversationId,
        mid: job.mid,
        preview,
      }),
  });
  const url = saveImage(`msg-${job.mid}-${promptId.slice(0, 8)}${ext}`, data);
  // Deletion or reset during rendering invalidates the downloaded file.
  const row = stmt(
    'SELECT images_json, gen_meta_json FROM messages WHERE id = ? AND image_pending = 1',
  ).get(job.mid) as { images_json: string; gen_meta_json: string | null } | undefined;
  if (!row) {
    deleteImageFiles([url]);
    return;
  }
  const images = [...(JSON.parse(row.images_json) as string[]), url];
  const meta = row.gen_meta_json
    ? (JSON.parse(row.gen_meta_json) as Record<string, unknown>)
    : null;
  if (meta) delete meta.imageError;
  stmt(
    'UPDATE messages SET images_json = ?, active_image = ?, image_pending = 0, gen_meta_json = ? WHERE id = ?',
  ).run(JSON.stringify(images), images.length - 1, meta ? JSON.stringify(meta) : null, job.mid);
  // Completed renders, including alternatives, bump sidebar recency;
  // submissions, cancellations and failures must not.
  stmt('UPDATE conversations SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?').run(
    Date.now(),
    job.conversationId,
  );
  bumpConversationRevision(job.conversationId);
  markMessageDirty(job.conversationId, job.mid);
  broadcastTree(job.conversationId);
  invalidate('conversations');
}

/** Fire-and-forget; failures surface as genMeta.imageError. */
export function startImageRender(job: RenderJob): void {
  render(job).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[comfy] render failed for message ${job.mid}: ${message}`);
    const row = getMessage(job.mid);
    if (!row) return;
    const meta = JSON.stringify({ ...(row.genMeta ?? {}), imageError: message });
    stmt(
      'UPDATE messages SET image_pending = 0, gen_meta_json = ? WHERE id = ? AND image_pending = 1',
    ).run(meta, job.mid);
    bumpConversationRevision(job.conversationId);
    markMessageDirty(job.conversationId, job.mid);
    broadcastTree(job.conversationId);
  });
}
