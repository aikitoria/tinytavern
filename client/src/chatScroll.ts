/** Layout can move scrollTop in either direction; only input pauses following. */
export interface ScrollArea {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export function createChatScroll(scroller: ScrollArea, threshold = 2, pauseOnScroll = false) {
  let following = true;
  let lastTop = scroller.scrollTop;

  return {
    following: () => following,
    pause() {
      following = false;
      lastTop = scroller.scrollTop;
    },
    reset() {
      following = true;
    },
    follow() {
      if (!following) return;
      scroller.scrollTop = scroller.scrollHeight;
      lastTop = scroller.scrollTop;
    },
    onScroll() {
      const top = scroller.scrollTop;
      // Resume after scrolling down to the bottom, not after a layout contraction
      // clamps the offset or a queued event reports our own previous scroll.
      const atBottom = scroller.scrollHeight - top - scroller.clientHeight < threshold;
      if (pauseOnScroll) following = atBottom;
      else if (top > lastTop && atBottom) following = true;
      lastTop = top;
    },
  };
}

/** One pending layout operation per surface; visibility is checked at execution time. */
export function createScrollFrame(
  follow: () => void,
  enabled: () => boolean,
  schedule: (callback: () => void) => number,
  cancel: (frame: number) => void,
) {
  let frame: number | undefined;
  return {
    update() {
      if (frame !== undefined || !enabled()) return;
      frame = schedule(() => {
        frame = undefined;
        if (enabled()) follow();
      });
    },
    dispose() {
      if (frame !== undefined) cancel(frame);
      frame = undefined;
    },
  };
}
