import { Show } from 'solid-js';
import { pendingConfirmation, settleConfirmation } from '../../state/confirm.ts';
import Modal from './Modal.tsx';

export default function ConfirmDialogHost() {
  return (
    <Show when={pendingConfirmation()}>
      {(request) => (
        <Modal
          title={request().title}
          class="confirm-modal [&.confirm-modal]:h-auto [&.confirm-modal]:w-full [&.confirm-modal]:max-w-107.5 [&.confirm-modal]:max-h-[min(80dvh,_520px)] [&_.modal-body]:p-5 small-touch:[&.confirm-modal]:border small-touch:[&.confirm-modal]:border-solid small-touch:[&.confirm-modal]:border-line small-touch:[&.confirm-modal]:rounded-lg small-touch:[&.confirm-modal]:pt-0"
          backdropClass="confirm-backdrop z-400 small-touch:[&.confirm-backdrop]:p-4"
          onClose={() => settleConfirmation(false)}
        >
          <p class="m-0 text-dim">{request().message}</p>
          <div class="form-actions flex items-center gap-2 flex-wrap mt-4 mt-5">
            <button
              class={request().danger ? 'danger-primary-btn' : 'primary-btn'}
              onClick={() => settleConfirmation(true)}
            >
              {request().confirmLabel ?? 'Confirm'}
            </button>
            <button data-modal-initial-focus onClick={() => settleConfirmation(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </Show>
  );
}
