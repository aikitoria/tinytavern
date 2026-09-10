export type RecordDraft = Record<string, unknown>;

/** Avatar controls persist independently of the character/persona text draft. */
export function avatarEditorSnapshot<T extends { avatar: unknown; avatarThumbnail?: unknown }>({
  avatar,
  avatarThumbnail,
  ...settings
}: T) {
  return settings;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Top-level field patch. Nested values remain atomic editor fields. */
export function changedFields<D extends RecordDraft>(base: D, draft: D): Partial<D> {
  return Object.fromEntries(
    Object.keys(draft)
      .filter((key) => !sameValue(base[key], draft[key]))
      .map((key) => [key, draft[key]]),
  ) as Partial<D>;
}

/** Refresh untouched fields; preserve local edits and flag divergent remote changes.
 * Settings objects can merge recursively; ordered collections remain atomic fields. */
export function mergeRemoteDraft<D extends RecordDraft>(
  base: D,
  draft: D,
  remote: D,
  nested = false,
): {
  base: D;
  draft: D;
  conflicts: (keyof D)[];
} {
  const next = { ...draft };
  const conflicts: (keyof D)[] = [];
  for (const key of Object.keys(remote) as (keyof D)[]) {
    const records = [base[key], draft[key], remote[key]];
    if (
      nested &&
      records.every((value) => value !== null && typeof value === 'object' && !Array.isArray(value))
    ) {
      const merged = mergeRemoteDraft(
        base[key] as RecordDraft,
        draft[key] as RecordDraft,
        remote[key] as RecordDraft,
        true,
      );
      next[key] = merged.draft as D[keyof D];
      if (merged.conflicts.length) conflicts.push(key);
      continue;
    }
    const locallyChanged = !sameValue(draft[key], base[key]);
    const remotelyChanged = !sameValue(remote[key], base[key]);
    if (!locallyChanged) next[key] = remote[key];
    else if (remotelyChanged && !sameValue(draft[key], remote[key])) conflicts.push(key);
  }
  return { base: { ...remote }, draft: next, conflicts };
}
