import {
  mediaInputSlots,
  normalizeMediaWorkflowInputs,
  mediaWorkflowError,
  MEDIA_INPUT_NAME,
  MAX_MEDIA_INPUTS,
  MAX_MEDIA_PRESETS,
  type MediaCollectionFolder,
  type MediaImageConfig,
  type MediaFavorite,
  type MediaInputBindings,
  type MediaInputContext,
  type MediaInputSource,
  type MediaPromptSettingsKey,
  type MediaPromptSettings,
  type MediaRenderingSettings,
  type MediaWorkflow,
  type MediaPromptPreset,
} from '@tinytavern/shared';
import { HttpError } from '../http/router.ts';
import { requireObject as object, requireString as string } from '../http/validation.ts';

function id(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(result)) throw new HttpError(400, `Invalid ${label}`);
  return result;
}
const nullableId = (value: unknown, label: string) => (value == null ? null : id(value, label));

export function parseComfyUrl(value: unknown): string {
  const comfyUrl = string(value, 'Comfy URL').trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(comfyUrl);
  } catch {
    throw new HttpError(400, 'Enter a valid Comfy HTTP URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new HttpError(400, 'Comfy URL must be HTTP(S) without credentials, query, or fragment');
  return comfyUrl;
}

export function parseMediaWorkflow(
  entry: unknown,
  ids?: Set<string>,
  normalizeInputs = true,
): MediaWorkflow {
  const item = object(entry, 'workflow');
  const inputBindings: MediaInputBindings = {};
  for (const [context, raw] of Object.entries(object(item.inputBindings ?? {}, 'input bindings'))) {
    if (!['chat', 'standalone', 'avatar'].includes(context))
      throw new HttpError(400, 'Unknown input context');
    const bindings = object(raw, 'input bindings');
    if (Object.keys(bindings).length > MAX_MEDIA_INPUTS)
      throw new HttpError(400, 'Too many input bindings');
    const entries = Object.entries(bindings).map(([slot, source]) => {
      if (
        !MEDIA_INPUT_NAME.test(slot) ||
        typeof source !== 'string' ||
        (!['character-avatar', 'persona-avatar'].includes(source) &&
          !/^selected:([1-9]|[1-5][0-9]|6[0-4])$/.test(source))
      )
        throw new HttpError(400, 'Invalid automatic image binding');
      return [slot, source as MediaInputSource] as const;
    });
    inputBindings[context as MediaInputContext] = Object.fromEntries(entries);
  }
  const workflow: MediaWorkflow = {
    id: id(item.id, 'workflow ID'),
    name: string(item.name, 'workflow name').trim(),
    json: string(item.json, 'workflow JSON'),
    standalonePromptPresetId: nullableId(
      item.standalonePromptPresetId,
      'standalone prompt preset ID',
    ),
    chatPromptPresetId: nullableId(item.chatPromptPresetId, 'chat prompt preset ID'),
    textOutputNodeId:
      item.textOutputNodeId == null ? null : string(item.textOutputNodeId, 'text output node ID'),
    inputBindings,
  };
  if (!workflow.name || workflow.name.length > 200 || ids?.has(workflow.id))
    throw new HttpError(400, 'Workflow names must be nonempty and IDs unique');
  if (workflow.json.length > 2 * 1024 * 1024)
    throw new HttpError(400, 'Workflow JSON is too large');
  ids?.add(workflow.id);
  const invalid = workflow.json.trim() ? mediaWorkflowError(workflow) : null;
  if (invalid) throw new HttpError(400, `${workflow.name}: ${invalid}`);
  return normalizeInputs ? normalizeMediaWorkflowInputs(workflow).workflow : workflow;
}

/** Direct rendering has no input editor; all required image bindings must be absent. */
export function parseImageConfig(raw: unknown): MediaImageConfig {
  const obj = object(raw, 'render configuration');
  const comfyUrl = parseComfyUrl(obj.comfyUrl);
  const workflow = parseMediaWorkflow(obj.workflow);
  if (
    !workflow.json.trim() ||
    workflow.textOutputNodeId !== null ||
    mediaInputSlots(workflow).length
  ) {
    throw new HttpError(400, 'Choose a configured media workflow with no image inputs');
  }
  return { workflow, comfyUrl };
}

export function parseMediaRendering(value: unknown): MediaRenderingSettings | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, 'mediaRendering');
  const comfyUrl = parseComfyUrl(raw.comfyUrl);
  if (!Array.isArray(raw.workflows) || raw.workflows.length > 500)
    throw new HttpError(400, 'Invalid workflows');
  const ids = new Set<string>();
  const workflows = raw.workflows.map((entry) => parseMediaWorkflow(entry, ids));
  if (new Set(workflows.map((workflow) => workflow.name.toLowerCase())).size !== workflows.length)
    throw new HttpError(400, 'Workflow names must be unique');
  const select = (value: unknown, label: string) => {
    const selected = nullableId(value, label);
    if (selected && !workflows.some((item) => item.id === selected && item.json.trim()))
      throw new HttpError(400, `Choose a configured ${label}`);
    return selected;
  };
  const defaultWorkflowId = select(raw.defaultWorkflowId, 'default workflow');
  const avatarWorkflowId = select(raw.avatarWorkflowId, 'avatar workflow');
  const descriptionWorkflowId = select(raw.descriptionWorkflowId, 'description workflow');
  if (
    descriptionWorkflowId &&
    !workflows.find((item) => item.id === descriptionWorkflowId)?.textOutputNodeId
  )
    throw new HttpError(400, 'The description workflow needs a text output binding');
  if (!Array.isArray(raw.shortcuts) || raw.shortcuts.length > 500)
    throw new HttpError(400, 'Invalid workflow shortcuts');
  const shortcutIds = new Set<string>();
  const shortcuts = raw.shortcuts.map((entry) => {
    const item = object(entry, 'shortcut');
    const shortcut = {
      id: id(item.id, 'shortcut ID'),
      name: string(item.name, 'shortcut name').trim(),
      workflowId: select(item.workflowId, 'shortcut workflow'),
    };
    if (
      !shortcut.name ||
      shortcut.name.length > 200 ||
      !shortcut.workflowId ||
      shortcutIds.has(shortcut.id)
    )
      throw new HttpError(400, 'Shortcuts require a name, unique ID and configured workflow');
    shortcutIds.add(shortcut.id);
    return { ...shortcut, workflowId: shortcut.workflowId };
  });
  const folders = parseCollectionFolders(raw.folders, ids, 'workflowIds');
  const jobTimeoutSeconds = raw.jobTimeoutSeconds;
  if (
    !Number.isInteger(jobTimeoutSeconds) ||
    (jobTimeoutSeconds !== 0 && (jobTimeoutSeconds as number) < 60) ||
    (jobTimeoutSeconds as number) > 86400
  )
    throw new HttpError(400, 'Job timeout must be 0 (unlimited) or between 60 and 86400 seconds');
  return {
    comfyUrl,
    workflows,
    folders,
    defaultWorkflowId,
    avatarWorkflowId,
    descriptionWorkflowId,
    shortcuts,
    jobTimeoutSeconds: jobTimeoutSeconds as number,
  };
}

function parseCollectionFolders<K extends string>(
  value: unknown,
  entityIds: Set<string>,
  memberKey: K,
): MediaCollectionFolder<K>[] {
  const folderIds = new Set<string>();
  const folderNames = new Set<string>();
  const assigned = new Set<string>();
  const raw = value ?? [];
  if (!Array.isArray(raw) || raw.length > 500) throw new HttpError(400, 'Invalid folders');
  return raw.map((entry) => {
    const item = object(entry, 'folder');
    const folderId = id(item.id, 'folder ID');
    const name = string(item.name, 'folder name').trim();
    const members = item[memberKey];
    if (
      !name ||
      name.length > 200 ||
      folderIds.has(folderId) ||
      folderNames.has(name.toLowerCase()) ||
      !Array.isArray(members)
    )
      throw new HttpError(400, 'Folders require unique names and IDs');
    folderIds.add(folderId);
    folderNames.add(name.toLowerCase());
    const ids = members.map((value) => {
      const entityId = id(value, 'folder member ID');
      if (!entityIds.has(entityId) || assigned.has(entityId))
        throw new HttpError(400, 'Each item must belong to at most one existing folder');
      assigned.add(entityId);
      return entityId;
    });
    return { id: folderId, name, [memberKey]: ids } as MediaCollectionFolder<K>;
  });
}

export function parseMediaPrompts(
  value: unknown,
  key: MediaPromptSettingsKey,
): MediaPromptSettings | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, key);
  if (!Array.isArray(raw.presets) || raw.presets.length > MAX_MEDIA_PRESETS)
    throw new HttpError(400, 'Invalid media prompt presets');
  const chat = key === 'mediaChatPrompts';
  const ids = new Set<string>();
  const names = new Set<string>();
  const presets = raw.presets.map((entry): MediaPromptPreset => {
    const item = object(entry, 'prompt preset');
    const identity = {
      id: id(item.id, 'preset ID'),
      name: string(item.name, 'preset name').trim(),
    };
    const fields = chat
      ? ['chatPrompt']
      : ['systemPrompt', 'userMessage', 'reasoningPrefill', 'messagePrefill'];
    for (const field of Object.keys(item)) {
      if (!['id', 'name', ...fields].includes(field))
        throw new HttpError(400, `Unexpected prompt field: ${field}`);
    }
    for (const field of fields) {
      string(item[field], field);
    }
    if (
      !identity.name ||
      ids.has(identity.id) ||
      names.has(identity.name.toLowerCase()) ||
      !String(item[chat ? 'chatPrompt' : 'userMessage']).trim()
    )
      throw new HttpError(
        400,
        'Presets require a unique name and ID, and nonempty prompt instruction',
      );
    ids.add(identity.id);
    names.add(identity.name.toLowerCase());
    return chat
      ? { ...identity, chatPrompt: item.chatPrompt as string }
      : {
          ...identity,
          systemPrompt: item.systemPrompt as string,
          userMessage: item.userMessage as string,
          reasoningPrefill: item.reasoningPrefill as string,
          messagePrefill: item.messagePrefill as string,
        };
  });
  const defaultPresetId = nullableId(raw.defaultPresetId, 'default prompt preset ID');
  if (defaultPresetId && !presets.some((preset) => preset.id === defaultPresetId))
    throw new HttpError(400, 'Invalid default prompt preset');
  return {
    presets,
    defaultPresetId,
    folders: parseCollectionFolders(raw.folders, ids, 'presetIds'),
  };
}

export function parseMediaFavorites(value: unknown): MediaFavorite[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_MEDIA_PRESETS)
    throw new HttpError(400, 'Invalid media favorites');
  const ids = new Set<string>();
  return value.map((raw) => {
    const item = object(raw, 'favorite');
    const favorite = {
      id: id(item.id, 'favorite ID'),
      name: string(item.name, 'favorite name').trim(),
      presetId: id(item.presetId, 'favorite prompt preset ID'),
      workflowId: id(item.workflowId, 'favorite workflow ID'),
    };
    if (!favorite.name || ids.has(favorite.id))
      throw new HttpError(400, 'Favorites require a name and unique ID');
    ids.add(favorite.id);
    return favorite;
  });
}
