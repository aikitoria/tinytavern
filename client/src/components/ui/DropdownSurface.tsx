import { useDialogActive } from '../../state/dialogContext.ts';
import { Show, createEffect, createSignal, onCleanup, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { registerUiBack } from '../../state/uiBack.ts';

const DEFAULT_GAP = 4;
const DEFAULT_GUTTER = 8;
const INITIAL_MAX_HEIGHT = 320;

type Placement = 'auto' | 'top' | 'bottom';
type Align = 'start' | 'end';

interface Position {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  up: boolean;
  ready: boolean;
}

/** Shared popup positioning, dismissal and focus handling; triggers own semantics and state. */
export default function DropdownSurface(props: {
  open: boolean;
  anchor: () => HTMLElement | undefined;
  dismissRoot?: () => HTMLElement | undefined;
  focusTarget?: () => HTMLElement | undefined;
  onClose: () => void;
  children: JSX.Element;
  id?: string;
  class?: string;
  role?: 'menu' | 'listbox' | 'dialog';
  ariaLabel?: string;
  placement?: Placement;
  align?: Align;
  matchAnchorWidth?: boolean;
  fitContentWidth?: boolean;
  minWidth?: number;
  maxHeight?: number | (() => number);
  gap?: number;
  viewportGutter?: number;
  anchorInset?: number;
  keyboardNavigation?: boolean;
  autoFocus?: boolean;
  initialFocus?: () => HTMLElement | undefined;
  ref?: (element: HTMLDivElement) => void;
}) {
  const paneActive = useDialogActive();
  createEffect(() => {
    if (props.open && !paneActive()) props.onClose();
  });
  const [position, setPosition] = createSignal<Position>({
    left: DEFAULT_GUTTER,
    top: DEFAULT_GUTTER,
    width: 0,
    maxHeight: INITIAL_MAX_HEIGHT,
    up: false,
    ready: false,
  });
  let surface: HTMLDivElement | undefined;
  let focusFrame = 0;

  const maxHeightLimit = () =>
    typeof props.maxHeight === 'function' ? props.maxHeight() : (props.maxHeight ?? Number.POSITIVE_INFINITY);

  const reposition = (reveal = true): boolean => {
    const anchor = props.anchor();
    if (!props.open || !anchor || !surface) return false;
    const rect = anchor.getBoundingClientRect();
    const gutter = props.viewportGutter ?? DEFAULT_GUTTER;
    const gap = props.gap ?? DEFAULT_GAP;
    const anchorInset = props.anchorInset ?? 0;
    const anchorLeft = rect.left + anchorInset;
    const anchorRight = rect.right - anchorInset;
    const anchorWidth = Math.max(0, rect.width - anchorInset * 2);
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const availableWidth = Math.max(0, viewportWidth - gutter * 2);
    let requestedWidth: number;
    if (props.fitContentWidth) {
      surface.style.width = 'max-content';
      surface.style.maxWidth = `${availableWidth}px`;
      requestedWidth = Math.max(
        Math.ceil(surface.getBoundingClientRect().width),
        props.matchAnchorWidth ? anchorWidth : 0,
        props.minWidth ?? 0,
      );
    } else {
      surface.style.maxWidth = '';
      requestedWidth = props.matchAnchorWidth
        ? Math.max(anchorWidth, props.minWidth ?? 0)
        : (props.minWidth ?? anchorWidth);
    }
    const width = Math.min(requestedWidth, availableWidth);
    // Final-width wrapping must determine which side of the trigger has room.
    surface.style.width = `${width}px`;
    const measuredHeight = surface.scrollHeight;
    const spaceAbove = Math.max(0, rect.top - gap - gutter);
    const spaceBelow = Math.max(0, viewportHeight - rect.bottom - gap - gutter);
    const placement = props.placement ?? 'auto';
    const up = placement === 'top' || (placement === 'auto' && measuredHeight > spaceBelow && spaceAbove > spaceBelow);
    const maxHeight = Math.max(0, Math.min(maxHeightLimit(), up ? spaceAbove : spaceBelow));
    const renderedHeight = Math.min(measuredHeight, maxHeight);
    const preferredLeft = (props.align ?? 'start') === 'end' ? anchorRight - width : anchorLeft;
    const left = Math.min(Math.max(preferredLeft, gutter), Math.max(gutter, viewportWidth - gutter - width));
    const top = up ? rect.top - gap - renderedHeight : rect.bottom + gap;
    setPosition({ left, top, width, maxHeight, up, ready: reveal });
    return true;
  };

  const onViewportChange = () => reposition();

  const focusableItems = () =>
    surface
      ? [
          ...surface.querySelectorAll<HTMLElement>(
            '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])',
          ),
        ].filter((element) => element.getClientRects().length > 0)
      : [];

  const focusItem = (index: number) => {
    const items = focusableItems();
    if (items.length === 0) return;
    items[(index + items.length) % items.length]?.focus({ preventScroll: true });
  };

  const focusInitialItem = () => {
    const initial = props.initialFocus?.();
    if (initial) {
      initial.focus({ preventScroll: true });
      return;
    }
    const selected = surface?.querySelector<HTMLElement>(
      '[role="menuitemradio"][aria-checked="true"], [role="menuitemcheckbox"][aria-checked="true"], [role="menuitem"][aria-current="true"]',
    );
    if (selected && selected.getClientRects().length > 0) {
      selected.focus({ preventScroll: true });
    } else {
      focusItem(0);
    }
  };

  const onSurfaceKeyDown = (event: KeyboardEvent) => {
    if (!props.keyboardNavigation) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = focusableItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : current < 0
            ? event.key === 'ArrowUp'
              ? items.length - 1
              : 0
            : current + (event.key === 'ArrowDown' ? 1 : -1);
    focusItem(next);
  };

  const onDocumentPointerDown = (event: PointerEvent) => {
    if (!props.open) return;
    const target = event.target as Node;
    if (!(props.dismissRoot?.() ?? props.anchor())?.contains(target) && !surface?.contains(target)) {
      props.onClose();
    }
  };

  const closeAndFocus = () => {
    const focusTarget = props.focusTarget?.() ?? props.anchor();
    props.onClose();
    focusTarget?.focus({ preventScroll: true });
  };

  const onDocumentKeyDown = (event: KeyboardEvent) => {
    if (!props.open || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeAndFocus();
  };

  const positionNewSurface = () => {
    setPosition((current) => ({ ...current, ready: false }));
    queueMicrotask(() => {
      if (!props.open) return;
      // Reveal only after the portaled content has completed a layout pass.
      reposition(false);
      focusFrame = requestAnimationFrame(() => {
        if (reposition() && props.autoFocus) focusInitialItem();
      });
    });
  };

  createEffect(() => {
    if (!props.open) {
      setPosition((current) => ({ ...current, ready: false }));
      return;
    }
    document.addEventListener('pointerdown', onDocumentPointerDown);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    onCleanup(() => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('keydown', onDocumentKeyDown, true);
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    });
  });

  return (
    <Show when={props.open}>
      <Portal>
        <div
          ref={(element) => {
            surface = element;
            registerUiBack(element, closeAndFocus);
            props.ref?.(element);
            positionNewSurface();
          }}
          id={props.id}
          class={`popover-surface popover-menu overflow-x-hidden overflow-y-auto fixed z-300 overscroll-contain [&_button:hover:not(:disabled)]:bg-hover [&_button.active]:bg-hover [&_button.highlighted:not([aria-selected=true])]:bg-hover [&_button[aria-selected=true]]:bg-raised [&_button[aria-checked=true]]:bg-raised ${
            position().up ? 'dropdown-up' : 'dropdown-down'
          } ${props.class ?? ''}`}
          role={props.role}
          aria-label={props.ariaLabel}
          onKeyDown={onSurfaceKeyDown}
          style={{
            left: `${position().left}px`,
            top: `${position().top}px`,
            width: `${position().width}px`,
            'max-height': `${position().maxHeight}px`,
            visibility: position().ready ? 'visible' : 'hidden',
          }}
        >
          {props.children}
        </div>
      </Portal>
    </Show>
  );
}
