import type { MediaJobInput } from '@tinytavern/shared';

/** Slot order is the shared presentation order; array insertion order has no meaning. */
export function orderedMediaInputs(slots: readonly string[], inputs: readonly MediaJobInput[]) {
  const bySlot = new Map(inputs.map((input) => [input.slot, input]));
  return slots.flatMap((slot) => {
    const input = bySlot.get(slot);
    return input ? [input] : [];
  });
}

/** Keep selected images in their existing slots, including gaps and repeated assets.
 * New selections fill vacant slots. Non-gallery inputs cannot be removed by this picker. */
export function reconcileMediaInputSelection(
  slots: readonly string[],
  inputs: readonly MediaJobInput[],
  selectedAssetIds: readonly number[],
  selectableAssetIds: ReadonlySet<number>,
): MediaJobInput[] {
  const remaining = new Map<number, number>();
  for (const id of selectedAssetIds) remaining.set(id, (remaining.get(id) ?? 0) + 1);
  const retained = new Map<string, MediaJobInput>();
  for (const input of orderedMediaInputs(slots, inputs)) {
    const count = remaining.get(input.assetId) ?? 0;
    if (count || !selectableAssetIds.has(input.assetId)) retained.set(input.slot, input);
    if (count) remaining.set(input.assetId, count - 1);
  }
  const additions = selectedAssetIds.filter((id) => {
    const count = remaining.get(id) ?? 0;
    if (!count) return false;
    remaining.set(id, count - 1);
    return true;
  });
  let index = 0;
  return slots.flatMap((slot) => {
    const input = retained.get(slot);
    if (input) return [input];
    const assetId = additions[index++];
    return assetId === undefined ? [] : [{ slot, assetId }];
  });
}
