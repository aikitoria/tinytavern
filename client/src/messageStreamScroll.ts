import { observeScrollIntent, scrollBackKey } from './scrollIntent.ts';
import { createEffect, onCleanup } from 'solid-js';
import { createChatScroll, createScrollFrame } from './chatScroll.ts';

/** Map cards have fixed height; follow their rendered body without relaying tokens to the map. */
export function followMessageStream(element: HTMLElement, stream: () => number | null, visible: () => boolean) {
  const scroll = createChatScroll(element);
  let previous: number | null = null;
  let started = false;
  const frame = createScrollFrame(
    scroll.follow,
    () => started && visible() && element.isConnected,
    requestAnimationFrame,
    cancelAnimationFrame,
  );
  const schedule = frame.update;
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
    if (records.some((record) => record.target === element && record.type === 'childList')) observeChildren();
    schedule();
  });
  mutations.observe(element, { subtree: true, childList: true, characterData: true });
  observeChildren();
  const stopIntent = observeScrollIntent(element, scroll.pause);
  const keyDown = (event: KeyboardEvent) => {
    if (scrollBackKey(event)) scroll.pause();
  };
  element.addEventListener('scroll', scroll.onScroll);
  element.addEventListener('keydown', keyDown);
  onCleanup(() => {
    frame.dispose();
    stopIntent();
    resize.disconnect();
    mutations.disconnect();
    element.removeEventListener('scroll', scroll.onScroll);
    element.removeEventListener('keydown', keyDown);
  });
}
