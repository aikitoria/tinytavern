import { ComfyGraphProgress, type ComfyProgressData } from './comfyGraphProgress.ts';
import { cleanupDiscardedMediaDraft } from './mediaDrafts.ts';
import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { basename, extname, join } from 'node:path';
import WebSocket from 'ws';
import {
  compileMediaWorkflow,
  expandMediaWorkflow,
  mediaJobActive,
  mergeMediaProgress,
  type MediaVideoPreview,
  type MediaJob,
  type MediaJobInput,
  type WorkflowValues,
} from '@tinytavern/shared';
import { IMAGES_DIR, stmt, toEndpoint, transaction } from './db.ts';
import { streamEndpointCompletion } from './generation.ts';
import { broadcastMediaProgress, broadcastConv } from './events.ts';
import {
  mediaJobRow,
  mediaLive,
  hasMediaJobObservers,
  notifyMediaJobListeners,
  mediaPromptBuffers,
  publishMediaJob,
  requireMediaJob,
  updateMediaJob,
  type CapturedMediaEndpoint,
  type MediaJobConfiguration,
  type MediaJobRow,
  type MediaPromptContext,
} from './mediaJobStore.ts';
import { syncMediaJobMessage, deleteMediaJob, cancelMediaJob } from './mediaJobs.ts';
import {
  completeMediaJob,
  finishMediaJob,
  releaseDeletedMediaInputs,
  ingestedMedia,
  recordMediaResult,
} from './mediaJobResults.ts';
import {
  comfyFile,
  comfyFileParams,
  comfyOutputFiles,
  drainRemoteCleanup,
  ownRemoteFile,
  releaseRemoteFile,
  releaseRemoteFiles,
  type ComfyFile,
} from './mediaRemote.ts';
import { downloadMedia, InvalidMediaOutput } from './mediaFiles.ts';
import { deleteImageFiles } from './images.ts';
import { parsePreviewFrame } from './comfyPreview.ts';
import { ComfyVideoPreview } from './comfyVideoPreview.ts';
import { comfyTextOutput } from './comfyTextOutput.ts';

interface ComfyHistory {
  status?: {
    completed?: boolean;
    status_str?: string;
    messages?: [string, Record<string, unknown>][];
  };
  outputs?: Record<string, unknown>;
}

interface ComfyQueue {
  queue_running: unknown[][];
  queue_pending: unknown[][];
}

interface WorkerTask {
  controller: AbortController;
  state: MediaJobRow['state'];
}

const POLL_MS = Number(process.env.COMFY_POLL_MS ?? (process.env.E2E_BASE ? 100 : 1500));
const RETRIEVAL_WINDOW_MS = 24 * 3600_000;
const tasks = new Map<string, WorkerTask>();
const retryAt = new Map<string, { failures: number; time: number; state: MediaJobRow['state'] }>();
const sockets = new Map<string, { socket: WebSocket; ready: Promise<void> }>();
const progressTimers = new Map<string, NodeJS.Timeout>();
const pendingVideoPreviews = new Map<string, MediaVideoPreview | null>();
let timer: NodeJS.Timeout | undefined;
let stopping = false;
let cleanupRunning = false;
let cleanupController = new AbortController();

function configuration(row: MediaJobRow): MediaJobConfiguration {
  if (!row.configuration_json) {
    throw new Error('The job has no saved rendering configuration');
  }
  return JSON.parse(row.configuration_json) as MediaJobConfiguration;
}

function requestSignal(signal: AbortSignal, timeout = 30_000): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
}

async function comfyJson<T>(
  base: string,
  path: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: requestSignal(signal),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Comfy ${path} failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function flushProgress(id: string): void {
  const current = mediaLive.get(id);
  if (!current || stopping) return;
  const progress = { ...current.progress };
  // Snapshots retain the bounded cache. Frequent events send only changed frame indices.
  if (pendingVideoPreviews.has(id)) {
    progress.videoPreview = pendingVideoPreviews.get(id)!;
    pendingVideoPreviews.delete(id);
  } else {
    delete progress.videoPreview;
  }
  broadcastMediaProgress({
    t: 'mediaJobProgress',
    id,
    progress,
    prompt: current.prompt,
    reasoning: current.reasoning,
  });
  notifyMediaJobListeners(id);
  const row = mediaJobRow(id);
  if (row?.message_id !== null && row?.context_conversation_id != null) {
    broadcastConv(row.context_conversation_id, {
      t: 'imageProgress',
      conversationId: row.context_conversation_id,
      mid: row.message_id!,
      value: current.progress?.value,
      max: current.progress?.max,
      preview: current.progress?.preview,
    });
  }
}

function publishProgress(id: string, progress: MediaJob['progress']): void {
  const live = mediaLive.get(id) ?? {};
  const firstUpdate = !live.progress;
  const firstPreview = Boolean(progress?.preview && !live.progress?.preview);
  const firstVideoFrame = Boolean(
    progress?.videoPreview &&
    Object.values(progress.videoPreview.frames).some(Boolean) &&
    (!live.progress?.videoPreview || Object.keys(live.progress.videoPreview.frames).length === 0),
  );
  if (progress?.videoPreview !== undefined) {
    const incoming = progress.videoPreview;
    const pending = pendingVideoPreviews.get(id);
    pendingVideoPreviews.set(
      id,
      incoming && pending?.id === incoming.id
        ? { ...incoming, frames: { ...pending.frames, ...incoming.frames } }
        : incoming,
    );
  }
  live.progress = mergeMediaProgress(live.progress, progress ?? {});
  if (progress?.videoPreview) delete live.progress.preview;
  mediaLive.set(id, live);
  if (firstUpdate || firstPreview || firstVideoFrame) {
    flushProgress(id);
    return;
  }
  if (progressTimers.has(id)) return;
  const handle = setTimeout(() => {
    progressTimers.delete(id);
    flushProgress(id);
  }, 50);
  handle.unref();
  progressTimers.set(id, handle);
}

function openProgress(row: MediaJobRow): Promise<void> {
  const existing = sockets.get(row.id);
  if (existing) return existing.ready;
  if (sockets.size >= 32) return Promise.resolve();
  const base = configuration(row).comfyUrl.replace(/^http/, 'ws');
  const socket = new WebSocket(`${base}/ws?clientId=${row.id}`, { maxPayload: 5 * 1024 * 1024 });
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  sockets.set(row.id, { socket, ready });
  const openTimeout = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }, 2000);
  openTimeout.unref();
  socket.on('error', () => socket.terminate());
  socket.on('open', () => {
    clearTimeout(openTimeout);
    connected();
  });
  socket.on('close', () => {
    clearTimeout(openTimeout);
    connected();
    if (sockets.get(row.id)?.socket === socket) {
      sockets.delete(row.id);
    }
  });
  const graphProgress = new ComfyGraphProgress(
    compileMediaWorkflow(configuration(row).workflow.json).graph,
  );
  let executingNode: string | null = null;
  let videoPreview: ComfyVideoPreview | null = null;
  socket.on('message', (raw, binary) => {
    if (stopping || sockets.get(row.id)?.socket !== socket) {
      return;
    }
    if (binary) {
      if (mediaJobRow(row.id)?.state !== 'rendering') return;
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      const video = videoPreview?.accept(bytes);
      if (video) {
        publishProgress(row.id, { videoPreview: video });
        return;
      }
      const preview = parsePreviewFrame(bytes);
      if (preview) {
        publishProgress(row.id, { preview, videoPreview: null });
      }
      return;
    }
    try {
      const event = JSON.parse(String(raw)) as {
        type?: string;
        data?: ComfyProgressData & {
          prompt_id?: string;
          value?: number;
          max?: number;
          output?: unknown;
          node?: string | null;
          display_node?: string;
          id?: string;
          length?: number;
          rate?: number;
        };
      };
      const expectedId = mediaJobRow(row.id)?.submission_id;
      if (!expectedId) return;
      if (event.data?.prompt_id && event.data.prompt_id !== expectedId) {
        return;
      }
      if (event.type === 'executing' && event.data && event.data.prompt_id === expectedId) {
        executingNode = event.data.display_node ?? event.data.node ?? null;
        videoPreview = null;
      }
      if (
        ['execution_success', 'execution_error', 'execution_interrupted'].includes(event.type ?? '')
      ) {
        executingNode = null;
        videoPreview = null;
      }
      if (event.type === 'VHS_latentpreview') {
        if (!row.operation.startsWith('video') || mediaJobRow(row.id)?.state !== 'rendering')
          return;
        const incoming = ComfyVideoPreview.fromEvent(event.data, executingNode);
        if (incoming) {
          videoPreview = incoming;
          publishProgress(row.id, { videoPreview: { ...incoming.metadata, frames: {} } });
        }
        return;
      }
      if (
        ['execution_start', 'executing', 'progress', 'progress_state'].includes(event.type ?? '')
      ) {
        const current = mediaJobRow(row.id);
        if (
          current &&
          event.data?.prompt_id === current.submission_id &&
          (current.state === 'reconciling' || current.state === 'queued')
        ) {
          updateMediaJob(row.id, { state: 'rendering', comfy_prompt_id: current.submission_id });
          publishMediaJob(row.id);
        }
      }
      if (event.type && event.data && event.data.prompt_id === expectedId) {
        const progress = graphProgress.update(event.type, event.data);
        if (progress) publishProgress(row.id, progress);
      }
      if (event.type === 'executed' && event.data?.output) {
        const base = configuration(row).comfyUrl;
        for (const file of comfyOutputFiles(event.data.output)) {
          if (file.type !== 'input') {
            ownRemoteFile(row.id, base, file, 'output');
          }
        }
      }
    } catch {
      // Polling remains authoritative if a progress frame is malformed.
    }
  });
  return ready;
}

function closeProgress(id: string): void {
  sockets.get(id)?.socket.terminate();
  sockets.delete(id);
  pendingVideoPreviews.delete(id);
  const handle = progressTimers.get(id);
  if (handle) {
    clearTimeout(handle);
    progressTimers.delete(id);
  }
}

async function preparePrompt(row: MediaJobRow, signal: AbortSignal): Promise<void> {
  const captured = JSON.parse(row.endpoint_json!) as CapturedMediaEndpoint;
  const endpointRow = stmt('SELECT * FROM endpoints WHERE id = ?').get(captured.id);
  if (!endpointRow) {
    throw new Error('The captured endpoint was deleted');
  }
  const currentEndpoint = toEndpoint(endpointRow);
  if (currentEndpoint.baseUrl !== captured.baseUrl) {
    throw new Error('The captured endpoint address changed; prepare the prompt again');
  }
  const endpoint = { ...captured, apiKey: currentEndpoint.apiKey };
  const context = JSON.parse(row.context_json!) as MediaPromptContext;
  const live = { prompt: '', reasoning: '' };
  mediaLive.set(row.id, live);
  if (row.message_id !== null) mediaPromptBuffers.set(row.message_id, live);
  const prompt = await streamEndpointCompletion(
    endpoint,
    context.messages,
    4096,
    (delta) => {
      signal.throwIfAborted();
      if (mediaLive.get(row.id) !== live) return;
      live.reasoning = '';
      live.prompt += delta;
      if (live.prompt.length > 200_000) {
        throw new Error('Generated prompt exceeds the text limit');
      }
      publishProgress(row.id, {});
    },
    signal,
    {
      useEndpointParameters: true,
      reasoningPrefill: context.template.reasoningPrefill,
      messagePrefill: context.template.messagePrefill,
      requireComplete: true,
      onReasoning: (delta) => {
        signal.throwIfAborted();
        if (mediaLive.get(row.id) !== live) return;
        live.reasoning += delta;
        publishProgress(row.id, {});
      },
    },
  );

  if (mediaLive.get(row.id) !== live) return;
  const current = requireMediaJob(row.id);
  if (current.state !== 'preparing') {
    return;
  }
  transaction(() => {
    const next = updateMediaJob(row.id, {
      prompt,
      state: current.auto_render ? 'submitting' : 'ready',
      deadline:
        current.auto_render && configuration(current).timeoutSeconds > 0
          ? Date.now() + configuration(current).timeoutSeconds * 1000
          : null,
      error: null,
    });
    syncMediaJobMessage(next);
  });
  mediaLive.delete(row.id);
  if (row.message_id !== null) {
    mediaPromptBuffers.delete(row.message_id);
  }
  publishMediaJob(row.id);
}

async function uploadInputs(
  row: MediaJobRow,
  signal: AbortSignal,
): Promise<Partial<WorkflowValues>> {
  const base = configuration(row).comfyUrl;
  const inputs = JSON.parse(row.inputs_json) as MediaJobInput[];
  const uploaded = new Map<number, string>();
  const bindings: Partial<WorkflowValues> = {};
  for (const input of inputs) {
    let remoteName = uploaded.get(input.assetId);
    if (remoteName === undefined) {
      const asset = stmt('SELECT path, mime FROM media_assets WHERE id = ?').get(input.assetId);
      if (!asset) {
        throw new Error('A pinned reference image is missing');
      }
      const file: ComfyFile = {
        filename: `tinytavern-${row.id}-asset-${input.assetId}${extname(String(asset.path))}`,
        subfolder: '',
        type: 'input',
      };
      // The deterministic private name is recorded before upload, including an
      // upload whose response is lost. Retrying overwrites only this job's input.
      ownRemoteFile(row.id, base, file, 'input');
      const data = new FormData();
      const source = await openAsBlob(join(IMAGES_DIR, basename(String(asset.path))), {
        type: String(asset.mime),
      });
      data.set('image', source, file.filename);
      data.set('subfolder', file.subfolder);
      data.set('type', file.type);
      data.set('overwrite', 'true');
      const response = await fetch(`${base}/upload/image`, {
        method: 'POST',
        body: data,
        signal: requestSignal(signal, 60_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Comfy reference upload failed (${response.status})`);
      }
      const result = (await response.json()) as {
        name?: string;
        subfolder?: string;
        type?: string;
      };
      const returned = comfyFile({
        filename: result.name,
        subfolder: result.subfolder,
        type: result.type,
      });
      if (!returned) {
        throw new Error('Comfy returned an invalid uploaded filename');
      }
      ownRemoteFile(row.id, base, returned, 'input');
      remoteName = returned.subfolder
        ? `${returned.subfolder}/${returned.filename}`
        : returned.filename;
      uploaded.set(input.assetId, remoteName);
    }
    bindings[input.slot] = remoteName;
    if (requireMediaJob(row.id).state !== 'submitting') {
      return bindings;
    }
  }
  return bindings;
}

async function submit(row: MediaJobRow, signal: AbortSignal): Promise<void> {
  const config = configuration(row);
  // Connect while uploading references, then submit with the preview listener ready.
  const [inputs] = await Promise.all([uploadInputs(row, signal), openProgress(row)]);
  signal.throwIfAborted();
  if (requireMediaJob(row.id).state !== 'submitting') {
    return;
  }
  const submissionId = randomUUID();
  const graph = compileMediaWorkflow(config.workflow.json);
  const prompt = expandMediaWorkflow(
    graph,
    {
      ...inputs,
      prompt: row.prompt,
      seed: row.seed!,
      job_id: row.id,
    },
    config.workflowValues,
  );
  // Comfy's installed API accepts this exact ID. Persist it BEFORE POST and
  // never POST again once acceptance is uncertain, even after a process crash.
  updateMediaJob(row.id, { submission_id: submissionId, state: 'reconciling' });
  publishMediaJob(row.id);
  const response = await fetch(`${config.comfyUrl}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      prompt_id: submissionId,
      client_id: row.id,
      extra_data: {
        preview_method: 'taesd',
        tinytavern_job_id: row.id,
        extra_pnginfo: {
          workflow: {
            extra: {
              VHS_MetadataImage: false,
              VHS_KeepIntermediate: false,
              VHS_latentpreview: row.operation.startsWith('video'),
              VHS_latentpreviewrate: 0,
            },
          },
        },
      },
    }),
    signal: requestSignal(signal),
  });
  if (response.status >= 400 && response.status < 500) {
    const detail = (await response.text()).slice(0, 500);
    releaseRemoteFiles(row.id);
    finishMediaJob(row.id, 'failed', `Comfy rejected the workflow (${response.status}): ${detail}`);
    return;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Comfy submission acceptance is uncertain; reconciling the recorded ID');
  }
  const accepted = (await response.json()) as { prompt_id?: string };
  if (accepted.prompt_id !== submissionId) {
    throw new Error('Comfy returned a different prompt ID; submission requires reconciliation');
  }
  const current = requireMediaJob(row.id);
  updateMediaJob(row.id, {
    comfy_prompt_id: submissionId,
    state: current.state === 'reconciling' ? 'queued' : current.state,
    error: null,
  });
  publishMediaJob(row.id);
}

async function observe(row: MediaJobRow, signal: AbortSignal) {
  const base = configuration(row).comfyUrl;
  const id = row.comfy_prompt_id ?? row.submission_id;
  if (!id) {
    return { history: undefined, running: false, queued: false };
  }
  const history = await comfyJson<Record<string, ComfyHistory>>(base, `/history/${id}`, signal);
  const entry = history[id];
  if (entry?.status?.completed || entry?.status?.status_str === 'error') {
    return { history: entry, running: false, queued: false };
  }
  const queue = await comfyJson<ComfyQueue>(base, '/queue', signal);
  if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) {
    throw new Error('Comfy returned an invalid queue snapshot');
  }
  return {
    history: entry,
    running: queue.queue_running.some((item) => item[1] === id),
    queued: queue.queue_pending.some((item) => item[1] === id),
  };
}

function recordObservedFiles(row: MediaJobRow, history?: ComfyHistory): void {
  const base = configuration(row).comfyUrl;
  for (const file of comfyOutputFiles(history?.outputs)) {
    // Comfy also returns UI locators for pre-existing input previews. Only our
    // upload path acquires input ownership; seeing a preview does not create a file.
    if (file.type !== 'input') {
      ownRemoteFile(row.id, base, file, 'output');
    }
  }
}

async function cancel(row: MediaJobRow, signal: AbortSignal): Promise<void> {
  if (!row.submission_id) {
    releaseRemoteFiles(row.id, 60_000);
    finishMediaJob(row.id, 'cancelled', row.error);
    return;
  }
  const observed = await observe(row, signal);
  recordObservedFiles(row, observed.history);
  if (!observed.history && !observed.running && !observed.queued && !row.comfy_prompt_id) {
    // An interrupted POST may still be validating upstream. Keep reconciling
    // until its exact ID is observed; absence alone cannot prove rejection.
    return;
  }
  if (observed.running || observed.queued) {
    const base = configuration(row).comfyUrl;
    await comfyJson(base, `/api/jobs/${row.submission_id}/cancel`, signal, {});
    updateMediaJob(row.id, { comfy_prompt_id: row.submission_id });
    return;
  }
  releaseRemoteFiles(row.id);
  finishMediaJob(row.id, 'cancelled', row.error);
}

async function retrieve(
  row: MediaJobRow,
  history: ComfyHistory,
  signal: AbortSignal,
): Promise<void> {
  const config = configuration(row);
  const kind = row.operation.startsWith('video') ? 'video' : 'image';
  const outputs = history.outputs ?? {};
  if (row.operation === 'image-describe') {
    const prompt = comfyTextOutput(outputs);
    transaction(() => {
      updateMediaJob(row.id, { prompt });
      finishMediaJob(row.id, 'succeeded');
    });
    releaseRemoteFiles(row.id);
    return;
  }
  const mediaNodes = Object.entries(outputs)
    .map(([id, output]) => ({
      id,
      files: comfyOutputFiles(output).filter(
        (file) =>
          file.type !== 'input' &&
          /\.(png|jpe?g|webp|avif|bmp|gif|webm|mp4|mkv|mov|avi)$/i.test(file.filename),
      ),
    }))
    .filter((node) => node.files.length > 0);
  if (mediaNodes.length > 1) {
    throw new InvalidMediaOutput(
      `Workflow returned images or videos from multiple output nodes (${mediaNodes.map((node) => node.id).join(', ')}). Keep only one image/video output node in the workflow.`,
    );
  }
  const files = (mediaNodes[0]?.files ?? []).filter((file) => {
    const extension = extname(file.filename).toLowerCase();
    return kind === 'video'
      ? extension === '.webm'
      : ['.png', '.jpg', '.jpeg', '.webp'].includes(extension);
  });
  if (files.length === 0) {
    throw new InvalidMediaOutput(
      `Comfy produced no final ${kind === 'video' ? 'AV1 WebM video' : 'image'}`,
    );
  }
  for (const file of files) {
    const remote = ownRemoteFile(row.id, config.comfyUrl, file, 'output');
    if (ingestedMedia(row.id, remote.id)) {
      releaseRemoteFile(remote.id);
      continue;
    }
    const response = await fetch(`${config.comfyUrl}/view?${comfyFileParams(file)}`, {
      signal: requestSignal(signal, 180_000),
    });
    const media = await downloadMedia(response, kind, signal);
    const current = requireMediaJob(row.id);
    if (current.state !== 'downloading') {
      deleteImageFiles([media.path]);
      return;
    }
    try {
      recordMediaResult(row.id, remote.id, media);
    } catch (err) {
      deleteImageFiles([media.path]);
      throw err;
    }
    releaseRemoteFile(remote.id);
    publishMediaJob(row.id);
  }
  completeMediaJob(row.id);
  releaseRemoteFiles(row.id);
}

async function poll(row: MediaJobRow, signal: AbortSignal): Promise<void> {
  openProgress(row);
  const observed = await observe(row, signal);
  const current = requireMediaJob(row.id);
  if (current.state === 'cancelling') {
    return;
  }
  recordObservedFiles(current, observed.history);
  if (observed.history?.status?.status_str === 'error') {
    const details = (observed.history.status.messages ?? [])
      .filter(([kind]) => kind === 'execution_error')
      .map(
        ([, data]) =>
          `${data.node_type} [${data.node_id}] ${data.exception_type}: ${data.exception_message}`,
      )
      .join('; ');
    releaseRemoteFiles(row.id);
    finishMediaJob(
      row.id,
      'failed',
      `Comfy workflow execution failed${details ? `: ${details}` : ''}`,
    );
    return;
  }
  if (observed.history?.status?.completed) {
    const next = updateMediaJob(row.id, {
      state: 'downloading',
      comfy_prompt_id: row.submission_id,
      retention_deadline: row.retention_deadline ?? Date.now() + RETRIEVAL_WINDOW_MS,
      error: null,
    });
    publishMediaJob(row.id);
    await retrieve(next, observed.history, signal);
    return;
  }
  if (observed.running || observed.queued) {
    // A queue response may have been captured before the execution-start frame.
    const state = observed.running || current.state === 'rendering' ? 'rendering' : 'queued';
    if (current.state !== state || current.comfy_prompt_id !== row.submission_id) {
      updateMediaJob(row.id, { state, comfy_prompt_id: row.submission_id, error: null });
      publishMediaJob(row.id);
    }
  }
}

async function runStep(row: MediaJobRow, signal: AbortSignal): Promise<void> {
  if (row.deadline && Date.now() > row.deadline && row.state !== 'cancelling') {
    updateMediaJob(row.id, {
      state: 'cancelling',
      error: 'Media generation exceeded its time limit',
    });
    publishMediaJob(row.id);
    return;
  }
  switch (row.state) {
    case 'preparing':
      await preparePrompt(row, signal);
      break;
    case 'submitting':
      await submit(row, signal);
      break;
    case 'cancelling':
      await cancel(row, signal);
      break;
    default:
      await poll(row, signal);
  }
}

function stepFailed(id: string, error: unknown, interrupted: boolean): void {
  if (stopping) {
    return;
  }
  const row = mediaJobRow(id);
  if (!row || !mediaJobActive(row.state)) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (row.state === 'cancelling' && interrupted) {
    retryAt.delete(id);
    return;
  }
  if (row.state === 'preparing') {
    finishMediaJob(id, 'failed', message);
    return;
  }
  if (row.state !== 'cancelling' && row.deadline !== null && row.deadline <= Date.now()) {
    updateMediaJob(id, { state: 'cancelling', error: 'Media generation exceeded its time limit' });
    retryAt.delete(id);
    publishMediaJob(id);
    return;
  }
  if (row.state === 'downloading' && error instanceof InvalidMediaOutput) {
    releaseRemoteFiles(id);
    updateMediaJob(id, { retention_deadline: null });
    finishMediaJob(id, 'failed', message);
    return;
  }
  const failures = (retryAt.get(id)?.failures ?? 0) + 1;
  retryAt.set(id, {
    failures,
    state: row.state,
    time: Date.now() + Math.min(30_000, POLL_MS * 2 ** Math.min(failures, 5)),
  });
  if (row.state === 'downloading' && failures >= 3) {
    finishMediaJob(id, 'failed', `${message}. Retry retrieval to download the existing result.`);
    return;
  }
  if (row.error !== message) {
    updateMediaJob(id, { error: message });
    publishMediaJob(id);
  }
}

/** Dispatch at most four I/O steps; waiting Comfy jobs do not occupy a worker. */
export function tickMediaWorker(): void {
  if (stopping) {
    return;
  }
  for (const [id, task] of tasks) {
    const row = mediaJobRow(id);
    const cancelled = row?.state === 'cancelling' && task.state !== 'cancelling';
    if (cancelled || (task.state === 'preparing' && row?.state !== 'preparing')) {
      task.controller.abort();
    }
  }
  const rows = stmt(`
    SELECT * FROM media_jobs
    WHERE state NOT IN ('draft', 'ready', 'succeeded', 'failed', 'cancelled')
    ORDER BY CASE WHEN state = 'cancelling' THEN 0 ELSE 1 END, updated_at, id
  `).all() as unknown as MediaJobRow[];
  for (const row of rows) {
    if (tasks.size >= 4) {
      break;
    }
    if (tasks.has(row.id)) continue;
    const retry = retryAt.get(row.id);
    if (retry?.state === row.state && retry.time > Date.now()) continue;
    const preparingCount = [...tasks.values()].filter((task) => task.state === 'preparing').length;
    if (row.state === 'preparing' && preparingCount >= 2) {
      continue;
    }
    const task = { controller: new AbortController(), state: row.state };
    tasks.set(row.id, task);
    let signal = task.controller.signal;
    if (row.state !== 'cancelling' && row.deadline !== null) {
      const remaining = Math.max(1, row.deadline - Date.now());
      signal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    }
    void runStep(row, signal)
      .then(() => {
        const current = mediaJobRow(row.id);
        if (!current || !mediaJobActive(current.state) || current.state !== task.state) {
          retryAt.delete(row.id);
        } else {
          retryAt.set(row.id, { failures: 0, time: Date.now() + POLL_MS, state: current.state });
        }
      })
      .catch((error: unknown) => stepFailed(row.id, error, task.controller.signal.aborted))
      .finally(() => {
        tasks.delete(row.id);
        if (stopping) {
          return;
        }
        const current = mediaJobRow(row.id);
        if (!current || !mediaJobActive(current.state)) {
          closeProgress(row.id);
          if (row.message_id !== null) {
            mediaPromptBuffers.delete(row.message_id);
          }
          if (current?.state === 'ready') releaseDeletedMediaInputs(current.id);
          if (current) {
            cleanupDiscardedMediaDraft(current);
          }
          if (current && configuration(current).temporary && !hasMediaJobObservers(current.id)) {
            deleteMediaJob(current);
          }
        }
        queueMicrotask(tickMediaWorker);
      });
  }
  const expired = stmt(`
    SELECT id FROM media_jobs WHERE state = 'failed' AND retention_deadline <= ?
  `).all(Date.now());
  for (const row of expired) {
    releaseRemoteFiles(String(row.id));
    updateMediaJob(String(row.id), { retention_deadline: null });
  }
  if (!cleanupRunning) {
    cleanupRunning = true;
    void drainRemoteCleanup(cleanupController.signal).finally(() => {
      cleanupRunning = false;
    });
  }
}

/** Repair persisted execution before the startup orphan sweep. */
export function initMediaWorker(): void {
  stopping = false;
  cleanupController = new AbortController();
  const previews = stmt(`
    SELECT * FROM media_jobs
    WHERE state IN ('succeeded', 'failed', 'cancelled')
      AND json_extract(configuration_json, '$.temporary') = 1
  `).all() as unknown as MediaJobRow[];
  for (const row of previews) {
    deleteMediaJob(row);
  }
  const saved = stmt(`SELECT j.* FROM media_jobs j
    LEFT JOIN media_drafts d ON d.id = j.draft_id
    WHERE j.state = 'succeeded' AND (j.draft_id IS NULL OR d.state = 'accepted')
  `).all() as unknown as MediaJobRow[];
  for (const row of saved) {
    deleteMediaJob(row);
  }
  stmt(`DELETE FROM media_remote_files WHERE state = 'deleted'
    AND NOT EXISTS (SELECT 1 FROM media_jobs WHERE id = media_remote_files.job_id)`).run();
  const discarded = stmt(`SELECT j.* FROM media_jobs j JOIN media_drafts d ON d.id = j.draft_id
    WHERE d.state = 'discarding'`).all() as unknown as MediaJobRow[];
  for (const row of discarded) {
    if (mediaJobActive(row.state)) cancelMediaJob(row);
    cleanupDiscardedMediaDraft(requireMediaJob(row.id));
  }
  const interrupted = stmt("SELECT id FROM media_jobs WHERE state = 'preparing'").all();
  for (const row of interrupted) {
    finishMediaJob(
      String(row.id),
      'failed',
      'Prompt preparation was interrupted; prepare it again',
    );
  }
  if (!timer) {
    timer = setInterval(tickMediaWorker, POLL_MS);
    timer.unref();
  }
}

/** Save unfinished prompt text once; submitted Comfy work remains recoverable. */
export function stopMediaWorker(): void {
  stopping = true;
  clearInterval(timer);
  timer = undefined;
  for (const [id, task] of tasks) {
    const row = mediaJobRow(id);
    if (row?.state === 'preparing') {
      finishMediaJob(id, 'failed', 'Prompt preparation was interrupted; prepare it again');
    }
    task.controller.abort();
  }
  cleanupController.abort();
  for (const id of sockets.keys()) {
    closeProgress(id);
  }
}
