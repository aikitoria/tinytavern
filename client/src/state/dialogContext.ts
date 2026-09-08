import { createContext, onCleanup, useContext, type Accessor } from 'solid-js';
import { dialogStack, type DialogFrame } from './dialogStack.ts';
import { guardPageNavigation, readPageLocation } from './pageLocation.ts';

export const DialogContext = createContext<{ frame: DialogFrame; active: Accessor<boolean> }>();
export const useDialogActive = () => useContext(DialogContext)?.active ?? (() => true);
export function useDialogPage() {
  const context = useContext(DialogContext);
  return () => context?.frame.page ?? readPageLocation();
}

/** Guard every pane being removed, including an editor covered by another pane. */
export function useDialogNavigationGuard(guard: (action: () => void) => void): void {
  const context = useContext(DialogContext);
  onCleanup(
    guardPageNavigation(
      guard,
      context ? (target) => !dialogStack.retains(context.frame, target) : undefined,
    ),
  );
}
