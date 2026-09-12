export interface SwipeOperationIdentity {
  token: number;
  conversationId: number;
  sourceLeafId: number | null;
}

/** Retain an animation across structure-only frames; consume it when the
 * authoritative active leaf proves that its branch mutation landed. */
export function afterTreeFrame<T extends SwipeOperationIdentity>(
  pending: T | null,
  conversationId: number,
  activeLeafId: number | null,
): T | null {
  return pending?.conversationId === conversationId && pending.sourceLeafId !== activeLeafId ? null : pending;
}

/** Clear only the operation that installed a timeout/failure callback. */
export function afterOperationEnd<T extends SwipeOperationIdentity>(pending: T | null, token: number): T | null {
  return pending?.token === token ? null : pending;
}
