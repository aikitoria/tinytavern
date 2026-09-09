import { nextCollectionId } from './numericIds.ts';
import type { Settings, MediaPromptPreset, MediaWorkflow } from './index.ts';
import {
  MEDIA_OPERATIONS,
  mediaInputSlots,
  mediaPromptSettingsKey,
  mediaWorkflowKey,
} from './media.ts';

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
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object');
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
export function transferArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 500)
    throw new Error('Expected a list of at most 500 items');
  return value.map(transferObject);
}

/** A unique exact name wins; otherwise accept a unique case-insensitive match. */
export function namedItem<T extends { name: string }>(
  items: readonly T[],
  name: unknown,
): T | undefined {
  if (typeof name !== 'string') return undefined;
  const exact = items.filter((item) => item.name === name);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const matches = items.filter((item) => item.name.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}

export const ENTITY_TRANSFER_FIELDS = {
  presets: ['name', 'content'],
  templates: [
    'name',
    'content',
    'userPrologue',
    'reasoningPrefill',
    'messagePrefill',
    'prefixNames',
    'usesPersonas',
    'steerTemplate',
    'speakerHandoffTemplate',
  ],
  endpoints: ['name', 'baseUrl', 'model', 'genParams', 'prefillMode'],
  personas: ['name', 'description', 'avatarData'],
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
    if (['prefixNames', 'usesPersonas'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} must be true or false`);
    } else if (key === 'genParams') {
      const params = transferObject(value);
      if (
        Object.values(params).some(
          (value) => typeof value !== 'number' && typeof value !== 'string',
        )
      )
        throw new Error('Invalid generation parameters');
    } else if ((key === 'model' || key === 'avatarData') && value === null) {
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
export function exportPromptCollection(value: Settings['chatVideoPrompts']) {
  return {
    presets: value.presets.map(({ id, ...preset }) => preset),
    defaults: Object.fromEntries(
      Object.entries(value.defaults).map(([operation, id]) => [
        operation,
        value.presets.find((item) => item.id === id)?.name ?? null,
      ]),
    ),
  };
}
export function importPromptCollection(
  value: unknown,
  current: Settings['chatVideoPrompts'],
  chat: boolean,
  video: boolean,
): Settings['chatVideoPrompts'] {
  const source = transferObject(value);
  const presets = current.presets.map((item) => ({ ...item }));
  const incoming = transferArray(source.presets);
  const seen = new Set<string>();
  for (const item of incoming) {
    const name = transferString(item.name, 'Preset name');
    const operation = transferString(item.operation, 'Operation') as MediaPromptPreset['operation'];
    if (
      !MEDIA_OPERATIONS.some((item) => item.id === operation && item.kind !== 'text') ||
      operation.startsWith('video') !== video
    )
      throw new Error('This preset belongs to a different page');
    if (!name.trim()) throw new Error('Enter a preset name');
    const identity = `${operation}:${name.toLowerCase()}`;
    if (seen.has(identity)) throw new Error('Duplicate preset names in the import');
    seen.add(identity);
    const existing = namedItem(
      presets.filter((item) => item.operation === operation),
      name,
    );
    const fields = chat
      ? ['chatPrompt']
      : ['systemPrompt', 'userMessage', 'reasoningPrefill', 'messagePrefill'];
    const text = Object.fromEntries(fields.map((key) => [key, transferString(item[key], key)]));
    const preset = {
      ...text,
      id: existing?.id ?? nextCollectionId(presets),
      name,
      operation,
    } as MediaPromptPreset;
    if (existing) presets[presets.indexOf(existing)] = preset;
    else presets.push(preset);
  }
  const defaults = { ...current.defaults };
  for (const [operation, name] of Object.entries(transferObject(source.defaults))) {
    if (
      !MEDIA_OPERATIONS.some((item) => item.id === operation && item.kind !== 'text') ||
      operation.startsWith('video') !== video
    )
      throw new Error('This default belongs to a different page');
    const key = operation as MediaPromptPreset['operation'];
    if (name === null) delete defaults[key];
    else {
      const selected = namedItem(
        presets.filter((item) => item.operation === operation),
        name,
      );
      if (selected) defaults[key] = selected.id;
    }
  }
  return { presets, defaults };
}

export function exportWorkflow(workflow: MediaWorkflow, settings: Settings) {
  const { id, galleryPromptPresetId, chatPromptPresetId, ...fields } = workflow;
  const gallery = settings[mediaPromptSettingsKey(workflow.operation, false)].presets;
  return {
    ...fields,
    galleryPromptPreset: gallery.find((item) => item.id === galleryPromptPresetId)?.name ?? null,
    chatPromptPreset:
      settings.chatVideoPrompts.presets.find((item) => item.id === chatPromptPresetId)?.name ??
      null,
  };
}
export function importWorkflow(
  value: unknown,
  workflows: MediaWorkflow[],
  settings: Settings,
): MediaWorkflow {
  const item = transferObject(value);
  const name = transferString(item.name, 'Workflow name');
  const operation = transferString(item.operation, 'Operation') as MediaWorkflow['operation'];
  const referenceCount = item.referenceCount as MediaWorkflow['referenceCount'];
  mediaInputSlots(operation, referenceCount);
  if (!name.trim()) throw new Error('Enter a workflow name');
  const existing = namedItem(
    workflows.filter(
      (candidate) =>
        candidate.operation === operation && candidate.referenceCount === referenceCount,
    ),
    name,
  );
  const resolve = (field: 'galleryPromptPreset' | 'chatPromptPreset', previous: string | null) => {
    if (item[field] === null) return null;
    const presets =
      settings[mediaPromptSettingsKey(operation, field === 'chatPromptPreset')].presets;
    return (
      namedItem(
        presets.filter((preset) => preset.operation === operation),
        item[field],
      )?.id ?? previous
    );
  };
  return {
    id: existing?.id ?? nextCollectionId(workflows),
    name,
    operation,
    referenceCount,
    json: transferString(item.json, 'Workflow JSON'),
    galleryPromptPresetId: resolve('galleryPromptPreset', existing?.galleryPromptPresetId ?? null),
    chatPromptPresetId: operation.startsWith('video')
      ? resolve('chatPromptPreset', existing?.chatPromptPresetId ?? null)
      : null,
  };
}
export function exportRendering(settings: Settings) {
  const value = settings.mediaRendering;
  return {
    ...value,
    workflows: value.workflows.map((item) => exportWorkflow(item, settings)),
    defaults: Object.fromEntries(
      Object.entries(value.defaults).map(([key, id]) => [
        key,
        value.workflows.find((item) => item.id === id)?.name ?? null,
      ]),
    ),
    avatarWorkflow:
      value.workflows.find((item) => item.id === value.avatarWorkflowId)?.name ?? null,
    avatarWorkflowId: undefined,
  };
}
export function importRendering(value: unknown, settings: Settings): Settings['mediaRendering'] {
  const source = transferObject(value);
  const current = settings.mediaRendering;
  const workflows = current.workflows.map((item) => ({ ...item }));
  const seen = new Set<string>();
  for (const item of transferArray(source.workflows)) {
    const workflow = importWorkflow(item, workflows, settings);
    const identity = `${mediaWorkflowKey(workflow.operation, workflow.referenceCount)}:${workflow.name.toLowerCase()}`;
    if (seen.has(identity)) throw new Error('Duplicate workflow names in the import');
    seen.add(identity);
    const index = workflows.findIndex((item) => item.id === workflow.id);
    if (index === -1) workflows.push(workflow);
    else workflows[index] = workflow;
  }
  const defaults = { ...current.defaults };
  for (const [key, name] of Object.entries(transferObject(source.defaults))) {
    if (name === null) {
      delete defaults[key];
      continue;
    }
    const selected = namedItem(
      workflows.filter((item) => mediaWorkflowKey(item.operation, item.referenceCount) === key),
      name,
    );
    if (selected) defaults[key] = selected.id;
  }
  if (typeof source.jobTimeoutSeconds !== 'number') throw new Error('Invalid job timeout');
  return {
    workflows,
    defaults,
    comfyUrl: transferString(source.comfyUrl, 'ComfyUI URL'),
    jobTimeoutSeconds: source.jobTimeoutSeconds,
    avatarWorkflowId:
      source.avatarWorkflow === null
        ? null
        : (namedItem(
            workflows.filter((item) => item.operation === 'image'),
            source.avatarWorkflow,
          )?.id ?? current.avatarWorkflowId),
  };
}

export function importImagePromptSet(
  value: unknown,
  current: { presets: { name: string; prompt: string; context?: string }[]; active: string },
  avatar: boolean,
) {
  const source = transferObject(value);
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
    const existing = namedItem(presets, name);
    if (existing) presets[presets.indexOf(existing)] = preset;
    else presets.push(preset);
  }
  const active =
    source.active === '' ? '' : (namedItem(presets, source.active)?.name ?? current.active);
  return { presets, active };
}
