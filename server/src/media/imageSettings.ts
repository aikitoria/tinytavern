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
        const parsed = importImagePromptSet(set, { presets: [], active: '' }, true);
        const raw = requireObject(set, 'Avatar presets');
        const incoming = raw.presets as { id?: string; name: string }[];
        for (const preset of parsed.presets) {
          const id = incoming.find((item) => item.name === preset.name)?.id;
          if (id !== undefined) {
            if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
              throw new Error('Invalid avatar preset ID');
            preset.id = id;
          }
        }
        if (
          raw.activeId !== undefined &&
          raw.activeId !== null &&
          (typeof raw.activeId !== 'string' ||
            !parsed.presets.some((item) => item.id === raw.activeId))
        ) {
          throw new Error('Invalid active avatar preset ID');
        }
        const ids = parsed.presets.flatMap((item) => (item.id ? [item.id] : []));
        if (new Set(ids).size !== ids.length) throw new Error('Duplicate avatar preset ID');
        promptPresets[kind] = {
          ...parsed,
          ...(Object.hasOwn(raw, 'activeId') ? { activeId: raw.activeId as string | null } : {}),
        };
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
