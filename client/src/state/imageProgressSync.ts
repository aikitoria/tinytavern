export interface ImageProgressValue {
  value?: number;
  max?: number;
  preview?: string;
}

export type ImageProgressState = Record<number, ImageProgressValue>;

/** Ignore stale events and preserve identity on duplicates to avoid reactive updates. */
export function applyImageProgress(
  progress: ImageProgressState,
  messages: Readonly<Record<number, { imagePending: boolean } | undefined>>,
  mid: number,
  update: ImageProgressValue,
): ImageProgressState {
  if (!messages[mid]?.imagePending) return progress;
  const current = progress[mid];
  if (
    current?.value === (update.value ?? current?.value) &&
    current?.max === (update.max ?? current?.max) &&
    current?.preview === (update.preview ?? current?.preview)
  ) {
    return progress;
  }
  return { ...progress, [mid]: { ...current, ...update } };
}

/** Reconcile ephemeral progress after a tree frame. */
export function retainPendingImageProgress(
  progress: ImageProgressState,
  messages: Readonly<Record<number, { imagePending: boolean } | undefined>>,
): ImageProgressState {
  const stale = Object.keys(progress).some((mid) => !messages[Number(mid)]?.imagePending);
  if (!stale) return progress;
  return Object.fromEntries(
    Object.entries(progress).filter(([mid]) => messages[Number(mid)]?.imagePending),
  );
}
