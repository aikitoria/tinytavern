import {
  MEDIA_OPERATIONS,
  mediaInputSlots,
  mediaWorkflowError,
  mediaWorkflowKey,
  type MediaPromptSettingsKey,
  type MediaOperation,
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
function operation(value: unknown): MediaOperation {
  if (!MEDIA_OPERATIONS.some((spec) => spec.id === value))
    throw new HttpError(400, 'Unknown media operation');
  return value as MediaOperation;
}

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

export function parseMediaWorkflow(entry: unknown, ids?: Set<string>): MediaWorkflow {
  const item = object(entry, 'workflow');
  const workflow: MediaWorkflow = {
    id: id(item.id, 'workflow ID'),
    name: string(item.name, 'workflow name').trim(),
    operation: operation(item.operation),
    referenceCount: item.referenceCount as MediaWorkflow['referenceCount'],
    json: string(item.json, 'workflow JSON'),
    galleryPromptPresetId:
      item.galleryPromptPresetId == null
        ? null
        : id(item.galleryPromptPresetId, 'gallery prompt preset ID'),
    chatPromptPresetId:
      item.chatPromptPresetId == null ? null : id(item.chatPromptPresetId, 'chat prompt preset ID'),
  };
  if (!workflow.name || workflow.name.length > 200 || ids?.has(workflow.id))
    throw new HttpError(400, 'Workflow names must be nonempty and IDs unique');
  if (workflow.json.length > 2 * 1024 * 1024)
    throw new HttpError(400, 'Workflow JSON is too large');
  ids?.add(workflow.id);
  try {
    mediaInputSlots(workflow.operation, workflow.referenceCount);
  } catch (err) {
    throw new HttpError(400, String(err));
  }
  // Empty placeholders can be saved, but cannot be selected as defaults or rendered.
  const invalid = workflow.json.trim() ? mediaWorkflowError(workflow) : null;
  if (invalid) throw new HttpError(400, `${workflow.name}: ${invalid}`);
  return workflow;
}

export function parseMediaRendering(value: unknown): MediaRenderingSettings | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, 'mediaRendering');
  const comfyUrl = parseComfyUrl(raw.comfyUrl);
  if (!Array.isArray(raw.workflows) || raw.workflows.length > 500)
    throw new HttpError(400, 'Invalid workflows');
  const ids = new Set<string>();
  const workflows = raw.workflows.map((entry) => parseMediaWorkflow(entry, ids));
  const defaults = Object.fromEntries(
    Object.entries(object(raw.defaults, 'workflow defaults')).map(([key, selected]) => {
      const workflow = workflows.find((item) => item.id === selected);
      if (
        !workflow ||
        mediaWorkflowKey(workflow.operation, workflow.referenceCount) !== key ||
        !workflow.json.trim()
      )
        throw new HttpError(400, `Invalid default workflow for ${key}`);
      return [key, workflow.id];
    }),
  );
  const avatarWorkflowId =
    raw.avatarWorkflowId == null ? null : id(raw.avatarWorkflowId, 'avatar workflow');
  if (
    avatarWorkflowId &&
    !workflows.some(
      (item) => item.id === avatarWorkflowId && item.operation === 'image' && item.json.trim(),
    )
  )
    throw new HttpError(400, 'Avatar workflow must be a configured Create image workflow');
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
    defaults,
    avatarWorkflowId,
    jobTimeoutSeconds: jobTimeoutSeconds as number,
  };
}

export function parseMediaPrompts(
  value: unknown,
  key: MediaPromptSettingsKey,
): MediaPromptSettings | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, key);
  if (!Array.isArray(raw.presets) || raw.presets.length > 500)
    throw new HttpError(400, 'Invalid media prompt presets');
  const chat = key === 'chatVideoPrompts';
  const ids = new Set<string>();
  const presets = raw.presets.map((entry): MediaPromptPreset => {
    const item = object(entry, 'prompt preset');
    const identity = {
      id: id(item.id, 'preset ID'),
      name: string(item.name, 'preset name').trim(),
      operation: operation(item.operation),
    };
    if (
      identity.operation === 'image-describe' ||
      identity.operation.startsWith('video') !== (key !== 'galleryImagePrompts')
    )
      throw new HttpError(400, 'Prompt operation does not belong to this settings page');
    const fields = chat
      ? ['chatPrompt']
      : ['systemPrompt', 'userMessage', 'reasoningPrefill', 'messagePrefill'];
    for (const field of Object.keys(item)) {
      if (!['id', 'name', 'operation', ...fields].includes(field))
        throw new HttpError(400, `Unexpected prompt field: ${field}`);
    }
    for (const field of fields) {
      const text = string(item[field], field);
      if (/\{\{references\}\}/i.test(text))
        throw new HttpError(
          400,
          'Reference images are workflow inputs; remove {{references}} from the prompt template.',
        );
    }
    if (
      !identity.name ||
      ids.has(identity.id) ||
      !String(item[chat ? 'chatPrompt' : 'userMessage']).trim()
    )
      throw new HttpError(
        400,
        'Presets require a name, unique ID, and nonempty prompt instruction',
      );
    ids.add(identity.id);
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
  const defaults = Object.fromEntries(
    Object.entries(object(raw.defaults, 'prompt defaults')).map(([operation, selected]) => {
      const preset = presets.find((item) => item.id === selected && item.operation === operation);
      if (!preset) throw new HttpError(400, `Invalid prompt default for ${operation}`);
      return [operation, preset.id];
    }),
  );
  return { presets, defaults };
}
