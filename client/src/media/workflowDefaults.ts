import type { MediaAsset, MediaWorkflowInput, MediaWorkflowValues } from '@tinytavern/shared';

export function imageWorkflowDefaults(
  controls: MediaWorkflowInput[],
  image: Pick<MediaAsset, 'width' | 'height'>,
): MediaWorkflowValues {
  const values: MediaWorkflowValues = {};
  if (!image.width || !image.height || image.width <= 0 || image.height <= 0) return values;
  const imageRatio = image.width / image.height;
  for (const control of controls) {
    if (control.type !== 'select' || control.input !== 'aspect_ratio') continue;
    let closest: string | undefined;
    let closestDistance = Infinity;
    for (const option of control.options) {
      const match = /^(\d+):(\d+)\b/.exec(option);
      if (!match) continue;
      const ratio = Number(match[1]) / Number(match[2]);
      // Compare proportions symmetrically, so portrait and landscape behave alike.
      const distance = Math.max(imageRatio / ratio, ratio / imageRatio);
      if (distance < closestDistance) {
        closest = option;
        closestDistance = distance;
      }
    }
    if (closest !== undefined) values[control.key] = closest;
  }
  return values;
}
