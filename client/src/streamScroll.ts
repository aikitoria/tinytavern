interface StreamScrollArea {
  isConnected: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Follow streamed text at most once per frame, without fighting manual scrolling. */
export function createStreamScroll(
  element: () => StreamScrollArea | undefined,
  schedule: (callback: () => void) => number,
  cancel: (frame: number) => void,
) {
  let stream: string | null = null;
  let visible = false;
  let follow = true;
  let frame: number | undefined;
  const stop = () => {
    if (frame !== undefined) cancel(frame);
    frame = undefined;
  };
  return {
    update(nextStream: string | null, nextVisible: boolean) {
      const ended = stream !== null && nextStream === null;
      if (nextStream !== null && nextStream !== stream) follow = true;
      stream = nextStream;
      visible = nextVisible;
      if (!visible) {
        stop();
        return;
      }
      if ((!stream && !ended) || !follow || frame !== undefined) return;
      frame = schedule(() => {
        frame = undefined;
        const area = element();
        if (visible && follow && area?.isConnected) area.scrollTop = area.scrollHeight;
      });
    },
    onScroll() {
      const area = element();
      if (visible && area) follow = area.scrollHeight - area.scrollTop - area.clientHeight < 24;
    },
    dispose: stop,
  };
}
