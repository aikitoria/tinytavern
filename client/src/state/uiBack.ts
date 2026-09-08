const backActions = new WeakMap<HTMLElement, () => void>();

/** Attach the same action used by this surface's Back or Close button. */
export function registerUiBack(element: HTMLElement, action: () => void): void {
  element.dataset.uiBack = '';
  backActions.set(element, action);
}

function currentBackAction(): (() => void) | undefined {
  const surfaces = document.querySelectorAll<HTMLElement>('[data-ui-back]');
  // Portals follow their underlying pages in document order. A nested Back
  // button (such as the mobile entity editor) also takes priority over its parent.
  for (let index = surfaces.length - 1; index >= 0; index--) {
    const surface = surfaces[index]!;
    if (surface.closest('[hidden], [inert]') || surface.getClientRects().length === 0) continue;
    if (getComputedStyle(surface).visibility === 'hidden') continue;
    const action = backActions.get(surface);
    if (action) return action;
  }
}

/** Consume a whole hardware Back click, even if its action unmounts the UI. */
export function installMouseBack(): () => void {
  let press: { action: (() => void) | undefined; handled: boolean } | undefined;

  const onBackButton = (event: MouseEvent) => {
    if (event.button !== 3) return;
    const down = event.type === 'pointerdown' || event.type === 'mousedown';
    if (event.type === 'pointerdown' || (down && (!press || press.handled)) || !press) {
      press = { action: currentBackAction(), handled: false };
    }
    if (!press.action) {
      if (!down) press = undefined;
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    if (!down && !press.handled) {
      press.handled = true;
      press.action();
    }
    if (event.type === 'auxclick') press = undefined;
  };
  const reset = () => {
    press = undefined;
  };
  const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick'] as const;
  const options = { capture: true };
  for (const event of events) window.addEventListener(event, onBackButton, options);
  window.addEventListener('blur', reset);
  window.addEventListener('pointercancel', reset);
  return () => {
    for (const event of events) window.removeEventListener(event, onBackButton, options);
    window.removeEventListener('blur', reset);
    window.removeEventListener('pointercancel', reset);
  };
}
