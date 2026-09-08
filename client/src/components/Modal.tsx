import { faXmark } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import { createUniqueId, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { openModal } from '../state/store.ts';
import { registerUiBack } from '../state/uiBack.ts';
import '../styles/pages.css';

export default function Modal(props: {
  title: string;
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
  let previouslyFocused: HTMLElement | null = null;
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
    return dialogs[dialogs.length - 1] === dialog;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isTopDialog()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
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
    queueMicrotask(() => {
      const preferred =
        dialog.querySelector<HTMLElement>('[data-modal-initial-focus]') ??
        dialog.querySelector<HTMLElement>(
          '.modal-body button, .modal-body [href], .modal-body input, .modal-body select, .modal-body textarea, .modal-body [tabindex]',
        );
      (preferred ?? focusable()[0] ?? dialog).focus({ preventScroll: true });
    });
  });
  onCleanup(() => {
    document.removeEventListener('keydown', onKeyDown, true);
    previouslyFocused?.focus({ preventScroll: true });
  });

  return (
    <Portal>
      {/* No close-on-backdrop-click: modals hold unsaved form state. */}
      <div
        class={`modal-backdrop ${props.fullscreen ? 'fullscreen-backdrop' : ''} ${props.backdropClass ?? ''}`}
      >
        <div
          ref={dialog}
          class={`modal ${props.fullscreen ? 'fullscreen-page' : ''} ${props.class ?? ''}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          <div class="modal-head">
            <span class="modal-title" id={titleId}>
              {props.title}
            </span>
            {props.headerExtra}
            <Show when={!props.hideCloseButton}>
              <button class="icon-btn" title="Close" aria-label="Close" onClick={close}>
                <FontAwesomeIcon icon={faXmark} size={14} />
              </button>
            </Show>
          </div>
          <div class="modal-body">{props.children}</div>
        </div>
      </div>
    </Portal>
  );
}
