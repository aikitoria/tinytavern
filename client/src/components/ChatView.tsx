import { For, Show, createEffect, onCleanup, onMount } from 'solid-js';
import { activePath, newConversation, selectedConversation, state } from '../state/store.ts';
import { swipeMessage } from '../messageSwipe.ts';
import MessageNode from './MessageNode.tsx';
import TraceView from './TraceView.tsx';
import TreeMap from './TreeMap.tsx';
import TreeView from './TreeView.tsx';

export default function ChatView() {
  let scroller!: HTMLDivElement;
  let stickToBottom = true;
  let lastScrollTop = 0;
  let lastTouchX = 0;
  let lastTouchY = 0;

  const onScroll = () => {
    const top = scroller.scrollTop;
    const movingUp = top < lastScrollTop - 1;
    const atBottom = scroller.scrollHeight - top - scroller.clientHeight < 2;
    // Upward intent overrides the at-bottom tolerance.
    if (movingUp) stickToBottom = false;
    else if (atBottom) stickToBottom = true;
    lastScrollTop = top;
  };

  // Wheel intent arrives before the resulting scroll event. Disengage here so
  // a streaming resize cannot snap back to the bottom between the two.
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY < 0) stickToBottom = false;
  };

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    lastTouchX = touch.clientX;
    lastTouchY = touch.clientY;
  };

  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - lastTouchX;
    const dy = touch.clientY - lastTouchY;
    // Disengage before scrolling toward older content; ignore horizontal swipes.
    if (dy > 0 && Math.abs(dy) > Math.abs(dx)) stickToBottom = false;
    lastTouchX = touch.clientX;
    lastTouchY = touch.clientY;
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.repeat) return;
    if (
      state.modal !== null ||
      state.viewMode !== 'chat' ||
      state.selectedId == null ||
      state.treeNavigationPending
    )
      return;
    const target = event.target as HTMLElement;
    const editable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable;
    if (editable) {
      // Only the empty composer passes through; anything else keeps its caret behavior.
      const isEmptyComposer =
        target instanceof HTMLTextAreaElement &&
        target.classList.contains('composer-input') &&
        target.value === '';
      if (!isEmptyComposer) return;
    }
    const path = activePath();
    const last = path[path.length - 1];
    if (!last) return;
    const dir = event.key === 'ArrowLeft' ? -1 : 1;
    if (swipeMessage(last, dir)) event.preventDefault();
  };

  onMount(() => document.addEventListener('keydown', onKey));
  onCleanup(() => document.removeEventListener('keydown', onKey));

  createEffect(() => {
    if (state.tree.conversationId == null) return;
    stickToBottom = true;
    requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
      lastScrollTop = scroller.scrollTop;
    });
  });

  // Catch layout changes beyond token updates, including markdown and font settling.
  const resizeObserver = new ResizeObserver(() => {
    if (stickToBottom) scroller.scrollTop = scroller.scrollHeight;
  });
  onCleanup(() => resizeObserver.disconnect());

  createEffect(() => {
    const path = activePath();
    const last = path[path.length - 1];
    void last?.content.length;
    void last?.reasoning?.length;
    if (stickToBottom) scroller.scrollTop = scroller.scrollHeight;
  });

  return (
    <div
      class="chat"
      classList={{ 'chat-tree': state.viewMode === 'tree', 'chat-map': state.viewMode === 'map' }}
      ref={scroller}
      onScroll={onScroll}
      onWheel={onWheel}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
    >
      <Show
        when={selectedConversation()}
        fallback={
          // Hide until booted to prevent a welcome-screen flash on reload.
          <div class="chat-empty" classList={{ hidden: !state.booted }}>
            <h1>TinyTavern</h1>
            <p>Tiny but mighty.</p>
            <button class="primary-btn" onClick={() => void newConversation(null)}>
              Start a new chat
            </button>
            <Show when={state.endpoints.length === 0}>
              <p class="hint">No API endpoint configured yet — open Settings → Endpoints first.</p>
            </Show>
          </div>
        }
      >
        <div class="chat-inner" ref={(el) => resizeObserver.observe(el)}>
          <Show
            when={state.viewMode === 'chat'}
            fallback={
              <Show
                when={state.viewMode === 'trace'}
                fallback={
                  <Show when={state.viewMode === 'map'} fallback={<TreeView />}>
                    <TreeMap />
                  </Show>
                }
              >
                <TraceView />
              </Show>
            }
          >
            <For each={activePath()}>{(message) => <MessageNode message={message} />}</For>
          </Show>
        </div>
      </Show>
    </div>
  );
}
