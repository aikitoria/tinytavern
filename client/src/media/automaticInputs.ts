import type { MediaAsset, MediaInputSource, MediaKind } from '@tinytavern/shared';

/** Offer automatic filling only when a mapped, empty slot has an available source. */
export function canFillMediaInputs(
  slots: readonly string[],
  bindings: Readonly<Record<string, MediaInputSource>>,
  inputs: readonly { slot: string }[],
  context: {
    selectedAssets: readonly Pick<MediaAsset, 'kind'>[];
    characterAvatar: boolean;
    personaAvatar: boolean;
    inputKinds?: ReadonlyMap<string, MediaKind>;
  },
): boolean {
  return slots.some((slot) => {
    if (inputs.some((input) => input.slot === slot)) return false;
    const source = bindings[slot];
    const kind = context.inputKinds?.get(slot) ?? 'image';
    if (source === 'character-avatar') return kind === 'image' && context.characterAvatar;
    if (source === 'persona-avatar') return kind === 'image' && context.personaAvatar;
    return source?.startsWith('selected:') ? context.selectedAssets[Number(source.slice(9)) - 1]?.kind === kind : false;
  });
}
