import { useConversationView } from './ConversationContext.tsx';
import { For, Show, createEffect, onCleanup, onMount } from 'solid-js';
import { newConversation } from '../../state/store.ts';
import { createMessageSwipe } from '../../messageSwipe.ts';
import { createChatScroll } from '../../chatScroll.ts';
import MessageNode from './MessageNode.tsx';
import TraceView from './TraceView.tsx';
import TreeMap from '../tree/TreeMap.tsx';

export default function ChatView(props: { active?: boolean; pendingMessage?: string }) {
  const view = useConversationView();
  const { activePath, selectedConversation, state } = view.session;
  const { swipeMessage } = createMessageSwipe(view.session, view.active);

  let scroller!: HTMLDivElement;
  let scroll!: ReturnType<typeof createChatScroll>;
  let lastTouchX = 0;
  let lastTouchY = 0;

  // Wheel intent arrives before the resulting scroll event. Disengage here so
  // a streaming resize cannot snap back to the bottom between the two.
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY < 0 && !event.ctrlKey) scroll.pause();
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
    if (dy > 0 && Math.abs(dy) > Math.abs(dx)) scroll.pause();
    lastTouchX = touch.clientX;
    lastTouchY = touch.clientY;
  };

  const onMouseDown = (event: MouseEvent) => {
    // Middle-button autoscroll, or a native scrollbar press (including RTL gutters).
    if (event.button === 1) scroll.pause();
    if (event.button !== 0 || event.target !== scroller) return;
    const x = event.clientX - scroller.getBoundingClientRect().left - scroller.clientLeft;
    if (x < 0 || x >= scroller.clientWidth) scroll.pause();
  };

  const onKey = (event: KeyboardEvent) => {
    if (!view.active() || props.active === false) return;
    if (
      view.embedded &&
      event.target instanceof Element &&
      !scroller.parentElement?.contains(event.target)
    )
      return;
    if (
      !event.defaultPrevented &&
      !event.metaKey &&
      !event.altKey &&
      view.active() &&
      state.viewMode !== 'map' &&
      event.target instanceof HTMLElement &&
      (event.target === document.body || scroller.contains(event.target)) &&
      !event.target.closest('input, textarea, select, [contenteditable]') &&
      (event.key === 'ArrowUp' ||
        event.key === 'PageUp' ||
        event.key === 'Home' ||
        (event.key === ' ' && event.shiftKey && !event.target.closest('button, [role="button"]')))
    )
      scroll.pause();
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.repeat) return;
    if (
      !view.active() ||
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
    if (state.viewMode === 'map') return;
    scroll.reset();
    requestAnimationFrame(() => {
      if (props.active !== false && state.viewMode !== 'map') scroll.follow();
    });
  });

  // Catch layout changes beyond token updates, including markdown and font settling.
  const resizeObserver = new ResizeObserver(() => {
    if (props.active !== false && state.viewMode !== 'map') scroll.follow();
  });
  onCleanup(() => resizeObserver.disconnect());

  createEffect(() => {
    const path = activePath();
    const last = path[path.length - 1];
    void last?.content.length;
    void last?.reasoning?.length;
    if (props.active !== false && state.viewMode !== 'map') scroll.follow();
  });

  return (
    <div
      class="chat flex-1 [&.chat-map]:overflow-hidden [&:not(.chat-map)_.msg-user_.md>:is(p,_ul,_ol,_blockquote)]:max-w-[80ch] [&:not(.chat-map)_.msg-assistant_.md>:is(p,_ul,_ol,_blockquote)]:max-w-[80ch]"
      classList={{ 'chat-map': state.viewMode === 'map' }}
      ref={(el) => {
        scroller = el;
        scroll = createChatScroll(el);
      }}
      onScroll={() => scroll.onScroll()}
      onMouseDown={onMouseDown}
      onWheel={onWheel}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
    >
      <Show
        when={selectedConversation()}
        fallback={
          // Hide until booted to prevent a welcome-screen flash on reload.
          <div
            class="items-center p-5 text-center flex flex-col gap-3 justify-center h-full"
            classList={{ hidden: !state.booted }}
          >
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
        <div
          class="chat-inner my-0 mx-auto flex flex-col max-w-chat gap-chat-inline p-chat-inline pt-4 pb-3 small-touch:gap-chat-inline small-touch:p-[calc(var(--space-2)_+_env(safe-area-inset-top))_var(--chat-inline-padding)_var(--space-3)]"
          ref={(el) => resizeObserver.observe(el)}
        >
          <Show
            when={state.viewMode === 'chat'}
            fallback={
              <Show when={state.viewMode === 'trace'} fallback={<TreeMap active={props.active} />}>
                <TraceView pendingMessage={props.pendingMessage ?? ''} />
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
