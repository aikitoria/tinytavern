import { Show } from 'solid-js';
import { pendingConfirmation, settleConfirmation } from '../state/confirm.ts';
import Modal from './Modal.tsx';

export default function ConfirmDialogHost() {
  return (
    <Show when={pendingConfirmation()}>
      {(request) => (
        <Modal
          title={request().title}
          class="confirm-modal"
          backdropClass="confirm-backdrop"
          onClose={() => settleConfirmation(false)}
        >
          <p class="confirm-message">{request().message}</p>
          <div class="form-actions confirm-actions">
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
