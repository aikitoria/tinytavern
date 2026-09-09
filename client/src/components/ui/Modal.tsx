import { useDialogActive } from '../../state/dialogContext.ts';
import { dialogLayers } from '../../state/dialogLayers.ts';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import { createEffect, createUniqueId, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { openModal } from '../../state/store.ts';
import { registerUiBack } from '../../state/uiBack.ts';

export default function Modal(props: {
  title: string;
  active?: boolean;
  class?: string;
  backdropClass?: string;
  headerExtra?: JSX.Element;
  hideCloseButton?: boolean;
  fullscreen?: boolean;
  children: JSX.Element;
  onClose?: () => void;
}) {
  const titleId = `modal-title-${createUniqueId()}`;
  let dialog!: HTMLDivElement;
  const paneActive = useDialogActive();
  const enabled = () => props.active ?? paneActive();
  const layer = dialogLayers.register(enabled);
  let lastFocused: HTMLElement | null = null;
  let previouslyFocused: HTMLElement | null = null;
  onCleanup(layer.dispose);
  const close = () => (props.onClose ?? (() => openModal(null)))();
  const focusable = () =>
    [
      ...dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]',
      ),
    ].filter(
      (element) =>
        !element.hasAttribute('disabled') &&
        element.tabIndex >= 0 &&
        !element.closest('.hidden, [hidden]') &&
        element.getClientRects().length > 0,
    );
  const isTopDialog = () => {
    const dialogs = [
      ...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
    ];
    return (
      layer.isTop() && dialogs.filter((element) => !element.closest('[hidden]')).at(-1) === dialog
    );
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isTopDialog()) return;
    if (event.key !== 'Tab') return;
    const items = focusable();
    if (items.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  onMount(() => {
    registerUiBack(dialog, close);
    previouslyFocused = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', onKeyDown, true);
  });
  createEffect(() => {
    if (!layer.isTop() || !enabled()) {
      if (dialog?.contains(document.activeElement))
        lastFocused = document.activeElement as HTMLElement;
      return;
    }
    queueMicrotask(() => {
      if (!dialog?.isConnected || !layer.isTop() || !enabled()) return;
      const preferred = lastFocused?.isConnected
        ? lastFocused
        : (dialog.querySelector<HTMLElement>('[data-modal-initial-focus]') ??
          dialog.querySelector<HTMLElement>(
            '.modal-body button, .modal-body [href], .modal-body input, .modal-body select, .modal-body textarea, .modal-body [tabindex]',
          ));
      (preferred ?? focusable()[0] ?? dialog).focus({ preventScroll: true });
    });
  });
  onCleanup(() => {
    document.removeEventListener('keydown', onKeyDown, true);
    queueMicrotask(() => {
      if (previouslyFocused?.isConnected && !previouslyFocused.closest('[hidden], [inert]'))
        previouslyFocused.focus({ preventScroll: true });
    });
  });

  return (
    <Portal>
      {/* No close-on-backdrop-click: modals hold unsaved form state. */}
      <div
        hidden={!enabled()}
        inert={!enabled() || !layer.isTop()}
        aria-hidden={!enabled() || !layer.isTop()}
        class={`modal-backdrop fixed inset-0 z-100 [:where(&:not(.fullscreen-backdrop))]:flex [:where(&:not(.fullscreen-backdrop))]:items-center [:where(&:not(.fullscreen-backdrop))]:justify-center [:where(&:not(.fullscreen-backdrop))]:p-5 [&[hidden]]:display-none [&.fullscreen-backdrop]:block [&.fullscreen-backdrop]:bg-canvas small-touch:[&:where(:not(.fullscreen-backdrop))]:p-0 ${props.fullscreen ? 'fullscreen-backdrop' : ''} ${props.backdropClass ?? ''}`}
      >
        <div
          ref={dialog}
          class={`modal flex flex-col [:where(&:not(.fullscreen-page))]:bg-panel [:where(&:not(.fullscreen-page))]:rounded-lg [:where(&:not(.fullscreen-page))]:origin-top [&.fullscreen-page]:absolute [&.fullscreen-page]:inset-0 [&.fullscreen-page]:overflow-hidden [&.fullscreen-page]:bg-canvas mobile:[&.fullscreen-page:where(:not(.settings-modal))]:block mobile:[&.fullscreen-page:where(:not(.settings-modal))]:overflow-y-auto [&:has(.avatar-gen)]:h-auto small-touch:[&:where(:not(.fullscreen-page))]:w-full small-touch:[&:where(:not(.fullscreen-page))]:max-h-none small-touch:[&:where(:not(.fullscreen-page))]:border-clear small-touch:[&:where(:not(.fullscreen-page))]:rounded-none [:where(&:not(.fullscreen-page))]:w-full [:where(&:not(.fullscreen-page))]:max-w-215 [:where(&:not(.fullscreen-page))]:h-[min(85dvh,_720px)] small-touch:[&:where(:not(.fullscreen-page))]:h-dvh small-touch:[&:where(:not(.fullscreen-page))]:pt-[env(safe-area-inset-top)] mobile:[&.fullscreen-page]:pt-[env(safe-area-inset-top)] mobile:[&.fullscreen-page:where(:not(.settings-modal))]:pb-[env(safe-area-inset-bottom)] [&:has(.avatar-gen)]:max-h-[min(85dvh,_720px)] ${props.fullscreen ? 'fullscreen-page' : ''} ${props.class ?? ''}`}
          role="dialog"
          aria-modal={enabled() && layer.isTop() ? 'true' : undefined}
          aria-labelledby={titleId}
          tabIndex={-1}
          onFocusIn={(event) => {
            lastFocused = event.target as HTMLElement;
          }}
        >
          <div class="modal-head flex items-center justify-between gap-3 py-3 px-4 border-b border-b-solid border-b-line small-touch:py-1 small-touch:px-3 small-touch:min-h-11.5">
            <span
              class="modal-title font-semibold text-heading leading-tight small-touch:text-mobile-title"
              id={titleId}
            >
              {props.title}
            </span>
            {props.headerExtra}
            <Show when={!props.hideCloseButton}>
              <button class="icon-btn" title="Close" aria-label="Close" onClick={close}>
                <FontAwesomeIcon icon={faXmark} size={14} />
              </button>
            </Show>
          </div>
          <div class="modal-body p-4 overflow-y-auto">{props.children}</div>
        </div>
      </div>
    </Portal>
  );
}
