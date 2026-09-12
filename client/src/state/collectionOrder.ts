const nameOrder = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Sort display copies without changing persisted collection order or item identity. */
export function collectionByName<T extends { name: string }>(items: readonly T[]): T[] {
  return items.toSorted((left, right) => nameOrder.compare(left.name, right.name));
}

/** Preserve item identities while moving a saved entry one position in its explicit order. */
export function moveCollectionItem<T extends { id: string }>(items: T[], id: string, direction: -1 | 1): T[] {
  const index = items.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return items;
  const next = items.slice();
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
