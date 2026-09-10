import type { MediaAsset, MediaInputSource } from '@tinytavern/shared';

/** Offer automatic filling only when a mapped, empty slot has an available source. */
export function canFillMediaInputs(
  slots: readonly string[],
  bindings: Readonly<Record<string, MediaInputSource>>,
  inputs: readonly { slot: string }[],
  context: {
    selectedAssets: readonly Pick<MediaAsset, 'kind'>[];
    characterAvatar: boolean;
    personaAvatar: boolean;
  },
): boolean {
  return slots.some((slot) => {
    if (inputs.some((input) => input.slot === slot)) return false;
    const source = bindings[slot];
    if (source === 'character-avatar') return context.characterAvatar;
    if (source === 'persona-avatar') return context.personaAvatar;
    return source?.startsWith('selected:')
      ? context.selectedAssets[Number(source.slice(9)) - 1]?.kind === 'image'
      : false;
  });
}
