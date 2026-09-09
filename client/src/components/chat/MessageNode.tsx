import {
  faCheck,
  faChevronLeft,
  faChevronRight,
  faEllipsis,
  faGear,
  faSpinner,
} from '@fortawesome/free-solid-svg-icons';
import { faLightbulb, faTrashCan } from '@fortawesome/free-regular-svg-icons';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import { Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import { characterChatName, type Message } from '@tinytavern/shared';
import type { PendingSwipe } from '../../state/store.ts';
import { api } from '../../state/api.ts';
import {
  extendMessageSelection,
  messageIsSelected,
  messageSelectionActive,
  startMessageSelection,
} from '../../state/messageSelection.ts';
import {
  branchConversation,
  childrenByParent,
  editRequestId,
  navigateTree,
  openCharacterSettings,
  pendingSwipe,
  selectedCharacter,
  personasEnabled,
  selectedPersona,
  setEditRequestId,
  siblingsOf,
  state,
  streamingMessage,
} from '../../state/store.ts';
import { messageSupportsSwipe, swipeMessage } from '../../messageSwipe.ts';
import { imageMessage } from '../../images/imageGeneration.tsx';
import Avatar from '../ui/Avatar.tsx';
import DropdownSurface from '../ui/DropdownSurface.tsx';
import Markdown from '../ui/Markdown.tsx';
import Modal from '../ui/Modal.tsx';
import PromptGenerationStatus from '../../media/PromptGenerationStatus.tsx';
import MediaPromptMenuItems from '../../media/MediaPromptMenuItems.tsx';

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
        : (props.message.name ?? characterChatName(selectedCharacter()));
  const avatarSrc = () =>
    isUser() ? persona()?.avatarThumbnail : selectedCharacter()?.avatarThumbnail;
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
    if (e.pointerType === 'touch' && (e.target as Element).closest('video')) {
      // Native playback can consume clicks; reveal tools without capturing the player's gesture.
      setTouchedId(props.message.id);
      return;
    }
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
    const saved = await navigateTree(() =>
      edit(props.message.id, state.tree, { content: editArea!.value }),
    );
    if (saved) setEditing(false);
  };

  const remove = () => {
    void navigateTree(() => api.deleteMessage(props.message.id, state.tree));
  };
  const removeSwipe = () => {
    const imageDelete = imageBehavior()?.deleteSwipe;
    if (imageDelete && imageBehavior()?.canDeleteSwipe?.(props.message)) {
      void navigateTree(() => imageDelete(props.message));
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
    void navigateTree(() => api.moveMessage(props.message.id, state.tree, { direction }));

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
      api.regenerate(props.message.id, state.tree, {
        instruction,
        image: imageBehavior()?.currentImageConfig?.(props.message),
      }),
    );
    if (ok) setSteerOpen(false);
  };

  // Preserve image view state across streaming and image updates.
  const imageBehavior = createMemo(() =>
    imageMessage.matches(props.message) ? imageMessage : undefined,
  );
  const imageView = createMemo(() =>
    imageBehavior()?.create(() => props.message, {
      streaming,
      inMap: () => props.inMap === true,
    }),
  );

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
      class="msg items-start flex gap-chat-gap touch:[&.touched_.msg-actions]:opacity-100 touch:[&.touched_.msg-actions]:pointer-events-auto touch:[&.touched_.branch-nav_.icon-btn]:opacity-100 touch:[&.touched_.branch-nav_.icon-btn]:pointer-events-auto touch:[&.touched_.branch-count]:opacity-100 touch:[&.touched_.branch-count]:pointer-events-auto touch:[&:focus-within_.msg-actions]:opacity-100 touch:[&:focus-within_.msg-actions]:pointer-events-auto touch:[&:focus-within_.branch-nav_.icon-btn]:opacity-100 touch:[&:focus-within_.branch-nav_.icon-btn]:pointer-events-auto touch:[&:focus-within_.branch-count]:opacity-100 touch:[&:focus-within_.branch-count]:pointer-events-auto touch:[&.msg-menu-open_.msg-actions]:opacity-100 touch:[&.msg-menu-open_.msg-actions]:pointer-events-auto touch:[&.msg-menu-open_.branch-nav_.icon-btn]:opacity-100 touch:[&.msg-menu-open_.branch-nav_.icon-btn]:pointer-events-auto touch:[&.msg-menu-open_.branch-count]:opacity-100 touch:[&.msg-menu-open_.branch-count]:pointer-events-auto small-touch:[&>.avatar]:display-none [&:where(.msg-user)>.msg-body]:py-2 [&:where(.msg-user)>.msg-body]:px-3 [&:where(.msg-user)>.msg-body]:rounded-md [&:where(.msg-assistant)>.msg-body]:py-2 [&:where(.msg-assistant)>.msg-body]:px-3 [&:where(.msg-assistant)>.msg-body]:rounded-md [&:where(.msg-user)>.msg-body]:bg-user-message [&:where(.msg-assistant)>.msg-body]:bg-message [&:where(.msg-user)_.msg-head]:mb-0 [&:where(.msg-assistant)_.msg-head]:mb-0 [&:where(.msg-user)_.md>:first-child]:mt-1 [&:where(.msg-assistant)_.md>:first-child]:mt-1 [&:where(.msg-user)_.md_em]:text-dim [&:where(.msg-assistant)_.md_em]:text-dim [&:where(.msg-user)_.md>:last-child]:mb-0 [&:where(.msg-assistant)_.md>:last-child]:mb-0 [&:where(.msg-user)>.avatar]:shadow-clear [&:where(.msg-assistant)>.avatar]:shadow-clear [&:where(.msg-user)_.msg-name]:text-user [&:where(.msg-assistant)_.msg-name]:text-assistant [&:where(.msg-tool)_.msg-body]:bg-panel [&:where(.msg-tool)_.msg-body]:border [&:where(.msg-tool)_.msg-body]:border-solid [&:where(.msg-tool)_.msg-body]:border-transparent [&:where(.msg-tool)_.msg-body]:rounded-md [&:where(.msg-tool)_.msg-body]:p-3 [&:where(.msg-tool)_.msg-name]:text-dim [&:where(.msg-tool).msg-full-bleed_.msg-body]:relative [&:where(.msg-tool).msg-full-bleed_.msg-body]:p-0 [&:where(.msg-tool).msg-full-bleed_.msg-body]:overflow-hidden [&:where(.msg-tool).msg-full-bleed_.msg-body]:bg-clear [&:where(.msg-tool).msg-full-bleed_.msg-body]:border-clear [&:where(.msg-tool).msg-full-bleed_.msg-body]:rounded-md [&:where(.msg-tool).msg-full-bleed_.msg-head]:absolute [&:where(.msg-tool).msg-full-bleed_.msg-head]:z-3 [&:where(.msg-tool).msg-full-bleed_.msg-head]:top-2 [&:where(.msg-tool).msg-full-bleed_.msg-head]:right-2 [&:where(.msg-tool).msg-full-bleed_.msg-head]:left-2 [&:where(.msg-tool).msg-full-bleed_.msg-head]:m-0 [&:where(.msg-tool).msg-full-bleed_.msg-head]:pointer-events-none [&:where(.msg-tool).msg-full-bleed_.msg-swipe:has(>.reasoning-text,>.msg-content)]:pt-11 [&:where(.msg-tool).msg-full-bleed_.msg-swipe:has(>.reasoning-text,>.msg-content)]:bg-panel [&:where(.msg-tool).msg-full-bleed_.reasoning-text]:m-[0_var(--space-3)_var(--space-2)] [&:where(.msg-tool).msg-full-bleed_.msg-content]:p-[0_var(--space-3)_var(--space-3)] [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar]:pointer-events-auto [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar]:inline-flex [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar]:items-center [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar]:gap-1 [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar]:relative [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar]:isolate [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar]:p-0.5 [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar]:text-white [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar]:border [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar]:border-solid [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar]:border-transparent [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar]:rounded-full [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar_.icon-btn]:rounded-full [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar::before]:inset-[-1px] [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar::before]:absolute [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar::before]:-z-1 [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar::before]:border [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar::before]:border-solid [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar::before]:border-control-line [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar::before]:rounded-[inherit] [&:where(.msg-tool).msg-full-bleed_.msg-overlay-toolbar::before]:opacity-0 [&:where(.msg-tool).msg-hide-name.msg-full-bleed_.msg-tools-left]:opacity-0 [&:where(.msg-tool).msg-hide-name.msg-full-bleed_.msg-tools-left]:pointer-events-none [&:where(.msg-tool).msg-hide-name.msg-full-bleed:hover_.msg-tools-left]:opacity-100 [&:where(.msg-tool).msg-hide-name.msg-full-bleed:hover_.msg-tools-left]:pointer-events-auto [&:where(.msg-tool).msg-hide-name.msg-full-bleed:focus-within_.msg-tools-left]:opacity-100 [&:where(.msg-tool).msg-hide-name.msg-full-bleed:focus-within_.msg-tools-left]:pointer-events-auto [&:where(.msg-tool).msg-hide-name.msg-full-bleed.msg-streaming_.msg-tools-left]:opacity-100 [&:where(.msg-tool).msg-hide-name.msg-full-bleed.msg-streaming_.msg-tools-left]:pointer-events-auto [&:hover_.msg-actions]:opacity-100 [&:hover_.msg-actions]:pointer-events-auto [&:focus-within_.msg-actions]:opacity-100 [&:focus-within_.msg-actions]:pointer-events-auto [&.msg-menu-open_.msg-actions]:opacity-100 [&.msg-menu-open_.msg-actions]:pointer-events-auto [&:hover_.branch-nav_.icon-btn]:opacity-100 [&:hover_.branch-nav_.icon-btn]:pointer-events-auto [&:hover_.branch-count]:opacity-100 [&:hover_.branch-count]:pointer-events-auto [&:focus-within_.branch-nav_.icon-btn]:opacity-100 [&:focus-within_.branch-nav_.icon-btn]:pointer-events-auto [&:focus-within_.branch-count]:opacity-100 [&:focus-within_.branch-count]:pointer-events-auto [&.msg-menu-open_.branch-nav_.icon-btn]:opacity-100 [&.msg-menu-open_.branch-nav_.icon-btn]:pointer-events-auto [&.msg-menu-open_.branch-count]:opacity-100 [&.msg-menu-open_.branch-count]:pointer-events-auto [&:where(.msg-tool).msg-full-bleed_.msg-tools-top_.branch-nav]:text-inherit [&:where(.msg-tool).msg-full-bleed_.msg-tools-top_.msg-image-pending]:text-inherit [&:where(.msg-tool).msg-full-bleed_.msg-tools-top]:gap-0 [&:where(.msg-tool).msg-full-bleed_.msg-tools-top>:is(.msg-actions,_.branch-nav)]:min-w-0 [&:where(.msg-tool).msg-full-bleed_.msg-tools-top>:is(.msg-actions,_.branch-nav)]:max-w-0 [&:where(.msg-tool).msg-full-bleed_.msg-tools-top>:is(.msg-actions,_.branch-nav)]:overflow-hidden [&:where(.msg-tool).msg-full-bleed:is(:hover,_:focus-within,_.msg-menu-open)_.msg-tools-top>:is(.msg-actions,_.branch-nav)]:max-w-none [&:where(.msg-tool).msg-full-bleed:is(:hover,_:focus-within,_.msg-menu-open)_.msg-tools-top>:is(.msg-actions,_.branch-nav)]:overflow-visible [&:where(.msg-tool).msg-full-bleed:is(:hover,_:focus-within,_.msg-menu-open)_.msg-tools-top>:is(.msg-actions,_.branch-nav):not(:first-child)]:ml-1 [&:where(.msg-tool).msg-full-bleed:is(:hover,_:focus-within,_.msg-menu-open)_.msg-image-pending]:border-r-control-line [&:where(.msg-tool).msg-hide-name_.msg-tools-left:empty]:display-none [&:where(.msg-tool).msg-full-bleed_.msg-tools-top:empty]:display-none [&:where(.msg-tool).msg-full-bleed:hover_.msg-overlay-toolbar::before]:opacity-100 [&:where(.msg-tool).msg-full-bleed:focus-within_.msg-overlay-toolbar::before]:opacity-100 [&:where(.msg-tool).msg-full-bleed.msg-menu-open_.msg-tools-top::before]:opacity-100 [&:where(.msg-tool).msg-full-bleed_.msg-tools-top:has(.msg-image-pending)::before]:opacity-100 [&:where(.msg-tool).msg-hide-name.msg-full-bleed.msg-streaming_.msg-tools-left::before]:opacity-100 touch:[&:where(.msg-tool).msg-full-bleed:not(.touched):not(:focus-within):not(.msg-menu-open)_.msg-tools-top>:is(.msg-actions,_.branch-nav)]:max-w-0 touch:[&:where(.msg-tool).msg-full-bleed:not(.touched):not(:focus-within):not(.msg-menu-open)_.msg-tools-top>:is(.msg-actions,_.branch-nav)]:overflow-hidden touch:[&:where(.msg-tool).msg-full-bleed:not(.touched):not(:focus-within):not(.msg-menu-open)_.msg-tools-top>:is(.msg-actions,_.branch-nav)]:ml-0 touch:[&:where(.msg-tool).msg-full-bleed:not(.touched):not(:focus-within):not(.msg-menu-open)_.msg-image-pending]:border-r-transparent touch:[&:where(.msg-tool).msg-full-bleed.touched_.msg-tools-top>:is(.msg-actions,_.branch-nav)]:max-w-none touch:[&:where(.msg-tool).msg-full-bleed.touched_.msg-tools-top>:is(.msg-actions,_.branch-nav)]:overflow-visible touch:[&:where(.msg-tool).msg-full-bleed.touched_.msg-tools-top>:is(.msg-actions,_.branch-nav):not(:first-child)]:ml-1 touch:[&:where(.msg-tool).msg-full-bleed.touched_.msg-image-pending]:border-r-control-line touch:[&:where(.msg-tool).msg-full-bleed.touched_.msg-overlay-toolbar::before]:opacity-100 touch:[&:where(.msg-tool).msg-hide-name.msg-full-bleed.touched_.msg-tools-left]:opacity-100 touch:[&:where(.msg-tool).msg-hide-name.msg-full-bleed.touched_.msg-tools-left]:pointer-events-auto [&:where(.msg-tool)_.msg-content]:text-dim [&:where(.msg-tool)_.md>:last-child]:mb-0"
      classList={{
        'msg-user': isUser(),
        'msg-assistant': isAssistant(),
        'msg-tool': isTool(),
        'msg-streaming': streaming(),
        'msg-hide-name': imageView()?.hideName === true,
        'msg-full-bleed': imageView()?.fullBleed?.() === true,
        'msg-menu-open': menuOpen(),
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
      <Show when={!props.inMap}>
        <Show
          when={messageSelectionActive()}
          fallback={
            <Show
              when={!isTool()}
              fallback={
                <span class="avatar avatar-fallback tool-avatar text-secondary">
                  {imageView()?.RailIcon?.() ?? <FontAwesomeIcon icon={faGear} />}
                </span>
              }
            >
              <Avatar src={avatarSrc()} name={name()} />
            </Show>
          }
        >
          <button
            type="button"
            class="min-w-chat-rail bg-raised border-line text-dim icon-btn size-chat-rail [&.active]:text-accent-text [&.active]:bg-accent [&.active]:border-accent"
            classList={{ active: messageIsSelected(props.message.id) }}
            aria-label={`${messageIsSelected(props.message.id) ? 'Selected' : 'Select through'} ${name()} message`}
            aria-pressed={messageIsSelected(props.message.id)}
            onClick={() => extendMessageSelection(props.message.id)}
          >
            {messageIsSelected(props.message.id) ? (
              <FontAwesomeIcon icon={faCheck} size={12} />
            ) : null}
          </button>
        </Show>
      </Show>
      <div
        class="msg-body flex-1 min-w-0"
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
        <div class="msg-head mb-0.5 flex items-center gap-2">
          <Show
            when={!props.inMap && isAssistant() && selectedCharacter()}
            fallback={
              <span class="msg-name truncate min-w-0 font-semibold text-label">{name()}</span>
            }
          >
            {(character) => (
              <button
                type="button"
                class="msg-name truncate min-w-0 msg-character-link rounded-none p-0 bg-clear border-clear text-left font-semibold text-label leading-inherit [&:hover]:bg-clear"
                title={`Character settings: ${character().name}`}
                aria-label={`Open character settings for ${character().name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  openCharacterSettings(character().id);
                }}
              >
                {name()}
              </button>
            )}
          </Show>
          <Show when={props.message.status === 'stopped'}>
            <span class="border border-solid border-line rounded-full py-0 px-2 flex-none text-dim text-xs">
              stopped
            </span>
          </Show>
          <Show
            when={streaming() && !isTool() && !props.message.content && !props.message.reasoning}
          >
            <FontAwesomeIcon
              icon={faSpinner}
              size={12}
              class="spinner inline-block w-3 h-3 text-dim flex-none w-2.5 h-2.5 origin-center"
            />
          </Show>
          <span class="msg-tools-left inline-flex items-center gap-1 msg-overlay-toolbar">
            <Show when={props.message.reasoning && !(isTool() && streaming())}>
              <button
                class="icon-btn [&.icon-btn]:w-auto [&.icon-btn]:min-w-0 [&.icon-btn]:cursor-pointer [&.icon-btn]:gap-1 [&>svg]:flex-none [&.icon-btn]:px-[3px]"
                classList={{ 'icon-btn-active': reasoningOpen() }}
                title={reasoningOpen() ? 'Hide thinking' : 'Show thinking'}
                aria-label={reasoningOpen() ? 'Hide thinking' : 'Show thinking'}
                aria-expanded={reasoningOpen()}
                onClick={() => setShowReasoning(!showReasoning())}
              >
                <FontAwesomeIcon icon={faLightbulb} size={15} />
                <Show when={streaming() && !props.message.content}>
                  <FontAwesomeIcon
                    icon={faSpinner}
                    size={10}
                    class="spinner inline-block flex-none origin-center size-2.5"
                  />
                </Show>
              </button>
            </Show>
            {imageView()?.Header?.()}
          </span>
          <span class="msg-tools-top inline-flex items-center gap-2 ml-auto msg-overlay-toolbar">
            <Show when={!messageSelectionActive()}>
              {imageView()?.HeaderTools?.()}
              <Show when={siblings().length > 1 || (isAssistant() && !editing())}>
                <span class="branch-nav gap-0 inline-flex items-center text-dim text-caption touch:[&_.icon-btn]:opacity-0 touch:[&_.icon-btn]:pointer-events-none touch:[&_.icon-btn]:w-5 touch:[&_.icon-btn]:min-w-5 touch:[&_.icon-btn]:h-7 [&_.icon-btn]:w-4.5 [&_.icon-btn]:min-w-4.5 [&_.icon-btn]:h-6 [&_.icon-btn]:text-sm [&_.icon-btn]:opacity-0 [&_.icon-btn]:pointer-events-none [&:focus-within_.icon-btn]:opacity-100 [&:focus-within_.icon-btn]:pointer-events-auto [&:focus-within_.branch-count]:opacity-100 [&:focus-within_.branch-count]:pointer-events-auto">
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
                    <FontAwesomeIcon icon={faChevronLeft} size={12} />
                  </button>
                  <span
                    class="branch-count px-0.5 min-w-0 whitespace-nowrap text-center touch:opacity-0 touch:pointer-events-none opacity-0 pointer-events-none"
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
                    <FontAwesomeIcon icon={faChevronRight} size={12} />
                  </button>
                </span>
              </Show>
              <Show when={!streaming() && !editing()}>
                <span class="msg-actions inline-flex gap-1 touch:opacity-0 touch:pointer-events-none opacity-0 pointer-events-none [&:focus-within]:opacity-100 [&:focus-within]:pointer-events-auto">
                  <span class="inline-flex">
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
                      <FontAwesomeIcon icon={faEllipsis} size={16} />
                    </button>
                    <DropdownSurface
                      open={menuOpen()}
                      anchor={() => moreButton}
                      onClose={closeMenu}
                      class="msg-more-menu [&_button]:whitespace-nowrap [&_.danger]:text-danger"
                      role="menu"
                      ariaLabel="Message actions"
                      placement="auto"
                      align="end"
                      fitContentWidth
                      keyboardNavigation
                      autoFocus
                    >
                      <MenuItem action={copy}>Copy</MenuItem>
                      <MediaPromptMenuItems
                        text={props.message.content}
                        conversationId={props.message.conversationId}
                        onClose={closeMenu}
                      />
                      <MenuItem disabled={props.message.imagePending} action={startEdit}>
                        Edit
                      </MenuItem>
                      <div class="h-px my-1 mx-0 bg-line" role="separator" />
                      <Show when={isAssistant() || (isTool() && imageBehavior() != null)}>
                        <MenuItem action={openSteer}>Regenerate</MenuItem>
                      </Show>
                      <MenuItem action={duplicate}>Duplicate</MenuItem>
                      <MenuItem action={branchToConversation}>Branch chat</MenuItem>
                      <div class="h-px my-1 mx-0 bg-line" role="separator" />
                      <MenuItem action={() => startMessageSelection(props.message.id)}>
                        Select range
                      </MenuItem>
                      <Show when={canMoveUp()}>
                        <MenuItem action={() => move('up')}>Move up</MenuItem>
                      </Show>
                      <Show when={canMoveDown()}>
                        <MenuItem action={() => move('down')}>Move down</MenuItem>
                      </Show>
                      <div class="h-px my-1 mx-0 bg-line" role="separator" />
                      <Show
                        when={
                          imageBehavior()?.canDeleteSwipe?.(props.message) || siblings().length > 1
                        }
                      >
                        <MenuItem danger action={removeSwipe}>
                          <FontAwesomeIcon icon={faTrashCan} size={15} /> Delete swipe
                        </MenuItem>
                      </Show>
                      <MenuItem danger action={remove}>
                        <FontAwesomeIcon icon={faTrashCan} size={15} /> Delete
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
          <PromptGenerationStatus
            active={isTool() && streaming()}
            content={props.message.content}
            reasoning={props.message.reasoning}
          />
          <Show when={props.message.reasoning && reasoningOpen() && !(isTool() && streaming())}>
            <div class="reasoning-text py-2 px-3 whitespace-pre-wrap bg-thinking text-dim text-sm rounded-sm m-0 mt-1 mb-2">
              {props.message.reasoning}
            </div>
          </Show>

          <Show
            when={!editing()}
            fallback={
              <div class="[&_textarea]:min-h-17.5 [&_textarea]:overflow-y-hidden">
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
                <div class="flex gap-2 flex-wrap mt-2">
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
            {imageView() ? (
              imageView()!.Body()
            ) : (
              <div class="msg-content">
                <Markdown
                  content={props.message.content}
                  streaming={streaming()}
                  conversationId={props.message.conversationId}
                />
              </div>
            )}
          </Show>

          <Show when={props.message.status === 'error'}>
            <div class="text-danger border border-solid border-danger py-2 px-3 mt-2 text-sm rounded-sm">
              {props.message.genMeta?.error ?? 'Generation failed'}
            </div>
          </Show>
        </div>
      </div>
      <Show when={steerOpen()}>
        <Modal title="Regenerate with instruction" onClose={() => setSteerOpen(false)}>
          <div class="form [&_label]:text-label [&_label]:text-foreground [&_label]:mt-2">
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
            <div class="form-actions flex items-center gap-2 flex-wrap mt-4">
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
