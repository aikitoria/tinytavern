import type { ImageGenerationSettings, StandalonePromptTemplate } from '@tinytavern/shared';
import { galleryRevisionTemplateError, imageRevisionTemplateError } from '@tinytavern/shared';
import { HttpError } from './router.ts';

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): void {
  if (typeof value !== 'string') {
    throw new HttpError(400, `${label} must be a string`);
  }
}

function validateWorkflows(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'workflows must be an array');
  }
  for (const entry of value) {
    const workflow = requireObject(entry, 'workflow');
    requireString(workflow.name, 'workflow name');
    requireString(workflow.json, 'workflow JSON');
  }
}

function validatePromptPreset(value: unknown): void {
  const preset = requireObject(value, 'prompt preset');
  requireString(preset.name, 'preset name');
  requireString(preset.prompt, 'preset prompt');
  if (preset.context !== undefined) {
    requireString(preset.context, 'preset context');
  }
}

function validatePromptPresets(value: unknown): void {
  const sets = requireObject(value, 'promptPresets');
  for (const entry of Object.values(sets)) {
    const set = requireObject(entry, 'prompt preset set');
    requireString(set.active, 'active preset');
    if (!Array.isArray(set.presets)) {
      throw new HttpError(400, 'presets must be an array');
    }
    for (const preset of set.presets) {
      validatePromptPreset(preset);
    }
  }
}

export function parseImageGenerationSettings(value: unknown): ImageGenerationSettings | undefined {
  if (value === undefined) return undefined;
  const settings = requireObject(value, 'imageGeneration');
  for (const key of ['comfyUrl', 'activeWorkflow', 'avatarWorkflow']) {
    if (settings[key] !== undefined) {
      requireString(settings[key], key);
    }
  }
  if (settings.workflows !== undefined) {
    validateWorkflows(settings.workflows);
  }
  if (settings.promptPresets !== undefined) {
    validatePromptPresets(settings.promptPresets);
  }
  if (settings.promptRevisionTemplate !== undefined) {
    requireString(settings.promptRevisionTemplate, 'image revision template');
    const invalid = imageRevisionTemplateError(settings.promptRevisionTemplate as string);
    if (invalid) throw new HttpError(400, invalid);
  }
  return settings as ImageGenerationSettings;
}

export function parseGalleryRevisionTemplate(value: unknown): StandalonePromptTemplate {
  const template = requireObject(value, 'gallery revision template');
  for (const key of ['systemPrompt', 'userMessage', 'reasoningPrefill', 'messagePrefill']) {
    requireString(template[key], key);
  }
  const parsed: StandalonePromptTemplate = {
    systemPrompt: template.systemPrompt as string,
    userMessage: template.userMessage as string,
    reasoningPrefill: template.reasoningPrefill as string,
    messagePrefill: template.messagePrefill as string,
  };
  const invalid = galleryRevisionTemplateError(parsed);
  if (invalid) throw new HttpError(400, invalid);
  return parsed;
}
