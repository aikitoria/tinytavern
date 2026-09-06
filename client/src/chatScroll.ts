/** Layout can move scrollTop in either direction; only input pauses following. */
export function createChatScroll(scroller: {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}) {
  let following = true;
  let lastTop = scroller.scrollTop;

  return {
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
      if (top > lastTop && scroller.scrollHeight - top - scroller.clientHeight < 2)
        following = true;
      lastTop = top;
    },
  };
}
