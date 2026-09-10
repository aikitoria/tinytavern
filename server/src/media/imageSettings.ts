import type { ImageGenerationSettings } from '@tinytavern/shared';
import { imageRevisionTemplateError, importImagePromptSet } from '@tinytavern/shared';
import { HttpError } from '../http/router.ts';
import { requireObject, requireString } from '../http/validation.ts';

export function parseImageGenerationSettings(
  value: unknown,
): Partial<ImageGenerationSettings> | undefined {
  if (value === undefined) return undefined;
  const settings = { ...requireObject(value, 'imageGeneration') };
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
    try {
      const promptPresets: NonNullable<ImageGenerationSettings['promptPresets']> = {};
      for (const [kind, set] of Object.entries(
        requireObject(settings.promptPresets, 'promptPresets'),
      )) {
        if (kind !== 'avatar')
          throw new Error('Media prompt presets are configured in the media prompt library');
        promptPresets[kind] = importImagePromptSet(set, { presets: [], active: '' }, true);
      }
      settings.promptPresets = promptPresets;
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
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
