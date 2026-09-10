/** Resolve collisions within the caller's named collection. */
export function uniqueCollectionName(base: string, items: readonly { name: string }[]): string {
  const names = new Set(items.map((item) => item.name));
  let name = base;
  for (let number = 2; names.has(name); number++) name = `${base} ${number}`;
  return name;
}
