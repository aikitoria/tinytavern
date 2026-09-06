import { Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import type { Message } from '@tinytavern/shared';
import type { PendingSwipe } from '../state/store.ts';
import { api } from '../state/api.ts';
import {
  extendMessageSelection,
  messageIsSelected,
  messageSelectionActive,
  startMessageSelection,
} from '../state/messageSelection.ts';
import {
  branchConversation,
  childrenByParent,
  editRequestId,
  navigateTree,
  pendingSwipe,
  selectedCharacter,
  personasEnabled,
  selectedPersona,
  setEditRequestId,
  siblingsOf,
  state,
  streamingMessage,
} from '../state/store.ts';
import { messageSupportsSwipe, swipeMessage } from '../messageSwipe.ts';
import { findMessageView } from '../plugins/index.ts';
import Avatar from './Avatar.tsx';
import DropdownSurface from './DropdownSurface.tsx';
import Markdown from './Markdown.tsx';
import Modal from './Modal.tsx';
import TrashIcon from './TrashIcon.tsx';

const ThinkingIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="15"
    height="15"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M9 18h6" />
    <path d="M10 22h4" />
    <path d="M8.3 14.5A7 7 0 1 1 15.7 14.5C14.8 15.2 14.5 16 14.5 17h-5c0-1-.3-1.8-1.2-2.5Z" />
  </svg>
);

// On touch layouts, only the last-tapped message shows actions.
const [touchedId, setTouchedId] = createSignal<number | null>(null);

// At most one ⋯ menu is open at a time across the message list.
const [moreMenuId, setMoreMenuId] = createSignal<number | null>(null);

export default function MessageNode(props: { message: Message; inMap?: boolean }) {
  const [editing, setEditing] = createSignal(false);
  const [showReasoning, setShowReasoning] = createSignal(false);
  let editArea: HTMLTextAreaElement | undefined;
  let moreButton: HTMLButtonElement | undefined;

  const isUser = () => props.message.role === 'user';
  const isTool = () => props.message.role === 'tool';
  const isAssistant = () => props.message.role === 'assistant';
  const persona = () => (personasEnabled() ? selectedPersona() : null);
  const name = () =>
    isUser()
      ? (persona()?.name ?? 'You')
      : isTool()
        ? (props.message.name ?? 'Tool')
        : (props.message.name ?? selectedCharacter()?.name ?? 'Assistant');
  const avatarSrc = () => (isUser() ? persona()?.avatar : selectedCharacter()?.avatar);
  const streaming = () => props.message.status === 'streaming';

  const siblings = () => siblingsOf(props.message);
  const siblingIndex = () => siblings().findIndex((m) => m.id === props.message.id);

  // Match descendants of the outgoing or incoming swipe branch.
  const isBelowSwipe = (p: PendingSwipe, requireOutgoing: boolean): boolean => {
    let cur = props.message.parentId;
    while (cur != null) {
      const ancestor = state.tree.messages[cur];
      if (!ancestor) return false;
      if ((ancestor.parentId ?? -1) === p.parentKey) {
        return requireOutgoing ? ancestor.id === p.outgoingId : ancestor.id !== p.outgoingId;
      }
      cur = ancestor.parentId;
    }
    return false;
  };

  // Capture at mount: siblings slide content only; descendants include their header and tools.
  const swipeAtMount = pendingSwipe();
  const enterAs =
    swipeAtMount && swipeAtMount.outgoingId !== props.message.id
      ? (props.message.parentId ?? -1) === swipeAtMount.parentKey
        ? 'sibling'
        : isBelowSwipe(swipeAtMount, false)
          ? 'descendant'
          : null
      : null;
  const enterDir = enterAs ? swipeAtMount!.dir : 0;

  // Hold outgoing nodes offscreen until the tree frame unmounts them.
  // Failed swipes clear pendingSwipe and spring back.
  const exitInfo = (): { dir: 1 | -1; whole: boolean } | null => {
    const p = pendingSwipe();
    if (!p) return null;
    if (p.outgoingId === props.message.id) return { dir: p.dir, whole: false };
    if (isBelowSwipe(p, true)) return { dir: p.dir, whole: true };
    return null;
  };
  const slideOut = (dir: 1 | -1) => `translateX(${dir === 1 ? -105 : 105}%)`;

  // User forks may be ancestors because saving one immediately adds a reply.
  const [dragX, setDragX] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  let pointerX = 0;
  let pointerY = 0;
  let pointerId: number | null = null;
  let pointerTarget: HTMLElement | null = null;
  let horizontal = false;

  const reasoningOpen = () =>
    showReasoning() || (state.settings.autoExpandThinking && streaming() && !props.message.content);

  // Match the server generation guard while allowing swipes past a streaming leaf.
  const ancestorNavigationBlocked = () =>
    streamingMessage() != null && state.tree.activeLeafId !== props.message.id;

  const swipeable = () =>
    messageSupportsSwipe(props.message) &&
    !messageSelectionActive() &&
    !editing() &&
    !state.treeNavigationPending &&
    (state.tree.activeLeafId === props.message.id ||
      (isUser() && siblings().length > 1 && !ancestorNavigationBlocked()));

  const resetPointerSwipe = () => {
    if (pointerTarget != null && pointerId != null && pointerTarget.hasPointerCapture(pointerId)) {
      pointerTarget.releasePointerCapture(pointerId);
    }
    pointerId = null;
    pointerTarget = null;
    setDragging(false);
    setDragX(0);
    horizontal = false;
  };

  // Pointer capture survives streaming resize/autoscroll that can cancel mobile touch events.
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !swipeable() || pointerId != null) return;
    pointerX = e.clientX;
    pointerY = e.clientY;
    pointerId = e.pointerId;
    pointerTarget = e.currentTarget as HTMLElement;
    pointerTarget.setPointerCapture(e.pointerId);
    horizontal = false;
    setDragging(true);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging() || e.pointerId !== pointerId) return;
    const dx = e.clientX - pointerX;
    const dy = e.clientY - pointerY;
    if (!horizontal) {
      if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) {
        resetPointerSwipe(); // vertical scroll wins
        return;
      }
      horizontal = Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.5;
    }
    if (horizontal) {
      e.preventDefault();
      setDragX(Math.max(-64, Math.min(64, dx)));
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    if (dragging() && horizontal) {
      e.preventDefault();
      const dx = dragX();
      const dir = dx <= -48 ? 1 : dx >= 48 ? -1 : null;
      if (dir != null) swipeMessage(props.message, dir);
    }
    resetPointerSwipe();
  };

  // Cancellation must not navigate, even after crossing the swipe threshold.
  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId === pointerId) resetPointerSwipe();
  };

  const revealImageControlsOnFirstTap = (event: MouseEvent) => {
    if (
      !props.inMap &&
      window.matchMedia('(pointer: coarse)').matches &&
      touchedId() !== props.message.id &&
      (event.target as Element).closest?.('.msg-image')
    ) {
      // Full-bleed images need the first tap for controls; the second opens the viewer.
      event.preventDefault();
      event.stopPropagation();
      setTouchedId(props.message.id);
    }
  };

  const startEdit = () => {
    if (props.message.imagePending) return;
    setEditing(true);
    queueMicrotask(() => {
      if (!editArea) return;
      editArea.value = props.message.content;
      editArea.style.height = `${editArea.scrollHeight}px`;
      editArea.focus({ preventScroll: true });
    });
  };

  // The composer's ↑ key requests an in-place edit of the last sent message.
  createEffect(() => {
    if (editRequestId() === props.message.id) {
      setEditRequestId(null);
      if (!editing()) startEdit();
    }
  });

  const saveEdit = async (edit: typeof api.editMessage) => {
    const saved = await navigateTree(() => edit(props.message.id, editArea!.value, state.tree));
    if (saved) setEditing(false);
  };

  const remove = () => {
    void navigateTree(() => api.deleteMessage(props.message.id, state.tree));
  };
  const removeSwipe = () => {
    const pluginDelete = claimedView()?.deleteSwipe;
    if (pluginDelete && claimedView()?.canDeleteSwipe?.(props.message)) {
      void navigateTree(() => pluginDelete(props.message));
    } else {
      void navigateTree(() => api.deleteSwipe(props.message.id, state.tree));
    }
  };

  const copy = () => void navigator.clipboard.writeText(props.message.content);

  const menuOpen = () => moreMenuId() === props.message.id;
  const closeMenu = () => setMoreMenuId(null);
  const MenuItem = (item: {
    action: () => void;
    disabled?: boolean;
    danger?: boolean;
    children: JSX.Element;
  }) => (
    <button
      type="button"
      role="menuitem"
      classList={{ danger: item.danger }}
      disabled={item.disabled}
      onClick={() => {
        closeMenu();
        item.action();
      }}
    >
      {item.children}
    </button>
  );
  const canMoveUp = () => props.message.parentId != null;
  const canMoveDown = () => (childrenByParent().get(props.message.id)?.length ?? 0) > 0;
  const duplicate = () =>
    void navigateTree(() => api.duplicateMessage(props.message.id, state.tree));
  const branchToConversation = () => void navigateTree(() => branchConversation(props.message.id));
  const move = (direction: 'up' | 'down') =>
    void navigateTree(() => api.moveMessage(props.message.id, direction, state.tree));

  const [steerOpen, setSteerOpen] = createSignal(false);
  let steerArea: HTMLTextAreaElement | undefined;
  const openSteer = () => {
    setSteerOpen(true);
    queueMicrotask(() => steerArea?.focus({ preventScroll: true }));
  };
  const confirmSteer = async () => {
    const instruction = steerArea?.value.trim() ?? '';
    if (!instruction) return;
    const ok = await navigateTree(() =>
      api.regenerate(
        props.message.id,
        instruction,
        state.tree,
        claimedView()?.currentImageConfig?.(),
      ),
    );
    if (ok) setSteerOpen(false);
  };

  // Preserve plugin closure state across message updates until the claim changes.
  const claimedView = createMemo(() =>
    props.message.role === 'tool' ? findMessageView(props.message) : undefined,
  );
  const pluginView = createMemo(() => claimedView()?.create(() => props.message, { streaming }));

  // Do not reopen a stale menu when this message remounts.
  onCleanup(() => {
    if (moreMenuId() === props.message.id) setMoreMenuId(null);
  });

  return (
    <article
      ref={(element) => {
        element.addEventListener('click', revealImageControlsOnFirstTap, true);
        onCleanup(() => element.removeEventListener('click', revealImageControlsOnFirstTap, true));
      }}
      class="msg"
      classList={{
        'msg-user': isUser(),
        'msg-assistant': isAssistant(),
        'msg-tool': isTool(),
        'msg-streaming': streaming(),
        'msg-hide-name': pluginView()?.hideName === true,
        'msg-full-bleed': pluginView()?.fullBleed?.() === true,
        'msg-range-selected': messageIsSelected(props.message.id),
        touched: touchedId() === props.message.id,
      }}
      // Tree-map cards own branch clicks and touch panning.
      onClick={() => {
        if (!props.inMap) setTouchedId(props.message.id);
      }}
      onPointerDown={props.inMap ? undefined : onPointerDown}
      onPointerMove={props.inMap ? undefined : onPointerMove}
      onPointerUp={props.inMap ? undefined : onPointerUp}
      onPointerCancel={props.inMap ? undefined : onPointerCancel}
    >
      <Show
        when={!props.inMap && messageSelectionActive()}
        fallback={
          <Show
            when={!isTool()}
            fallback={
              <span class="avatar avatar-fallback tool-avatar">
                {pluginView()?.RailIcon?.() ?? '⚙'}
              </span>
            }
          >
            <Avatar src={avatarSrc()} name={name()} />
          </Show>
        }
      >
        <button
          type="button"
          class="msg-range-toggle icon-btn"
          classList={{ active: messageIsSelected(props.message.id) }}
          aria-label={`${messageIsSelected(props.message.id) ? 'Selected' : 'Select through'} ${name()} message`}
          aria-pressed={messageIsSelected(props.message.id)}
          onClick={() => extendMessageSelection(props.message.id)}
        >
          {messageIsSelected(props.message.id) ? '✓' : ''}
        </button>
      </Show>
      <div
        class="msg-body"
        classList={{
          'swipe-in-next': enterAs === 'descendant' && enterDir === 1,
          'swipe-in-prev': enterAs === 'descendant' && enterDir === -1,
        }}
        style={
          exitInfo()?.whole
            ? {
                transform: slideOut(exitInfo()!.dir),
                opacity: 0,
                transition: 'transform 0.18s ease-out, opacity 0.18s ease-out',
              }
            : undefined
        }
      >
        <div class="msg-head">
          <span class="msg-name">{name()}</span>
          <Show when={props.message.status === 'stopped'}>
            <span class="msg-chip">stopped</span>
          </Show>
          <Show when={streaming() && !props.message.content && !props.message.reasoning}>
            <span class="spinner spinner-wait" />
          </Show>
          <span class="msg-tools-left msg-overlay-toolbar">
            <Show when={props.message.reasoning}>
              <button
                class="reasoning-chip icon-btn"
                classList={{ 'icon-btn-active': reasoningOpen() }}
                title={reasoningOpen() ? 'Hide thinking' : 'Show thinking'}
                aria-label={reasoningOpen() ? 'Hide thinking' : 'Show thinking'}
                aria-expanded={reasoningOpen()}
                onClick={() => setShowReasoning(!showReasoning())}
              >
                <ThinkingIcon />
                <Show when={streaming() && !props.message.content}>
                  <span class="spinner" />
                </Show>
              </button>
            </Show>
            {pluginView()?.Header?.()}
          </span>
          <span class="msg-tools-top msg-overlay-toolbar">
            <Show when={!messageSelectionActive()}>
              {pluginView()?.HeaderTools?.()}
              <Show when={siblings().length > 1 || (isAssistant() && !editing())}>
                <span class="branch-nav">
                  <button
                    class="icon-btn"
                    title="Previous swipe"
                    aria-label="Previous swipe"
                    disabled={
                      state.treeNavigationPending ||
                      ancestorNavigationBlocked() ||
                      streaming() ||
                      editing() ||
                      siblingIndex() <= 0
                    }
                    onClick={() => swipeMessage(props.message, -1)}
                  >
                    ‹
                  </button>
                  <span
                    class="branch-count"
                    aria-label={`Swipe ${siblingIndex() + 1} of ${siblings().length}`}
                  >
                    {siblingIndex() + 1}/{siblings().length}
                  </span>
                  <button
                    class="icon-btn"
                    disabled={
                      state.treeNavigationPending ||
                      ancestorNavigationBlocked() ||
                      editing() ||
                      (!isAssistant() && siblingIndex() >= siblings().length - 1)
                    }
                    title={
                      isAssistant() && siblingIndex() >= siblings().length - 1
                        ? 'Regenerate'
                        : 'Next swipe'
                    }
                    aria-label={
                      isAssistant() && siblingIndex() >= siblings().length - 1
                        ? 'Regenerate'
                        : 'Next swipe'
                    }
                    onClick={() => swipeMessage(props.message, 1)}
                  >
                    ›
                  </button>
                </span>
              </Show>
              <Show when={!streaming() && !editing()}>
                <span class="msg-actions">
                  <span class="msg-more-wrap">
                    <button
                      ref={moreButton}
                      type="button"
                      class="icon-btn"
                      classList={{ 'icon-btn-active': menuOpen() }}
                      title="More"
                      aria-label="More message actions"
                      aria-haspopup="menu"
                      aria-expanded={menuOpen()}
                      onClick={() => setMoreMenuId(menuOpen() ? null : props.message.id)}
                    >
                      ⋯
                    </button>
                    <DropdownSurface
                      open={menuOpen()}
                      anchor={() => moreButton}
                      onClose={closeMenu}
                      class="msg-more-menu"
                      role="menu"
                      ariaLabel="Message actions"
                      placement="auto"
                      align="end"
                      fitContentWidth
                      keyboardNavigation
                      autoFocus
                    >
                      <MenuItem action={copy}>Copy</MenuItem>
                      <MenuItem disabled={props.message.imagePending} action={startEdit}>
                        Edit
                      </MenuItem>
                      <div class="menu-separator" role="separator" />
                      <Show when={isAssistant() || (isTool() && claimedView() != null)}>
                        <MenuItem action={openSteer}>Regenerate</MenuItem>
                      </Show>
                      <MenuItem action={duplicate}>Duplicate</MenuItem>
                      <MenuItem action={branchToConversation}>Branch chat</MenuItem>
                      <div class="menu-separator" role="separator" />
                      <MenuItem action={() => startMessageSelection(props.message.id)}>
                        Select range
                      </MenuItem>
                      <Show when={canMoveUp()}>
                        <MenuItem action={() => move('up')}>Move up</MenuItem>
                      </Show>
                      <Show when={canMoveDown()}>
                        <MenuItem action={() => move('down')}>Move down</MenuItem>
                      </Show>
                      <div class="menu-separator" role="separator" />
                      <Show
                        when={
                          claimedView()?.canDeleteSwipe?.(props.message) || siblings().length > 1
                        }
                      >
                        <MenuItem danger action={removeSwipe}>
                          <TrashIcon /> Delete swipe
                        </MenuItem>
                      </Show>
                      <MenuItem danger action={remove}>
                        <TrashIcon /> Delete
                      </MenuItem>
                    </DropdownSurface>
                  </span>
                </span>
              </Show>
            </Show>
          </span>
        </div>

        {/* At the swipe position only the content region slides; the name row and tools stay put. */}
        <div
          class="msg-swipe"
          classList={{
            'swipe-in-next': enterAs === 'sibling' && enterDir === 1,
            'swipe-in-prev': enterAs === 'sibling' && enterDir === -1,
          }}
          style={{
            transform:
              exitInfo() && !exitInfo()!.whole
                ? slideOut(exitInfo()!.dir)
                : dragX() !== 0
                  ? `translateX(${dragX()}px)`
                  : undefined,
            opacity: exitInfo() && !exitInfo()!.whole ? 0 : undefined,
            transition: dragging() ? 'none' : 'transform 0.18s ease-out, opacity 0.18s ease-out',
          }}
        >
          <Show when={props.message.reasoning && reasoningOpen()}>
            <div class="reasoning-text">{props.message.reasoning}</div>
          </Show>

          <Show
            when={!editing()}
            fallback={
              <div class="msg-edit">
                <textarea
                  ref={editArea}
                  onInput={(e) => {
                    // Measuring at auto height clamps scrollTop; restore it to keep tall edits visible.
                    const el = e.currentTarget;
                    const scroller = el.closest('.chat');
                    const top = scroller?.scrollTop;
                    el.style.height = 'auto';
                    el.style.height = `${el.scrollHeight}px`;
                    if (scroller && top !== undefined) scroller.scrollTop = top;
                  }}
                  onKeyDown={(e) => {
                    if (e.isComposing) return; // IME candidate confirmation, not a command
                    // Tool output has no branch semantics; save in place.
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      void saveEdit(isTool() ? api.editMessage : api.editBranch);
                    } else if (e.key === 'Escape') {
                      setEditing(false);
                    }
                  }}
                />
                <div class="msg-edit-actions">
                  <Show when={!isTool()}>
                    <button class="primary-btn" onClick={() => void saveEdit(api.editBranch)}>
                      {isUser() ? 'Send as branch' : 'Save as branch'}
                    </button>
                  </Show>
                  <button
                    classList={{ 'primary-btn': isTool() }}
                    onClick={() => void saveEdit(api.editMessage)}
                  >
                    Save in place
                  </button>
                  <button onClick={() => setEditing(false)}>Cancel</button>
                </div>
              </div>
            }
          >
            {pluginView() ? (
              pluginView()!.Body()
            ) : (
              <div class="msg-content">
                <Markdown content={props.message.content} streaming={streaming()} />
              </div>
            )}
          </Show>

          <Show when={props.message.status === 'error'}>
            <div class="msg-error">{props.message.genMeta?.error ?? 'Generation failed'}</div>
          </Show>
        </div>
      </div>
      <Show when={steerOpen()}>
        <Modal title="Regenerate with instruction" onClose={() => setSteerOpen(false)}>
          <div class="form">
            <label>Instruction (steers only this regeneration — never enters history)</label>
            <textarea
              ref={steerArea}
              rows={3}
              placeholder="e.g. make it shorter and more casual"
              onKeyDown={(e) => {
                if (e.isComposing) return; // IME candidate confirmation, not a command
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void confirmSteer();
                } else if (e.key === 'Escape') {
                  setSteerOpen(false);
                }
              }}
            />
            <div class="form-actions">
              <button class="primary-btn" onClick={() => void confirmSteer()}>
                Regenerate
              </button>
              <button onClick={() => setSteerOpen(false)}>Cancel</button>
            </div>
          </div>
        </Modal>
      </Show>
    </article>
  );
}
