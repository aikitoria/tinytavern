import { createEffect, onCleanup } from 'solid-js';
import { createChatScroll } from './chatScroll.ts';

/** Map cards have fixed height; follow their rendered body without relaying tokens to the map. */
export function followMessageStream(
  element: HTMLElement,
  stream: () => number | null,
  visible: () => boolean,
) {
  const scroll = createChatScroll(element);
  let previous: number | null = null;
  let started = false;
  let frame = 0;
  const schedule = () => {
    if (frame || !started || !visible()) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (visible() && element.isConnected) scroll.follow();
    });
  };
  createEffect(() => {
    const token = stream();
    if (token !== null && token !== previous) {
      started = true;
      scroll.reset();
    }
    previous = token;
    if (visible()) schedule();
  });
  const resize = new ResizeObserver(schedule);
  const observeChildren = () => {
    resize.disconnect();
    resize.observe(element);
    for (const child of element.children) resize.observe(child);
  };
  const mutations = new MutationObserver((records) => {
    if (records.some((record) => record.target === element && record.type === 'childList'))
      observeChildren();
    schedule();
  });
  mutations.observe(element, { subtree: true, childList: true, characterData: true });
  observeChildren();
  const wheel = (event: WheelEvent) => {
    if (event.deltaY < 0 && !event.ctrlKey && !event.metaKey) scroll.pause();
  };
  let touchX = 0;
  let touchY = 0;
  const touchStart = (event: TouchEvent) => {
    touchX = event.touches[0]?.clientX ?? 0;
    touchY = event.touches[0]?.clientY ?? 0;
  };
  const touchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - touchX;
    const dy = touch.clientY - touchY;
    if (dy > 0 && Math.abs(dy) > Math.abs(dx)) scroll.pause();
    touchX = touch.clientX;
    touchY = touch.clientY;
  };
  const mouseDown = (event: MouseEvent) => {
    if (event.button === 1 || (event.button === 0 && event.target === element)) scroll.pause();
  };
  const keyDown = (event: KeyboardEvent) => {
    if (
      event.key === 'ArrowUp' ||
      event.key === 'PageUp' ||
      event.key === 'Home' ||
      (event.key === ' ' && event.shiftKey)
    )
      scroll.pause();
  };
  element.addEventListener('scroll', scroll.onScroll);
  element.addEventListener('wheel', wheel, { passive: true });
  element.addEventListener('touchstart', touchStart, { passive: true });
  element.addEventListener('touchmove', touchMove, { passive: true });
  element.addEventListener('mousedown', mouseDown);
  element.addEventListener('keydown', keyDown);
  onCleanup(() => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    element.removeEventListener('scroll', scroll.onScroll);
    element.removeEventListener('wheel', wheel);
    element.removeEventListener('touchstart', touchStart);
    element.removeEventListener('touchmove', touchMove);
    element.removeEventListener('mousedown', mouseDown);
    element.removeEventListener('keydown', keyDown);
  });
}
