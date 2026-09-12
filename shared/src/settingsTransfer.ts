import { ENTITY_FIELDS } from './entityFields.ts';
import { nextCollectionId } from './numericIds.ts';
import type { Settings, MediaPromptPreset, MediaWorkflow, MediaCollectionFolder } from './index.ts';
import { mediaWorkflowError, MAX_MEDIA_PRESETS } from './media.ts';

export interface SettingsTransferDocument {
  format: 'tinytavern-settings';
  version: 1;
  type: string;
  data: unknown;
}

export function transferDocument(type: string, data: unknown): SettingsTransferDocument {
  return { format: 'tinytavern-settings', version: 1, type, data };
}
export function transferObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}
export function transferData(value: unknown, type: string): unknown {
  const document = transferObject(value);
  if (document.format !== 'tinytavern-settings' || document.version !== 1)
    throw new Error('Unsupported settings file format or version');
  if (document.type !== type) throw new Error(`This file contains ${document.type}, not ${type}`);
  return document.data;
}
export function transferString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  return value;
}
export function transferArray(value: unknown, maximum = 500): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Expected a list of at most ${maximum} items`);
  return value.map(transferObject);
}

/** A unique exact name wins; otherwise accept a unique case-insensitive match. */
export function namedItem<T extends { name: string }>(items: readonly T[], name: unknown): T | undefined {
  if (typeof name !== 'string') return undefined;
  const exact = items.filter((item) => item.name === name);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const matches = items.filter((item) => item.name.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}

/** Collection matching consumes occurrences; references still require a unique namedItem. */
export function takeNamedCollectionItem<T extends { name: string }>(
  current: readonly T[],
  remaining: Set<T>,
  name: string,
): T | undefined {
  const available = (candidate: T) => remaining.has(candidate);
  const existing =
    current.find((candidate) => available(candidate) && candidate.name === name) ??
    current.find((candidate) => available(candidate) && candidate.name.toLowerCase() === name.toLowerCase());
  if (existing) remaining.delete(existing);
  return existing;
}

/** Ordered lists may repeat labels. Match each local occurrence once, retaining its identity. */
export function importNamedCollection<T extends { name: string }>(
  incoming: Record<string, unknown>[],
  current: readonly T[],
  decode: (item: Record<string, unknown>, existing: T | undefined) => T,
): T[] {
  const remaining = new Set(current);
  const imported = incoming.map((item) => {
    const name = transferString(item.name, 'Name');
    if (!name.trim()) throw new Error('Setting names must be nonempty');
    return decode(item, takeNamedCollectionItem(current, remaining, name));
  });
  return [...imported, ...remaining];
}

export const ENTITY_TRANSFER_FIELDS = {
  presets: Object.keys(ENTITY_FIELDS.presets),
  templates: Object.keys(ENTITY_FIELDS.templates),
  endpoints: Object.keys(ENTITY_FIELDS.endpoints).filter((key) => key !== 'apiKey'),
  personas: [...Object.keys(ENTITY_FIELDS.personas), 'avatarData'],
} as const;
export type TransferEntity = keyof typeof ENTITY_TRANSFER_FIELDS;

export function entityTransferData(type: TransferEntity, value: unknown): Record<string, unknown> {
  const source = transferObject(value);
  const result: Record<string, unknown> = {};
  for (const key of ENTITY_TRANSFER_FIELDS[type]) {
    if (Object.hasOwn(source, key)) result[key] = source[key];
  }
  if (typeof result.name !== 'string' || !result.name.trim()) throw new Error('Enter an item name');
  for (const [key, value] of Object.entries(result)) {
    if (['prefixNames', 'usesPersonas', 'allowReasoningPrefill', 'allowMessagePrefill'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} must be true or false`);
    } else if (key === 'genParams') {
      const params = transferObject(value);
      if (Object.values(params).some((value) => typeof value !== 'number' && typeof value !== 'string'))
        throw new Error('Invalid generation parameters');
    } else if ((key === 'model' || key === 'avatarData' || key === 'folderId') && value === null) {
      continue;
    } else transferString(value, key);
  }
  return result;
}

export const GENERAL_TRANSFER_FIELDS = [
  'galleryThumbnailSize',
  'autoExpandThinking',
  'backgroundSwipeGeneration',
  'parallelBackgroundSwipeGeneration',
  'titlePrompt',
  'draftCompletionPrompt',
] as const;
function exportCollectionFolders<N extends string>(
  folders: MediaCollectionFolder[],
  items: { id: string; name: string; folderId?: string | null }[],
  namesKey: N,
) {
  const members = new Map<string, string[]>();
  for (const item of items) {
    if (item.folderId == null) continue;
    const names = members.get(item.folderId) ?? [];
    names.push(item.name);
    members.set(item.folderId, names);
  }
  return folders.map((folder) => ({ name: folder.name, [namesKey]: members.get(folder.id) ?? [] })) as ({
    name: string;
  } & Record<N, string[]>)[];
}

function importCollectionFolders(
  value: unknown,
  current: MediaCollectionFolder[],
  items: { id: string; name: string; folderId?: string | null }[],
  importedNames: Set<string>,
  namesKey: string,
): MediaCollectionFolder[] {
  const folders = current.map((folder) => ({ ...folder }));
  if (value !== undefined) {
    for (const item of items) {
      if (importedNames.has(item.name.toLowerCase())) item.folderId = null;
    }
  }
  const seen = new Set<string>();
  const assigned = new Set<string>();
  for (const item of transferArray(value ?? [])) {
    const name = transferString(item.name, 'Folder name').trim();
    const members = item[namesKey];
    if (!name || seen.has(name.toLowerCase()) || !Array.isArray(members))
      throw new Error('Invalid or duplicate folders');
    seen.add(name.toLowerCase());
    let folder = namedItem(folders, name);
    if (!folder) {
      folder = { id: nextCollectionId(folders), name };
      folders.push(folder);
    }
    for (const requested of members) {
      const entity = namedItem(items, requested);
      if (!entity || assigned.has(entity.id))
        throw new Error('Folder members must exist and belong to only one folder');
      assigned.add(entity.id);
      entity.folderId = folder.id;
    }
  }
  return folders;
}

export function exportPromptCollection(value: Settings['mediaChatPrompts']) {
  return {
    presets: value.presets.map(({ id, folderId, revision, ...preset }) => preset),
    folders: exportCollectionFolders(value.folders, value.presets, 'presets'),
    defaultPreset: value.presets.find((item) => item.id === value.defaultPresetId)?.name ?? null,
  };
}
export function importPromptCollection(
  value: unknown,
  current: Settings['mediaChatPrompts'],
  chat: boolean,
): Settings['mediaChatPrompts'] {
  const source = transferObject(value);
  const presets = current.presets.map((item) => ({ ...item }));
  const seen = new Set<string>();
  for (const item of transferArray(source.presets, MAX_MEDIA_PRESETS)) {
    const name = transferString(item.name, 'Preset name');
    if (!name.trim() || seen.has(name.toLowerCase())) throw new Error('Preset names must be nonempty and unique');
    seen.add(name.toLowerCase());
    const existing = namedItem(presets, name);
    const fields = chat ? ['chatPrompt'] : ['systemPrompt', 'userMessage', 'reasoningPrefill', 'messagePrefill'];
    const text = Object.fromEntries(fields.map((key) => [key, transferString(item[key], key)]));
    const preset = {
      ...text,
      id: existing?.id ?? nextCollectionId(presets),
      name,
      folderId: existing?.folderId ?? null,
    } as MediaPromptPreset;
    if (existing) presets[presets.indexOf(existing)] = preset;
    else presets.push(preset);
  }
  return {
    presets,
    folders: importCollectionFolders(source.folders, current.folders, presets, seen, 'presets'),
    defaultPresetId:
      source.defaultPreset === null ? null : (namedItem(presets, source.defaultPreset)?.id ?? current.defaultPresetId),
  };
}

export function exportWorkflow(workflow: MediaWorkflow, settings: Settings) {
  const { id, folderId, revision, standalonePromptPresetId, chatPromptPresetId, ...fields } = workflow;
  return {
    ...fields,
    standalonePromptPreset:
      settings.mediaStandalonePrompts.presets.find((item) => item.id === standalonePromptPresetId)?.name ?? null,
    chatPromptPreset: settings.mediaChatPrompts.presets.find((item) => item.id === chatPromptPresetId)?.name ?? null,
  };
}

export function importWorkflow(value: unknown, workflows: MediaWorkflow[], settings: Settings): MediaWorkflow {
  const item = transferObject(value);
  const name = transferString(item.name, 'Workflow name');
  if (!name.trim()) throw new Error('Enter a workflow name');
  const existing = namedItem(workflows, name);
  const resolve = (field: 'standalonePromptPreset' | 'chatPromptPreset', previous: string | null) => {
    const requested = item[field];
    if (requested === null) return null;
    const presets = (field === 'chatPromptPreset' ? settings.mediaChatPrompts : settings.mediaStandalonePrompts)
      .presets;
    return namedItem(presets, requested)?.id ?? previous;
  };
  const workflow: MediaWorkflow = {
    id: existing?.id ?? nextCollectionId(workflows),
    folderId: existing?.folderId ?? null,
    name,
    json: transferString(item.json, 'Workflow JSON'),
    inputBindings: structuredClone(item.inputBindings ?? {}) as MediaWorkflow['inputBindings'],
    textOutputNodeId:
      item.textOutputNodeId == null ? null : transferString(item.textOutputNodeId, 'Text output node ID'),
    standalonePromptPresetId: resolve('standalonePromptPreset', existing?.standalonePromptPresetId ?? null),
    chatPromptPresetId: resolve('chatPromptPreset', existing?.chatPromptPresetId ?? null),
  };
  const error = workflow.json.trim() ? mediaWorkflowError(workflow) : null;
  if (error) throw new Error(error);
  return workflow;
}
export function exportWorkflowLibrary(settings: Settings) {
  const value = settings.mediaRendering;
  return {
    workflows: value.workflows.map((item) => exportWorkflow(item, settings)),
    folders: exportCollectionFolders(value.folders, value.workflows, 'workflows'),
  };
}

export function importWorkflowLibrary(
  value: unknown,
  settings: Settings,
): Pick<Settings['mediaRendering'], 'workflows' | 'folders'> {
  const source = transferObject(value);
  const current = settings.mediaRendering;
  const workflows = current.workflows.map((item) => ({ ...item }));
  const seen = new Set<string>();
  for (const item of transferArray(source.workflows)) {
    const workflow = importWorkflow(item, workflows, settings);
    if (seen.has(workflow.name.toLowerCase())) throw new Error('Duplicate workflow names in the import');
    seen.add(workflow.name.toLowerCase());
    const index = workflows.findIndex((item) => item.id === workflow.id);
    if (index === -1) workflows.push(workflow);
    else workflows[index] = workflow;
  }
  const folders = importCollectionFolders(source.folders, current.folders, workflows, seen, 'workflows');
  return { workflows, folders };
}

export function exportRendering(settings: Settings) {
  const value = settings.mediaRendering;
  const workflowName = (id: string | null) => value.workflows.find((item) => item.id === id)?.name ?? null;
  return {
    ...exportWorkflowLibrary(settings),
    comfyUrl: value.comfyUrl,
    jobTimeoutSeconds: value.jobTimeoutSeconds,
    defaultWorkflow: workflowName(value.defaultWorkflowId),
    avatarWorkflow: workflowName(value.avatarWorkflowId),
    descriptionWorkflow: workflowName(value.descriptionWorkflowId),
    shortcuts: value.shortcuts.map((item) => ({
      name: item.name,
      workflow: workflowName(item.workflowId),
    })),
  };
}
export function importRendering(value: unknown, settings: Settings): Settings['mediaRendering'] {
  const source = transferObject(value);
  const current = settings.mediaRendering;
  const { workflows, folders } = importWorkflowLibrary(source, settings);
  const resolve = (field: string, previous: string | null) =>
    source[field] === null ? null : (namedItem(workflows, source[field])?.id ?? previous);
  const shortcuts = importNamedCollection(
    transferArray(source.shortcuts ?? []),
    current.shortcuts,
    (item, existing) => {
      const name = transferString(item.name, 'Shortcut name');
      const workflow = namedItem(workflows, item.workflow);
      if (!workflow) throw new Error(`Workflow for shortcut ${name} is unavailable`);
      return {
        id: existing?.id ?? nextCollectionId(current.shortcuts),
        name,
        workflowId: workflow.id,
      };
    },
  );
  if (typeof source.jobTimeoutSeconds !== 'number') throw new Error('Invalid job timeout');
  return {
    workflows,
    folders,
    shortcuts,
    comfyUrl: transferString(source.comfyUrl, 'ComfyUI URL'),
    jobTimeoutSeconds: source.jobTimeoutSeconds,
    defaultWorkflowId: resolve('defaultWorkflow', current.defaultWorkflowId),
    avatarWorkflowId: resolve('avatarWorkflow', current.avatarWorkflowId),
    descriptionWorkflowId: resolve('descriptionWorkflow', current.descriptionWorkflowId),
  };
}

export function exportMediaFavorites(settings: Settings) {
  return settings.mediaFavorites.map((favorite) => ({
    name: favorite.name,
    promptPreset: settings.mediaChatPrompts.presets.find((item) => item.id === favorite.presetId)?.name ?? null,
    workflow: settings.mediaRendering.workflows.find((item) => item.id === favorite.workflowId)?.name ?? null,
  }));
}
export function importMediaFavorites(value: unknown, settings: Settings): Settings['mediaFavorites'] {
  return importNamedCollection(transferArray(value, MAX_MEDIA_PRESETS), settings.mediaFavorites, (item, existing) => {
    const name = transferString(item.name, 'Favorite name');
    const preset = namedItem(settings.mediaChatPrompts.presets, item.promptPreset);
    const workflow = namedItem(settings.mediaRendering.workflows, item.workflow);
    if (!preset || !workflow) throw new Error(`Choose the prompt preset and workflow for ${name}`);
    return {
      id: existing?.id ?? nextCollectionId(settings.mediaFavorites),
      name,
      presetId: preset.id,
      workflowId: workflow.id,
    };
  });
}

const IMAGE_PROMPT_TRANSFER_FIELDS = [
  'promptRevisionTemplate',
  'promptRevisionContext',
  'promptRevisionOriginal',
] as const;

/** Keep the rendering document shape compatible with files written before the page was unified. */
export function exportGenerationSettings(settings: Settings) {
  const image = settings.imageGeneration;
  return {
    ...exportRendering(settings),
    mediaFavorites: exportMediaFavorites(settings),
    imageGeneration: {
      ...Object.fromEntries(IMAGE_PROMPT_TRANSFER_FIELDS.map((key) => [key, image[key]])),
      ...(image.promptPresets?.avatar
        ? {
            promptPresets: {
              avatar: {
                active: image.promptPresets.avatar.active,
                presets: image.promptPresets.avatar.presets.map(({ name, prompt, context }) => ({
                  name,
                  prompt,
                  context,
                })),
              },
            },
          }
        : {}),
    },
  };
}

export function importGenerationSettings(
  value: unknown,
  settings: Settings,
): Pick<Settings, 'mediaRendering' | 'mediaFavorites' | 'imageGeneration'> {
  const source = transferObject(value);
  const mediaRendering = importRendering(source, settings);
  const mediaFavorites =
    source.mediaFavorites === undefined
      ? settings.mediaFavorites
      : importMediaFavorites(source.mediaFavorites, { ...settings, mediaRendering });
  const imageGeneration = { ...settings.imageGeneration };
  if (source.imageGeneration !== undefined) {
    const image = transferObject(source.imageGeneration);
    for (const key of Object.keys(image)) {
      if (key !== 'promptPresets' && !IMAGE_PROMPT_TRANSFER_FIELDS.some((field) => field === key))
        throw new Error(`Unknown image prompt setting: ${key}`);
    }
    for (const key of IMAGE_PROMPT_TRANSFER_FIELDS) {
      if (Object.hasOwn(image, key)) imageGeneration[key] = transferString(image[key], key);
    }
    if (image.promptPresets !== undefined) {
      const sets = transferObject(image.promptPresets);
      for (const key of Object.keys(sets)) {
        if (key !== 'avatar') throw new Error(`Unknown image prompt preset collection: ${key}`);
      }
      if (sets.avatar !== undefined) {
        imageGeneration.promptPresets = {
          ...imageGeneration.promptPresets,
          avatar: importImagePromptSet(
            sets.avatar,
            imageGeneration.promptPresets?.avatar ?? { presets: [], active: '' },
            true,
          ),
        };
      }
    }
  }
  return { mediaRendering, mediaFavorites, imageGeneration };
}

export function importImagePromptSet(
  value: unknown,
  current: NonNullable<Settings['imageGeneration']['promptPresets']>[string],
  avatar: boolean,
) {
  const source = transferObject(value);
  transferString(source.active, 'Active preset');
  const presets = current.presets.map((item) => ({ ...item }));
  const seen = new Set<string>();
  for (const item of transferArray(source.presets)) {
    const name = transferString(item.name, 'Preset name');
    if (!name.trim() || name.toLowerCase() === 'default' || seen.has(name.toLowerCase()))
      throw new Error('Preset names must be unique and cannot be Default');
    seen.add(name.toLowerCase());
    const preset = {
      name,
      prompt: transferString(item.prompt, 'Prompt'),
      ...(avatar ? { context: transferString(item.context, 'Context') } : {}),
    };
    if (avatar && !preset.context!.trim()) throw new Error('Avatar presets require a context template.');
    const existing = namedItem(presets, name);
    if (existing)
      presets[presets.indexOf(existing)] = {
        ...preset,
        ...(existing.id === undefined ? {} : { id: existing.id }),
      };
    else presets.push(preset);
  }
  const active = source.active === '' ? '' : (namedItem(presets, source.active)?.name ?? current.active);
  return { presets, active };
}
