import type { ImageGenerationSettings } from '@tinytavern/shared';
import { imageRevisionTemplateError } from '@tinytavern/shared';
import { HttpError } from './router.ts';
import { requireObject, requireString } from './validation.ts';

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
  for (const [kind, entry] of Object.entries(sets)) {
    const set = requireObject(entry, 'prompt preset set');
    requireString(set.active, 'active preset');
    if (!Array.isArray(set.presets)) {
      throw new HttpError(400, 'presets must be an array');
    }
    for (const preset of set.presets) {
      validatePromptPreset(preset);
      if (kind === 'avatar') {
        const context = (preset as Record<string, unknown>).context;
        if (typeof context !== 'string' || !context.trim()) {
          throw new HttpError(400, 'Avatar presets require a context template.');
        }
      }
    }
  }
}

export function parseImageGenerationSettings(
  value: unknown,
): Partial<ImageGenerationSettings> | undefined {
  if (value === undefined) return undefined;
  const settings = requireObject(value, 'imageGeneration');
  for (const key of Object.keys(settings)) {
    if (
      ![
        'promptPresets',
        'promptRevisionTemplate',
        'promptRevisionContext',
        'promptRevisionOriginal',
      ].includes(key)
    ) {
      throw new HttpError(400, `Unknown image prompt setting: ${key}`);
    }
  }
  if (settings.promptPresets !== undefined) {
    validatePromptPresets(settings.promptPresets);
  }
  if (settings.promptRevisionTemplate !== undefined) {
    requireString(settings.promptRevisionTemplate, 'image revision template');
    const invalid = imageRevisionTemplateError(settings.promptRevisionTemplate as string);
    if (invalid) throw new HttpError(400, invalid);
  }
  if (settings.promptRevisionContext !== undefined) {
    requireString(settings.promptRevisionContext, 'image revision context');
  }
  if (settings.promptRevisionOriginal !== undefined) {
    requireString(settings.promptRevisionOriginal, 'original image prompt template');
    if (!(settings.promptRevisionOriginal as string).toLowerCase().includes('{{prompt}}')) {
      throw new HttpError(400, 'Include {{prompt}} in the original image prompt template.');
    }
  }
  return settings as Partial<ImageGenerationSettings>;
}
