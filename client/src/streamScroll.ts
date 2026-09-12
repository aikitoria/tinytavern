import { createChatScroll, createScrollFrame, type ScrollArea } from './chatScroll.ts';

/** Textareas infer manual scrolling; rendered chat uses explicit input intent. */
export function createStreamScroll(
  element: () => (ScrollArea & { isConnected: boolean }) | undefined,
  schedule: (callback: () => void) => number,
  cancel: (frame: number) => void,
) {
  const area: ScrollArea = {
    get scrollTop() {
      return element()?.scrollTop ?? 0;
    },
    set scrollTop(value) {
      const current = element();
      if (current) current.scrollTop = value;
    },
    get scrollHeight() {
      return element()?.scrollHeight ?? 0;
    },
    get clientHeight() {
      return element()?.clientHeight ?? 0;
    },
  };
  const scroll = createChatScroll(area, 24, true);
  let stream: string | number | null = null;
  let visible = false;
  const frame = createScrollFrame(
    () => {
      if (element()?.isConnected) scroll.follow();
    },
    () => visible && scroll.following(),
    schedule,
    cancel,
  );
  return {
    update(nextStream: string | number | null, nextVisible: boolean) {
      const ended = stream !== null && nextStream === null;
      if (nextStream !== null && nextStream !== stream) scroll.reset();
      stream = nextStream;
      visible = nextVisible;
      if (!visible) frame.dispose();
      else if (stream !== null || ended) frame.update();
    },
    onScroll() {
      if (visible && element()) scroll.onScroll();
    },
    dispose: frame.dispose,
  };
}
