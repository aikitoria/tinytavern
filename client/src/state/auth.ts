import { createSignal } from 'solid-js';
import { api } from './api.ts';

export type AuthPhase = 'checking' | 'locked' | 'unlocked';

export const [authPhase, setAuthPhase] = createSignal<AuthPhase>('checking');
export const [authCheckError, setAuthCheckError] = createSignal('');

let onUnlock: (() => void) | null = null;
let onLock: (() => void) | null = null;

export function configureAuthLifecycle(handlers: { onUnlock: () => void; onLock: () => void }): void {
  onUnlock = handlers.onUnlock;
  onLock = handlers.onLock;
}

function unlock(): void {
  setAuthCheckError('');
  setAuthPhase('unlocked');
  onUnlock?.();
}

export function requireLogin(): void {
  setAuthPhase('locked');
  onLock?.();
}

export async function checkAuthentication(): Promise<void> {
  try {
    const status = await api.authStatus();
    if (!status.required || status.authenticated) unlock();
    else requireLogin();
  } catch (err) {
    setAuthCheckError(err instanceof Error ? err.message : String(err));
    setAuthPhase('locked');
    onLock?.();
  }
}

export async function login(password: string): Promise<void> {
  await api.login(password);
  unlock();
}
