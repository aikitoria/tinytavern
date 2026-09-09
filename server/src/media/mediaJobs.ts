import { captureMediaCharacters, mediaCharacterIds } from './mediaCharacters.ts';
import type { MediaRecipeInput } from './mediaRecipes.ts';
import {
  MEDIA_OPERATIONS,
  systemNote,
  defaultMediaPrompt,
  chatImagePromptPresets,
  defaultChatImagePrompt,
  defaultChatMediaPrompt,
  mediaPromptSettingsKey,
  mediaInputSlots,
  mediaJobActive,
  mediaWorkflowError,
  mediaWorkflowKey,
  compileMediaWorkflow,
  validateWorkflowValues,
  type MediaJobInput,
  type MediaJobInputSnapshot,
  type MediaOperation,
  type MediaWorkflow,
  type StandalonePromptTemplate,
} from '@tinytavern/shared';
import { stmt, toConversation, transaction } from '../db/db.ts';
import { HttpError } from '../http/router.ts';
import { getSettings } from '../settings/settingsStore.ts';
import { optionalNullableId, optionalNullableString, optionalString } from '../http/validation.ts';
import { appendMessage, getActivePath, markMessageDirty } from '../conversations/tree.ts';
import { requireExpectedActiveLeaf } from '../conversations/concurrency.ts';
import { bumpConversationRevision } from '../conversations/conversationRevision.ts';
import { broadcast, invalidate } from '../realtime/events.ts';
import { broadcastTree } from '../realtime/sync.ts';
import { deleteImageFiles } from './images.ts';
import {
  appendChatMessage,
  buildChatMessages,
  expandTemplate,
  type ChatMessage,
} from '../generation/prompt.ts';
import { hasActiveNonToolGeneration, resolveEndpoint } from '../generation/generation.ts';
import { discardSpeculativeSwipes } from '../generation/speculation.ts';
import {
  mediaJobDto,
  mediaDraft,
  mediaLive,
  mediaPromptBuffers,
  pinMediaInputs,
  publishMediaJob,
  requireMediaJob,
  updateMediaJob,
  type MediaJobConfiguration,
  type MediaJobRow,
  type MediaPromptContext,
} from './mediaJobStore.ts';
import { releaseRemoteFiles } from './mediaRemote.ts';
import { getMediaRecipe, saveMediaRecipe } from './mediaRecipes.ts';

type JobBody = Record<string, unknown>;
const EDITABLE_STATES = new Set(['draft', 'ready', 'failed', 'cancelled']);
const INPUT_SLOTS = new Set<string>(MEDIA_OPERATIONS.flatMap((operation) => operation.slots));

function conversationForJob(row: MediaJobRow) {
  if (row.context_conversation_id === null) {
    return null;
  }
  const conversation = stmt('SELECT * FROM conversations WHERE id = ?').get(
    row.context_conversation_id,
  );
  if (!conversation) {
    throw new HttpError(409, 'The source conversation was deleted');
  }
  return toConversation(conversation);
}

function parseOperation(value: unknown): MediaOperation {
  const operation = MEDIA_OPERATIONS.find((item) => item.id === value);
  if (!operation) {
    throw new HttpError(400, 'Choose a media operation');
  }
  return operation.id;
}

function parseInputs(
  value: unknown,
  previous: readonly MediaRecipeInput[] = [],
): MediaJobInputSnapshot[] {
  if (!Array.isArray(value) || value.length > 3) {
    throw new HttpError(400, 'Invalid media inputs');
  }
  const slots = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, 'Invalid media input');
    }
    const input = raw as Record<string, unknown>;
    const slot = input.slot;
    const knownSlot =
      typeof slot === 'string' && (INPUT_SLOTS.has(slot) || /^reference[123]$/.test(slot));
    if (!knownSlot || slots.has(slot as string)) {
      throw new HttpError(400, 'Each media input needs a distinct named slot');
    }
    if (!Number.isSafeInteger(input.assetId) || (input.assetId as number) <= 0) {
      throw new HttpError(400, 'Invalid reference asset ID');
    }
    const asset = stmt(`
      SELECT a.id, COALESCE(g.prompt, r.prompt, '') AS prompt FROM media_assets a
      LEFT JOIN media_owners gallery_owner ON gallery_owner.asset_id = a.id AND gallery_owner.owner_type = 'gallery'
      LEFT JOIN gallery_items g ON g.id = CAST(gallery_owner.owner_id AS INTEGER)
      LEFT JOIN media_recipes r ON r.id = a.recipe_id
      WHERE a.id = ? AND a.kind = 'image' AND a.reference_deleted = 0
        AND EXISTS (SELECT 1 FROM media_owners o WHERE o.asset_id = a.id)
    `).get(input.assetId as number);
    if (!asset) {
      throw new HttpError(409, 'A selected reference image is no longer available');
    }
    slots.add(slot as string);
    return {
      slot: slot as MediaJobInput['slot'],
      assetId: input.assetId as number,
      prompt:
        previous.find((saved) => saved.slot === slot && saved.assetId === input.assetId)?.prompt ??
        String(asset.prompt ?? ''),
    };
  });
}

function resolveJobConfiguration(
  operation: MediaOperation,
  workflowId: string | null,
  inputs: MediaJobInput[],
  configurationJson: string | null,
): { configuration: MediaJobConfiguration; captured: boolean } | null {
  const settings = getSettings().mediaRendering;
  const referenceCount = inputs.filter((input) => input.slot.startsWith('reference')).length;
  const selectedId = workflowId ?? settings.defaults[mediaWorkflowKey(operation, referenceCount)];
  const snapshot: MediaJobConfiguration | null = configurationJson
    ? JSON.parse(configurationJson)
    : null;
  if (
    snapshot &&
    snapshot.workflow.id === selectedId &&
    snapshot.workflow.operation === operation
  ) {
    return { configuration: snapshot, captured: true };
  }
  const workflow = settings.workflows.find((item) => item.id === selectedId);
  return workflow
    ? {
        configuration: {
          comfyUrl: settings.comfyUrl,
          timeoutSeconds: settings.jobTimeoutSeconds,
          workflow,
        },
        captured: false,
      }
    : null;
}

function validateJobWorkflow(operation: MediaOperation, configuration: MediaJobConfiguration) {
  const workflow = configuration.workflow;
  if (workflow.operation !== operation) {
    throw new HttpError(400, 'Choose a saved workflow matching the operation and reference count');
  }
  const invalid = mediaWorkflowError(workflow);
  if (invalid) {
    throw new HttpError(400, invalid);
  }
  return compileMediaWorkflow(workflow.json);
}

function requireEditable(row: MediaJobRow): void {
  if (row.draft_id && mediaDraft(row.draft_id).state !== 'open') {
    throw new HttpError(409, 'This media draft is finished');
  }
  if (!EDITABLE_STATES.has(row.state) || row.submission_id !== null) {
    throw new HttpError(409, 'This job is frozen; create a rerun to change it');
  }
}

function validateText(value: string, label: string): string {
  if (value.length > 200_000) {
    throw new HttpError(400, `${label} is too long`);
  }
  return value;
}

function draftConfiguration(
  operation: MediaOperation,
  workflowId: string | null,
  inputs: MediaJobInput[],
  configurationJson: string | null,
  values: unknown,
): string | null {
  if (values === undefined && configurationJson === null) return null;
  const resolved = resolveJobConfiguration(operation, workflowId, inputs, configurationJson);
  if (values === undefined) return resolved?.captured ? configurationJson : null;
  try {
    if (!resolved) {
      validateWorkflowValues([], values);
      return null;
    }
    const compiled = validateJobWorkflow(operation, resolved.configuration);
    const workflowValues = validateWorkflowValues(compiled.controls, values);
    return JSON.stringify({ ...resolved.configuration, workflowValues });
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
}

/** The request key makes repeated draft creation safe after a lost HTTP response. */
export function createMediaJob(
  body: JobBody,
  source?: MediaJobRow,
  configurationJson: string | null = source?.configuration_json ?? null,
  inputSnapshots?: readonly MediaRecipeInput[],
) {
  if (source && configurationJson) {
    const { comfyUrl, workflow, timeoutSeconds, workflowValues, characterIds, sourceCharacterIds } =
      JSON.parse(configurationJson) as MediaJobConfiguration;
    configurationJson = JSON.stringify({
      comfyUrl,
      workflow,
      timeoutSeconds,
      workflowValues,
      characterIds,
      sourceCharacterIds,
    });
  }
  const requestKey = optionalString(body, 'requestKey');
  if (!requestKey || !/^[0-9]{1,100}$/.test(requestKey)) {
    throw new HttpError(400, 'A stable requestKey is required');
  }
  const previous = stmt('SELECT id FROM media_jobs WHERE request_key = ?').get(requestKey);
  if (previous) {
    return mediaJobDto(requireMediaJob(Number(previous.id)));
  }

  const operation = parseOperation(body.operation ?? source?.operation);
  const previousInputs: MediaRecipeInput[] = source ? JSON.parse(source.inputs_json) : [];
  const inputs = parseInputs(body.inputs ?? previousInputs, inputSnapshots ?? previousInputs);
  const conversationId =
    optionalNullableId(body, 'contextConversationId') ?? source?.context_conversation_id ?? null;
  if (
    conversationId !== null &&
    !stmt('SELECT id FROM conversations WHERE id = ?').get(conversationId)
  ) {
    throw new HttpError(404, 'Conversation not found');
  }
  const destination = body.destination ?? source?.destination ?? 'gallery';
  if (destination !== 'gallery' && destination !== 'chat') {
    throw new HttpError(400, 'Invalid media destination');
  }
  if (destination === 'chat' && conversationId === null) {
    throw new HttpError(400, 'Chat results require a conversation');
  }
  if (
    operation === 'image-describe' &&
    (destination !== 'gallery' || body.reviewBeforeSave === true || conversationId !== null)
  ) {
    throw new HttpError(400, 'Image descriptions belong to the gallery prompt editor');
  }
  const workflowId = optionalNullableString(body, 'workflowId') ?? source?.workflow_id ?? null;
  const presetId = optionalNullableString(body, 'presetId') ?? source?.preset_id ?? null;
  const instruction = validateText(
    optionalString(body, 'instruction') ?? source?.instruction ?? '',
    'Instruction',
  );
  const prompt = validateText(optionalString(body, 'prompt') ?? source?.prompt ?? '', 'Prompt');
  configurationJson = draftConfiguration(
    operation,
    workflowId,
    inputs,
    configurationJson,
    body.workflowValues,
  );
  const sourceDraft = source?.draft_id ? mediaDraft(source.draft_id) : null;
  const review = body.reviewBeforeSave === true || sourceDraft?.state === 'open';
  let draftId = review && sourceDraft?.state === 'open' ? sourceDraft.id : null;
  if (draftId && sourceDraft?.state === 'open') {
    const unfinished = stmt(`SELECT id FROM media_jobs WHERE draft_id = ?
      AND (state NOT IN ('succeeded', 'failed', 'cancelled') OR submission_id IS NULL)`).get(
      draftId,
    );
    if (unfinished) {
      throw new HttpError(409, 'Finish or cancel the current variation before creating another');
    }
  }
  let id = 0;
  const now = Date.now();

  transaction(() => {
    if (review) {
      draftId ??= Number(stmt('INSERT INTO media_drafts DEFAULT VALUES').run().lastInsertRowid);
      stmt('UPDATE media_drafts SET revision = revision + 1 WHERE id = ?').run(draftId);
    }
    id = Number(
      stmt(`
      INSERT INTO media_jobs (
        operation, workflow_id, preset_id, instruction, prompt,
        context_conversation_id, destination, source_job_id, request_key, created_at, updated_at,
        configuration_json, draft_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        operation,
        workflowId,
        presetId,
        instruction,
        prompt,
        conversationId,
        destination,
        source?.id ?? null,
        requestKey,
        now,
        now,
        configurationJson,
        draftId,
      ).lastInsertRowid,
    );
    pinMediaInputs(id, inputs);
  });
  publishMediaJob(id);
  return mediaJobDto(requireMediaJob(id));
}

export function editMediaJob(row: MediaJobRow, body: JobBody) {
  requireEditable(row);
  const inputs =
    body.inputs === undefined ? null : parseInputs(body.inputs, JSON.parse(row.inputs_json));
  const operation = body.operation === undefined ? row.operation : parseOperation(body.operation);
  const requestedWorkflow = optionalNullableString(body, 'workflowId');
  const workflowId = requestedWorkflow === undefined ? row.workflow_id : requestedWorkflow;
  const sameWorkflow = operation === row.operation && workflowId === row.workflow_id;
  const configurationJson = draftConfiguration(
    operation,
    workflowId,
    inputs ?? JSON.parse(row.inputs_json),
    sameWorkflow ? row.configuration_json : null,
    body.workflowValues,
  );
  const previousPaths = stmt(`
    SELECT a.path FROM media_assets a JOIN media_owners o ON o.asset_id = a.id
    WHERE o.owner_type = 'job' AND o.owner_id = ? AND o.slot LIKE 'input:%'
  `)
    .all(row.id)
    .map((asset) => String(asset.path));

  transaction(() => {
    updateMediaJob(row.id, {
      operation,
      workflow_id: workflowId,
      preset_id:
        optionalNullableString(body, 'presetId') === undefined
          ? row.preset_id
          : (body.presetId as string | null),
      instruction: validateText(
        optionalString(body, 'instruction') ?? row.instruction,
        'Instruction',
      ),
      prompt: validateText(optionalString(body, 'prompt') ?? row.prompt, 'Prompt'),
      state: 'draft',
      error: null,
      configuration_json: configurationJson,
      context_json: null,
      endpoint_json: null,
    });
    if (inputs) {
      pinMediaInputs(row.id, inputs);
    }
  });
  deleteImageFiles(previousPaths);
  publishMediaJob(row.id);
  return mediaJobDto(requireMediaJob(row.id));
}

/** Saved recipes outlive job history and keep their own local reference owners. */
export function createMediaJobFromAsset(assetId: number, body: JobBody) {
  const recipe = stmt(`
    SELECT r.*, COALESCE(g.prompt, r.prompt) AS saved_prompt FROM media_assets a
    JOIN media_recipes r ON r.id = a.recipe_id
    LEFT JOIN media_owners gallery_owner ON gallery_owner.asset_id = a.id AND gallery_owner.owner_type = 'gallery'
    LEFT JOIN gallery_items g ON g.id = CAST(gallery_owner.owner_id AS INTEGER)
    WHERE a.id = ? AND EXISTS (SELECT 1 FROM media_owners o WHERE o.asset_id = a.id)
  `).get(assetId);
  if (!recipe) {
    throw new HttpError(404, 'This media has no saved generation recipe');
  }
  return createMediaJobFromRecipe(
    Number(recipe.id),
    { prompt: recipe.saved_prompt, ...body },
    mediaCharacterIds(assetId),
  );
}

export function createMediaJobFromRecipe(recipeId: number, body: JobBody, characterIds?: number[]) {
  const recipe = getMediaRecipe(recipeId);
  const configuration = { ...recipe.configuration };
  configuration.sourceCharacterIds = characterIds ?? configuration.characterIds;
  if (characterIds !== undefined) configuration.characterIds = characterIds;
  return createMediaJob(
    {
      operation: configuration.workflow.operation,
      workflowId: configuration.workflow.id,
      prompt: recipe.prompt,
      instruction: recipe.instruction,
      inputs: recipe.inputs.filter(
        (input): input is MediaJobInputSnapshot => input.assetId !== null,
      ),
      ...body,
    },
    undefined,
    JSON.stringify(configuration),
    recipe.inputs,
  );
}

/** Snapshot the exact text request without persisting endpoint credentials. */
function prepareContext(row: MediaJobRow, workflow: MediaWorkflow) {
  const settings = getSettings();
  const conversation = row.operation === 'image-edit' ? null : conversationForJob(row);
  const chatImage = row.operation === 'image' && conversation !== null;
  let presetId: string | null;
  let template = defaultMediaPrompt(row.operation);
  let chatPrompt = defaultChatMediaPrompt(row.operation);
  if (chatImage) {
    const preset =
      row.preset_id === null
        ? defaultChatImagePrompt(settings.imageGeneration, row.instruction)
        : chatImagePromptPresets(settings.imageGeneration, Boolean(row.instruction.trim())).find(
            (item) => item.id === row.preset_id,
          );
    if (!preset) {
      throw new HttpError(400, 'Choose a chat image prompt preset');
    }
    presetId = preset.id;
    chatPrompt = preset.prompt;
  } else {
    const prompts = settings[mediaPromptSettingsKey(row.operation, conversation !== null)];
    presetId =
      row.preset_id ??
      (conversation ? workflow.chatPromptPresetId : workflow.galleryPromptPresetId) ??
      prompts.defaults[row.operation] ??
      null;
    if (presetId) {
      const preset = prompts.presets.find(
        (item) => item.id === presetId && item.operation === row.operation,
      );
      if (!preset) {
        throw new HttpError(400, 'The selected prompt preset is unavailable');
      }
      if ('chatPrompt' in preset) chatPrompt = preset.chatPrompt;
      else template = preset;
    }
  }

  if (conversation && hasActiveNonToolGeneration(conversation.id)) {
    throw new HttpError(
      409,
      'Wait for the current chat reply to finish before preparing a media prompt',
    );
  }
  const context = conversation
    ? buildChatMessages(conversation, getActivePath(conversation.id))
    : null;
  const values: Record<string, string> = {
    instruction: row.instruction,
    prompt: row.prompt,
    char: context?.charName ?? 'Assistant',
    user: context?.userName ?? 'User',
    first_frame_prompt: '',
    reference1_prompt: '',
    reference2_prompt: '',
    reference3_prompt: '',
  };
  const inputs = JSON.parse(row.inputs_json) as MediaJobInputSnapshot[];
  for (const input of inputs) values[`${input.slot}_prompt`] = input.prompt;
  const expand = (text: string) => expandTemplate(text, values);
  let messages: ChatMessage[];
  let capturedTemplate: StandalonePromptTemplate;
  if (context) {
    // Match the original image tool: retain the structured chat prefix, including
    // assistant reasoning, and append only the media task for prefix-cache reuse.
    const steering = expand(systemNote(chatPrompt));
    messages = context.messages;
    appendChatMessage(messages, { role: 'user', content: steering });
    capturedTemplate = {
      systemPrompt: '',
      userMessage: steering,
      reasoningPrefill: context.reasoningPrefill ?? '',
      messagePrefill: '',
    };
  } else {
    capturedTemplate = {
      systemPrompt: expand(template.systemPrompt),
      userMessage: expand(template.userMessage),
      reasoningPrefill: expand(template.reasoningPrefill),
      messagePrefill: expand(template.messagePrefill),
    };
    messages = [];
    if (capturedTemplate.systemPrompt.trim()) {
      messages.push({ role: 'system', content: capturedTemplate.systemPrompt });
    }
    messages.push({ role: 'user', content: capturedTemplate.userMessage });
  }
  const endpoint = resolveEndpoint(conversation);
  const { apiKey: _credential, ...capturedEndpoint } = endpoint;
  const capturedContext: MediaPromptContext = { messages, template: capturedTemplate };
  return {
    context_json: JSON.stringify(capturedContext),
    endpoint_json: JSON.stringify(capturedEndpoint),
    preset_id: presetId ?? null,
  };
}

/** All branch checks and message creation happen before asynchronous execution. */
function attachToolMessage(row: MediaJobRow, body: JobBody, preparing: boolean): number | null {
  if (row.destination !== 'chat' || row.draft_id !== null) {
    return null;
  }
  const conversation = conversationForJob(row);
  if (!conversation) {
    throw new HttpError(409, 'The source conversation was deleted');
  }
  if (row.message_id !== null) {
    return row.message_id;
  }
  // A previously attached message that was deleted must never be recreated.
  if (row.started_at !== null) {
    throw new HttpError(409, 'The destination message was deleted; create a new job');
  }
  requireExpectedActiveLeaf(
    conversation.id,
    body.expectedActiveLeafId as number | null | undefined,
    body.expectedMutationRevision as number | undefined,
  );
  discardSpeculativeSwipes(conversation.id);
  const message = appendMessage(
    conversation.id,
    'tool',
    row.prompt,
    conversation.activeLeafId,
    preparing ? 'streaming' : 'done',
    null,
    'Media prompt',
  );
  return message.id;
}

export function startMediaJob(row: MediaJobRow, body: JobBody, prepare: boolean) {
  requireEditable(row);
  const inputs = parseInputs(JSON.parse(row.inputs_json));
  const resolved = resolveJobConfiguration(
    row.operation,
    row.workflow_id,
    inputs,
    row.configuration_json,
  );
  if (!resolved) {
    throw new HttpError(400, 'Choose a saved workflow matching the operation and reference count');
  }
  const { configuration } = resolved;
  const { workflow } = configuration;
  const compiled = validateJobWorkflow(row.operation, configuration);
  const requiredSlots = mediaInputSlots(row.operation, workflow.referenceCount);
  if (
    requiredSlots.length !== inputs.length ||
    !requiredSlots.every((slot) => inputs.some((input) => input.slot === slot))
  ) {
    throw new HttpError(400, `Select the required images: ${requiredSlots.join(', ')}`);
  }
  if (row.operation === 'image-describe' && prepare) {
    throw new HttpError(400, 'Image descriptions use the instruction inside the Comfy workflow');
  }
  if (!prepare && row.operation !== 'image-describe' && !row.prompt.trim()) {
    throw new HttpError(400, 'Enter a final prompt before rendering');
  }
  try {
    validateWorkflowValues(compiled.controls, configuration.workflowValues ?? {});
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  configuration.characterIds = captureMediaCharacters(row, configuration);
  if (row.operation === 'image-describe') configuration.temporary = true;
  const context = prepare ? prepareContext(row, workflow) : {};
  const now = Date.now();
  const previousInputs =
    row.message_id === null
      ? []
      : stmt(`
    SELECT a.path FROM messages m
    JOIN media_owners o ON o.owner_type = 'recipe' AND o.owner_id = m.render_recipe_id
    JOIN media_assets a ON a.id = o.asset_id WHERE m.id = ?
  `)
          .all(row.message_id)
          .map((input) => String(input.path));
  transaction(() => {
    const messageId = attachToolMessage(row, body, prepare);
    if (messageId !== null) {
      const recipeId = saveMediaRecipe(configuration, JSON.parse(row.inputs_json), row.prompt, {
        id: row.recipe_id ?? undefined,
        instruction: row.instruction,
      });
      stmt('UPDATE messages SET render_recipe_id = ? WHERE id = ?').run(recipeId, messageId);
      updateMediaJob(row.id, { recipe_id: recipeId });
    }
    updateMediaJob(row.id, {
      ...context,
      workflow_id: workflow.id,
      configuration_json: JSON.stringify(configuration),
      message_id: messageId,
      state: prepare ? 'preparing' : 'submitting',
      prompt: prepare ? '' : row.prompt,
      error: null,
      auto_render: body.autoRender === true ? 1 : 0,
      started_at: now,
      deadline:
        prepare || configuration.timeoutSeconds === 0
          ? null
          : now + configuration.timeoutSeconds * 1000,
      seed: Math.floor(Math.random() * 0xffff_ffff),
    });
    syncMediaJobMessage(requireMediaJob(row.id));
  });
  if (previousInputs.length > 0) {
    queueMicrotask(() => deleteImageFiles(previousInputs));
  }
  publishMediaJob(row.id);
  return mediaJobDto(requireMediaJob(row.id));
}

/** Called inside the same transaction as the job's terminal text/state write. */
export function syncMediaJobMessage(row: MediaJobRow): void {
  if (row.message_id === null) {
    return;
  }
  const message = stmt(
    'SELECT conversation_id, content, status, gen_meta_json FROM messages WHERE id = ?',
  ).get(row.message_id);
  if (!message) {
    return;
  }
  const conversationId = Number(message.conversation_id);
  if (row.state !== 'preparing') {
    stmt('UPDATE media_recipes SET prompt = ? WHERE id = ? AND prompt <> ?').run(
      row.prompt,
      row.id,
      row.prompt,
    );
  }
  const meta = message.gen_meta_json ? JSON.parse(String(message.gen_meta_json)) : {};
  if (row.error) {
    meta.imageError = row.error;
  } else {
    delete meta.imageError;
  }
  const status =
    row.state === 'preparing' ? 'streaming' : row.state === 'failed' ? 'error' : 'done';
  const renderOnly =
    row.configuration_json !== null &&
    (JSON.parse(row.configuration_json) as MediaJobConfiguration).messageRenderOnly === true;
  stmt(`
    UPDATE messages SET content = ?, status = ?, image_pending = ?, gen_meta_json = ? WHERE id = ?
  `).run(
    renderOnly ? String(message.content) : row.prompt,
    renderOnly ? String(message.status) : status,
    mediaJobActive(row.state) ? 1 : 0,
    JSON.stringify(meta),
    row.message_id,
  );
  bumpConversationRevision(conversationId);
  markMessageDirty(conversationId, row.message_id);
  broadcastTree(conversationId);
}

export function cancelMediaJob(row: MediaJobRow) {
  if (!mediaJobActive(row.state)) {
    return mediaJobDto(row);
  }
  const prompt = mediaLive.get(row.id)?.prompt ?? row.prompt;
  const state = row.state === 'preparing' ? 'cancelled' : 'cancelling';
  transaction(() => {
    const next = updateMediaJob(row.id, { state, prompt, auto_render: 0 });
    syncMediaJobMessage(next);
  });
  if (state === 'cancelled') {
    mediaLive.delete(row.id);
    if (row.message_id !== null) {
      mediaPromptBuffers.delete(row.message_id);
    }
  }
  publishMediaJob(row.id);
  return mediaJobDto(requireMediaJob(row.id));
}

export function retryMediaRetrieval(row: MediaJobRow) {
  if (
    row.state !== 'failed' ||
    !row.comfy_prompt_id ||
    !row.retention_deadline ||
    row.retention_deadline <= Date.now()
  ) {
    throw new HttpError(409, 'No retained Comfy result is available for retrieval');
  }
  const configuration = JSON.parse(row.configuration_json!) as MediaJobConfiguration;
  const next = updateMediaJob(row.id, {
    state: 'downloading',
    error: null,
    deadline:
      configuration.timeoutSeconds === 0 ? null : Date.now() + configuration.timeoutSeconds * 1000,
  });
  publishMediaJob(row.id);
  return mediaJobDto(next);
}

/** Caller holds a transaction; file deletion and client notifications follow commit. */
export function deleteMediaJobRecord(id: number): void {
  releaseRemoteFiles(id);
  stmt('DELETE FROM media_jobs WHERE id = ?').run(id);
  stmt("DELETE FROM media_remote_files WHERE job_id = ? AND state = 'deleted'").run(id);
}

export function deleteMediaJob(row: MediaJobRow): void {
  if (mediaJobActive(row.state)) {
    throw new HttpError(409, 'Cancel the active job before removing its history');
  }
  const paths = stmt(`
    SELECT a.path FROM media_assets a JOIN media_owners o ON o.asset_id = a.id
    WHERE o.owner_type = 'job' AND o.owner_id = ?
  `)
    .all(row.id)
    .map((asset) => String(asset.path));
  transaction(() => deleteMediaJobRecord(row.id));
  mediaLive.delete(row.id);
  deleteImageFiles(paths);
  broadcast({ t: 'mediaJobDeleted', id: row.id });
}

export function touchMediaConversation(id: number): void {
  stmt('UPDATE conversations SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?').run(
    Date.now(),
    id,
  );
  invalidate('conversations');
}
