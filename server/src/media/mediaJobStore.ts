import type {
  MediaAsset,
  MediaAvatarContext,
  MediaDraft,
  MediaJob,
  MediaJobInputSnapshot,
  MediaJobState,
  MediaVideoPreview,
  MediaWorkflowValues,
  Endpoint,
  StandalonePromptTemplate,
} from '@tinytavern/shared';
import { stmt, toMediaAsset, transaction } from '../db/db.ts';
import { broadcast } from '../realtime/events.ts';
import { publicMediaJob } from './mediaUrls.ts';
import { HttpError } from '../http/router.ts';
import type { ChatMessage } from '../generation/prompt.ts';
import { captureMediaCharacters } from './mediaCharacters.ts';

export interface MediaJobConfiguration {
  workflowName?: string | null;
  workflowParameters?: { label: string; value: string | number | boolean }[];
  seedOverride?: number | null;
  avatarContext?: MediaAvatarContext | null;
  characterIds?: number[];
  sourceCharacterIds?: number[];
  workflowValues?: MediaWorkflowValues;
  comfyUrl: string;
  workflowId: string;
  /** Output binding of a submitted run; no graph is retained. */
  textOutputNodeId?: string | null;
  timeoutSeconds: number;
  temporary?: boolean;
  messageRenderOnly?: boolean;
  /** Remove a cancelled review variation only after its remote execution has stopped. */
  discardOnCancel?: boolean;
  /** VHS sends this header once per sampler; retain it across worker reconnects, without frames. */
  videoPreview?: Omit<MediaVideoPreview, 'frames' | 'sequence'>;
  /** Historical job snapshots can retain a label even after its character was deleted. */
  galleryOutput?: {
    characterName: string;
  };
}
export interface MediaPromptContext {
  messages: ChatMessage[];
  template: StandalonePromptTemplate;
}
export type CapturedMediaEndpoint = Omit<Endpoint, 'apiKey'>;
export interface MediaJobRow {
  prompt_message_id: number | null;
  id: number;
  draft_id: number | null;
  recipe_id: number | null;
  revision: number;
  state: MediaJobState;
  workflow_id: string | null;
  preset_id: string | null;
  chat_preset_id: number | null;
  standalone_preset_id: number | null;
  instruction: string;
  prompt: string;
  result_text: string | null;
  inputs_json: string;
  configuration_json: string | null;
  context_json: string | null;
  endpoint_json: string | null;
  context_conversation_id: number | null;
  message_id: number | null;
  destination: 'gallery' | 'chat';
  gallery_folder_id: number | null;
  source_job_id: number | null;
  seed: number | null;
  comfy_prompt_id: string | null;
  submission_id: string | null;
  request_key: string | null;
  outputs_json: string;
  error: string | null;
  auto_render: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  deadline: number | null;
  retention_deadline: number | null;
}

// Only live prompt text and ephemeral progress are kept in RAM. State changes
// persist through updateMediaJob; a shutdown flushes these text buffers once.
export const mediaLive = new Map<number, { prompt?: string; reasoning?: string; progress?: MediaJob['progress'] }>();
export const mediaPromptBuffers = new Map<number, { prompt: string; reasoning: string }>();
const jobListeners = new Map<number, Set<(row: MediaJobRow) => void>>();

export function hasMediaJobObservers(id: number): boolean {
  return jobListeners.has(id);
}

export function observeMediaJob(id: number, listener: (row: MediaJobRow) => void): () => void {
  let listeners = jobListeners.get(id);
  if (!listeners) {
    listeners = new Set();
    jobListeners.set(id, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      jobListeners.delete(id);
    }
  };
}

export function notifyMediaJobListeners(id: number): void {
  const listeners = jobListeners.get(id);
  if (!listeners) {
    return;
  }
  const row = mediaJobRow(id);
  if (row) {
    for (const listener of listeners) {
      listener(row);
    }
  }
}

export function mediaJobRow(id: number): MediaJobRow | undefined {
  return (stmt('SELECT * FROM media_jobs WHERE id = ?').get(id) ?? undefined) as unknown as MediaJobRow | undefined;
}
export function requireMediaJob(id: number, revision?: unknown): MediaJobRow {
  const row = mediaJobRow(id);
  if (!row) {
    throw new HttpError(404, 'Media job not found');
  }
  if (revision !== undefined && revision !== row.revision) {
    throw new HttpError(409, 'Media job changed; refresh and retry');
  }
  return row;
}

export function mediaDraft(id: number): MediaDraft {
  const row = stmt('SELECT * FROM media_drafts WHERE id = ?').get(id);
  if (!row) {
    throw new HttpError(404, 'Media draft not found');
  }
  return {
    id,
    revision: Number(row.revision),
    conversationId: row.conversation_id == null ? null : Number(row.conversation_id),
    state: row.state as MediaDraft['state'],
    selectedAssetId: row.selected_asset_id === null ? null : Number(row.selected_asset_id),
    savedAssetIds: stmt(`SELECT DISTINCT output.asset_id FROM media_jobs j
      JOIN media_owners output ON output.owner_type = 'job' AND output.owner_id = j.id
        AND output.slot LIKE 'output:%'
      WHERE j.draft_id = ? AND EXISTS (
        SELECT 1 FROM media_owners saved WHERE saved.asset_id = output.asset_id
          AND saved.owner_type IN ('message', 'gallery'))
      ORDER BY output.asset_id`)
      .all(id)
      .map((entry) => Number(entry.asset_id)),
  };
}

export function activeMediaJobs(): MediaJob[] {
  return (
    stmt(`SELECT * FROM media_jobs
    WHERE state NOT IN ('draft', 'ready', 'succeeded', 'failed', 'cancelled')
    ORDER BY created_at, id`).all() as unknown as MediaJobRow[]
  ).map(mediaJobDto);
}

export function mediaJobDto(row: MediaJobRow): MediaJob {
  const assetRows = stmt(`
    SELECT DISTINCT a.*
    FROM media_assets a
    JOIN media_owners o ON o.asset_id = a.id
    WHERE o.owner_type = 'job' AND o.owner_id = ?
  `).all(row.id);
  const assetsById = new Map<number, MediaAsset>();
  for (const assetRow of assetRows) {
    const asset = toMediaAsset(assetRow);
    assetsById.set(asset.id, asset);
  }

  // Completed attachments own their files. History resolves surviving outputs without pinning
  // a deleted message/gallery result indefinitely.
  const outputs = stmt(`
    SELECT a.* FROM json_each(?) output
    JOIN media_assets a ON a.id = output.value
    WHERE EXISTS (SELECT 1 FROM media_owners o WHERE o.asset_id = a.id)
    ORDER BY output.key
  `)
    .all(row.outputs_json)
    .map(toMediaAsset);

  const inputs = JSON.parse(row.inputs_json) as MediaJobInputSnapshot[];
  const inputAssets: MediaAsset[] = [];
  const seenInputIds = new Set<number>();
  for (const input of inputs) {
    const asset = assetsById.get(input.assetId);
    if (asset && !seenInputIds.has(asset.id)) {
      inputAssets.push(asset);
      seenInputIds.add(asset.id);
    }
  }

  const cleanup = stmt(`
    SELECT count(*) AS pending_count
    FROM media_remote_files
    WHERE job_id = ? AND state = 'pending'
  `).get(row.id)!;
  const live = mediaLive.get(row.id);
  const configuration: MediaJobConfiguration | null = row.configuration_json
    ? JSON.parse(row.configuration_json)
    : null;

  return publicMediaJob({
    workflowName: configuration?.workflowName ?? null,
    workflowParameters: configuration?.workflowParameters,
    seedOverride: configuration?.seedOverride ?? null,
    avatarContext: configuration?.avatarContext ?? null,
    characterIds: configuration?.characterIds ?? captureMediaCharacters(row, configuration ?? {}),
    workflowValues: configuration?.workflowValues ?? {},
    id: row.id,
    promptMessageId: row.prompt_message_id,
    draft: row.draft_id === null ? null : mediaDraft(row.draft_id),
    revision: row.revision,
    workflowId: row.workflow_id,
    presetId: row.preset_id,
    state: row.state,
    instruction: row.instruction,
    prompt: live?.prompt ?? row.prompt,
    textResult: row.result_text,
    temporary: configuration?.temporary === true,
    reasoning: live?.reasoning,
    inputs,
    assets: inputAssets,
    outputs,
    contextConversationId: row.context_conversation_id,
    messageId: row.message_id,
    destination: row.destination,
    galleryFolderId: row.gallery_folder_id,
    sourceJobId: row.source_job_id,
    seed: row.seed,
    comfyPromptId: row.comfy_prompt_id,
    submitted: row.submission_id !== null,
    retrievalAvailable:
      row.state === 'failed' &&
      row.comfy_prompt_id !== null &&
      row.retention_deadline !== null &&
      row.retention_deadline > Date.now(),
    error: row.error,
    cleanupPending: Number(cleanup.pending_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    progress: live?.progress,
  });
}

export function publishMediaJob(id: number): void {
  const row = mediaJobRow(id);
  if (row) {
    broadcast({ t: 'mediaJob', job: mediaJobDto(row) });
    notifyMediaJobListeners(id);
  }
}

/** Internal column allowlist avoids accidental updates of immutable identities. */
const PATCH_COLUMNS = [
  'state',
  'recipe_id',
  'workflow_id',
  'preset_id',
  'instruction',
  'prompt',
  'result_text',
  'inputs_json',
  'configuration_json',
  'context_json',
  'endpoint_json',
  'message_id',
  'seed',
  'comfy_prompt_id',
  'submission_id',
  'outputs_json',
  'error',
  'auto_render',
  'started_at',
  'deadline',
  'retention_deadline',
] as const satisfies readonly (keyof MediaJobRow)[];
type JobPatch = Partial<Pick<MediaJobRow, (typeof PATCH_COLUMNS)[number]>>;
const patchColumns: ReadonlySet<string> = new Set(PATCH_COLUMNS);
export function updateMediaJob(id: number, patch: JobPatch): MediaJobRow {
  const entries = Object.entries(patch).filter(([key]) => patchColumns.has(key));
  const preset = entries.findIndex(([key]) => key === 'preset_id');
  if (preset >= 0) {
    const row = requireMediaJob(id);
    const value = entries[preset]![1];
    const chat = row.context_conversation_id !== null || row.chat_preset_id !== null;
    entries.splice(preset, 1, ['chat_preset_id', chat ? value : null], ['standalone_preset_id', chat ? null : value]);
  }
  if (entries.length > 0) {
    const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
    const values = entries.map(([, value]) => value);
    stmt(`
      UPDATE media_jobs
      SET ${assignments}, revision = revision + 1, updated_at = ?
      WHERE id = ?
    `).run(...values, Date.now(), id);
  }
  return requireMediaJob(id);
}

/** Caller validates every asset before replacing pins, synchronously in one transaction. */
export function pinMediaInputs(id: number, inputs: MediaJobInputSnapshot[]): void {
  transaction(() => {
    stmt(`
      DELETE FROM media_owners
      WHERE owner_type = 'job' AND owner_id = ? AND slot LIKE 'input:%'
    `).run(id);

    for (const input of inputs) {
      stmt(`
        INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
        VALUES (?, 'job', ?, ?)
      `).run(input.assetId, id, `input:${input.slot}`);
    }
    updateMediaJob(id, { inputs_json: JSON.stringify(inputs) });
  });
}
