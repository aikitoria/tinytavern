export function upsertById<T extends { id: number }>(items: readonly T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [item, ...items];
  return items.map((candidate, i) => (i === index ? item : candidate));
}

/** Settings responses can arrive over independent HTTP and WebSocket paths. */
export function isCurrentSettingsRevision(current: number, incoming: number): boolean {
  return incoming >= current;
}

/**
 * Only a successful newer request makes older responses stale;
 * a failed request must not discard a still-useful older snapshot.
 */
export class SuccessfulFetchSequence<K> {
  private next = new Map<K, number>();
  private applied = new Map<K, number>();

  start(key: K): number {
    const seq = (this.next.get(key) ?? 0) + 1;
    this.next.set(key, seq);
    return seq;
  }

  accept(key: K, seq: number): boolean {
    if (seq < (this.applied.get(key) ?? 0)) return false;
    this.applied.set(key, seq);
    return true;
  }
}
