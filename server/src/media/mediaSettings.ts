import {
  mediaInputSlots,
  compileMediaWorkflow,
  mediaWorkflowError,
  NUMBERED_MEDIA_INPUT,
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
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new HttpError(400, 'Comfy URL must be HTTP(S) without credentials, query, or fragment');
  return comfyUrl;
}

export function parseMediaWorkflow(entry: unknown, ids?: Set<string>): MediaWorkflow {
  const item = object(entry, 'workflow');
  const inputBindings: MediaInputBindings = {};
  for (const [context, raw] of Object.entries(object(item.inputBindings ?? {}, 'input bindings'))) {
    if (!['chat', 'standalone', 'avatar'].includes(context)) throw new HttpError(400, 'Unknown input context');
    const bindings = object(raw, 'input bindings');
    if (Object.keys(bindings).length > MAX_MEDIA_INPUTS) throw new HttpError(400, 'Too many input bindings');
    const entries = Object.entries(bindings).map(([slot, source]) => {
      if (
        !NUMBERED_MEDIA_INPUT.test(slot) ||
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
    folderId: nullableId(item.folderId, 'folder ID'),
    name: string(item.name, 'workflow name').trim(),
    json: string(item.json, 'workflow JSON'),
    standalonePromptPresetId: nullableId(item.standalonePromptPresetId, 'standalone prompt preset ID'),
    chatPromptPresetId: nullableId(item.chatPromptPresetId, 'chat prompt preset ID'),
    textOutputNodeId: item.textOutputNodeId == null ? null : string(item.textOutputNodeId, 'text output node ID'),
    inputBindings,
  };
  if (!workflow.name || workflow.name.length > 200 || ids?.has(workflow.id))
    throw new HttpError(400, 'Workflow names must be nonempty and IDs unique');
  if (workflow.json.length > 2 * 1024 * 1024) throw new HttpError(400, 'Workflow JSON is too large');
  ids?.add(workflow.id);
  const invalid = workflow.json.trim() ? mediaWorkflowError(workflow) : null;
  if (invalid) throw new HttpError(400, `${workflow.name}: ${invalid}`);
  return workflow;
}

/** Direct rendering has no input editor; all required image bindings must be absent. */
export function parseImageConfig(raw: unknown): MediaImageConfig {
  const obj = object(raw, 'render configuration');
  const comfyUrl = parseComfyUrl(obj.comfyUrl);
  const workflow = parseMediaWorkflow(obj.workflow);
  if (!workflow.json.trim() || workflow.textOutputNodeId !== null || mediaInputSlots(workflow).length) {
    throw new HttpError(400, 'Choose a configured media workflow with no media inputs');
  }
  return { workflow, comfyUrl };
}

export function validateWorkflowSelection(
  workflow: MediaWorkflow | undefined,
  purpose: 'default' | 'avatar' | 'description' | 'shortcut',
): void {
  if (!workflow?.json.trim()) {
    throw new HttpError(400, `Choose a configured ${purpose} workflow`);
  }
  if (purpose === 'description' && !workflow.textOutputNodeId) {
    throw new HttpError(400, 'The description workflow needs a text output binding');
  }
}

export function parseMediaRendering(value: unknown): MediaRenderingSettings | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, 'mediaRendering');
  const comfyUrl = parseComfyUrl(raw.comfyUrl);
  if (!Array.isArray(raw.workflows) || raw.workflows.length > 500) throw new HttpError(400, 'Invalid workflows');
  const ids = new Set<string>();
  const workflows = raw.workflows.map((entry) => parseMediaWorkflow(entry, ids));
  if (new Set(workflows.map((workflow) => workflow.name.toLowerCase())).size !== workflows.length)
    throw new HttpError(400, 'Workflow names must be unique');
  const workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const select = (value: unknown, purpose: Parameters<typeof validateWorkflowSelection>[1]) => {
    const selected = nullableId(value, `${purpose} workflow`);
    if (selected) {
      validateWorkflowSelection(workflowsById.get(selected), purpose);
    }
    return selected;
  };
  const defaultWorkflowId = select(raw.defaultWorkflowId, 'default');
  const avatarWorkflowId = select(raw.avatarWorkflowId, 'avatar');
  const descriptionWorkflowId = select(raw.descriptionWorkflowId, 'description');
  if (!Array.isArray(raw.shortcuts) || raw.shortcuts.length > 500)
    throw new HttpError(400, 'Invalid workflow shortcuts');
  const shortcutIds = new Set<string>();
  const shortcuts = raw.shortcuts.map((entry) => {
    const item = object(entry, 'shortcut');
    const shortcut = {
      id: id(item.id, 'shortcut ID'),
      name: string(item.name, 'shortcut name').trim(),
      workflowId: select(item.workflowId, 'shortcut'),
    };
    if (!shortcut.name || shortcut.name.length > 200 || !shortcut.workflowId || shortcutIds.has(shortcut.id))
      throw new HttpError(400, 'Shortcuts require a name, unique ID and configured workflow');
    shortcutIds.add(shortcut.id);
    return { ...shortcut, workflowId: shortcut.workflowId };
  });
  const folders = parseCollectionFolders(raw.folders, workflows);
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

function parseCollectionFolders(value: unknown, items: { folderId?: string | null }[]): MediaCollectionFolder[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  const raw = value ?? [];
  if (!Array.isArray(raw) || raw.length > 500) throw new HttpError(400, 'Invalid folders');
  const folders = raw.map((entry) => {
    const item = object(entry, 'folder');
    const folderId = id(item.id, 'folder ID');
    const name = string(item.name, 'folder name').trim();
    if (
      !name ||
      name.length > 200 ||
      ids.has(folderId) ||
      names.has(name.toLowerCase()) ||
      Object.keys(item).some((key) => key !== 'id' && key !== 'name')
    )
      throw new HttpError(400, 'Folders require unique names and IDs');
    ids.add(folderId);
    names.add(name.toLowerCase());
    return { id: folderId, name };
  });
  if (items.some((item) => item.folderId != null && !ids.has(item.folderId)))
    throw new HttpError(400, 'The folder is unavailable');
  return folders;
}

export function parseMediaPrompts(value: unknown, key: MediaPromptSettingsKey): MediaPromptSettings | undefined {
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
      folderId: nullableId(item.folderId, 'folder ID'),
      name: string(item.name, 'preset name').trim(),
    };
    const fields = chat ? ['chatPrompt'] : ['systemPrompt', 'userMessage', 'reasoningPrefill', 'messagePrefill'];
    for (const field of Object.keys(item)) {
      if (!['id', 'name', 'folderId', 'revision', ...fields].includes(field))
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
      throw new HttpError(400, 'Presets require a unique name and ID, and nonempty prompt instruction');
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
    folders: parseCollectionFolders(raw.folders, presets),
  };
}

export function parseMediaFavorites(value: unknown): MediaFavorite[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_MEDIA_PRESETS) throw new HttpError(400, 'Invalid media favorites');
  const ids = new Set<string>();
  return value.map((raw) => {
    const item = object(raw, 'favorite');
    const favorite = {
      id: id(item.id, 'favorite ID'),
      name: string(item.name, 'favorite name').trim(),
      presetId: id(item.presetId, 'favorite prompt preset ID'),
      workflowId: id(item.workflowId, 'favorite workflow ID'),
    };
    if (!favorite.name || ids.has(favorite.id)) throw new HttpError(400, 'Favorites require a name and unique ID');
    ids.add(favorite.id);
    return favorite;
  });
}

/** Shared by whole-page settings writes and individual workflow/favorite edits. */
export function supportsMediaFavorite(workflow: MediaWorkflow | undefined): boolean {
  if (!workflow || !workflow.json.trim() || workflow.textOutputNodeId !== null) return false;
  const compiled = compileMediaWorkflow(workflow.json);
  return compiled.mediaInputs.length === 0 && compiled.slots.has('prompt');
}
