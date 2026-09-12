/** Cross-client request deduplication and private progress correlation use 96-bit decimal nonces. */
export function newRequestId(): string {
  const words = crypto.getRandomValues(new Uint32Array(3));
  return ((BigInt(words[0]!) << 64n) | (BigInt(words[1]!) << 32n) | BigInt(words[2]!)).toString();
}

let collectionId = 0;
/** Request-local draft IDs are replaced by server-assigned database IDs when saved. */
export function nextCollectionId(items: readonly { id: string }[]): string {
  let next = Math.max(Date.now(), collectionId + 1);
  for (const item of items) {
    const id = Number(item.id);
    if (Number.isSafeInteger(id)) next = Math.max(next, id + 1);
  }
  if (!Number.isSafeInteger(next)) throw new Error('Numeric identifier range exhausted');
  collectionId = next;
  return String(next);
}
