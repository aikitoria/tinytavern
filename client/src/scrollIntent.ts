export function scrollBackKey(event: KeyboardEvent): boolean {
  return (
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.altKey &&
    (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home' || (event.key === ' ' && event.shiftKey))
  );
}

/** User intent must pause following before browser scrolling or a streaming resize. */
export function observeScrollIntent(element: HTMLElement, pause: () => void): () => void {
  let previousX = 0;
  let previousY = 0;
  const wheel = (event: WheelEvent) => {
    if (event.deltaY < 0 && !event.ctrlKey && !event.metaKey) {
      pause();
    }
  };
  const touchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    previousX = touch.clientX;
    previousY = touch.clientY;
  };
  const touchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    const horizontalMovement = touch.clientX - previousX;
    const verticalMovement = touch.clientY - previousY;
    if (verticalMovement > 0 && Math.abs(verticalMovement) > Math.abs(horizontalMovement)) {
      pause();
    }
    previousX = touch.clientX;
    previousY = touch.clientY;
  };
  const mouse = (event: MouseEvent) => {
    if (event.button === 1) {
      pause();
    }
    if (event.button !== 0 || event.target !== element) {
      return;
    }
    const offset = event.clientX - element.getBoundingClientRect().left - element.clientLeft;
    if (offset < 0 || offset >= element.clientWidth) {
      pause();
    }
  };
  element.addEventListener('wheel', wheel, { passive: true });
  element.addEventListener('touchstart', touchStart, { passive: true });
  element.addEventListener('touchmove', touchMove, { passive: true });
  element.addEventListener('mousedown', mouse);
  return () => {
    element.removeEventListener('wheel', wheel);
    element.removeEventListener('touchstart', touchStart);
    element.removeEventListener('touchmove', touchMove);
    element.removeEventListener('mousedown', mouse);
  };
}
