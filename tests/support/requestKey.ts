const keys = new Map<string, string>();
/** Stable decimal keys keep idempotency fixtures readable without random identifiers. */
export function testRequestKey(label: string): string {
  if (!keys.has(label)) keys.set(label, String(keys.size + 1));
  return keys.get(label)!;
}
