import { createSignal } from 'solid-js';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

const [request, setRequest] = createSignal<ConfirmRequest | null>(null);
let resolvePending: ((confirmed: boolean) => void) | undefined;

export const pendingConfirmation = request;

export function confirmAction(options: ConfirmRequest): Promise<boolean> {
  resolvePending?.(false);
  setRequest(options);
  return new Promise<boolean>((resolve) => {
    resolvePending = resolve;
  });
}

/** Individual and selected-item deletes only; delete-all/reset actions use confirmAction. */
export function confirmDelete(
  options: ConfirmRequest,
  event?: { shiftKey: boolean },
): Promise<boolean> {
  return event?.shiftKey ? Promise.resolve(true) : confirmAction(options);
}

export function settleConfirmation(confirmed: boolean): void {
  const resolve = resolvePending;
  resolvePending = undefined;
  setRequest(null);
  resolve?.(confirmed);
}
