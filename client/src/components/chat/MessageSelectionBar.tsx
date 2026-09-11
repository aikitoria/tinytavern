import { useConversationView } from './ConversationContext.tsx';
import { faArrowDown, faArrowUp, faXmark } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import { Show, createSignal } from 'solid-js';
import { api } from '../../state/api.ts';
import { confirmDelete } from '../../state/confirm.ts';

import Modal from '../ui/Modal.tsx';

export default function MessageSelectionBar() {
  const view = useConversationView();
  const { state, navigateTree, clearMessageSelection, selectedMessageRange } = view.session;

  const [moveOpen, setMoveOpen] = createSignal(false);
  const [targetPosition, setTargetPosition] = createSignal(1);
  const range = selectedMessageRange;
  const countLabel = () => {
    const count = range()?.messages.length ?? 0;
    return `${count} ${count === 1 ? 'message' : 'messages'} selected`;
  };
  const maxPosition = () => {
    const selected = range();
    return selected ? selected.pathLength - selected.messages.length + 1 : 1;
  };
  const targetIsValid = () =>
    Number.isSafeInteger(targetPosition()) &&
    targetPosition() >= 1 &&
    targetPosition() <= maxPosition();

  const openMove = () => {
    const selected = range();
    if (!selected || maxPosition() <= 1) return;
    setTargetPosition(selected.start + 1);
    setMoveOpen(true);
  };

  const moveRangeOneStep = async (direction: 'up' | 'down') => {
    const selected = range();
    if (!selected) return;
    const canMove =
      direction === 'up' ? selected.start > 0 : selected.end < selected.pathLength - 1;
    if (!canMove) return;
    await navigateTree(() => api.moveMessageRange(selected.messageIds, direction, 1, state.tree));
  };

  const moveRange = async () => {
    const selected = range();
    if (!selected || !targetIsValid()) return;
    const target = targetPosition() - 1;
    const steps = Math.abs(target - selected.start);
    if (steps === 0) {
      setMoveOpen(false);
      return;
    }
    const ok = await navigateTree(() =>
      api.moveMessageRange(
        selected.messageIds,
        target < selected.start ? 'up' : 'down',
        steps,
        state.tree,
      ),
    );
    if (ok) {
      setMoveOpen(false);
    }
  };

  const deleteRange = async (event: MouseEvent) => {
    const selected = range();
    if (!selected) return;
    const count = selected.messages.length;
    if (
      !(await confirmDelete(
        {
          title: `Delete ${count === 1 ? 'message' : `${count} messages`}?`,
          message:
            'This removes the selected range and every swipe alternative in those message blocks. The conversation after the range will be kept.',
          confirmLabel: 'Delete',
          danger: true,
        },
        event,
      ))
    ) {
      return;
    }
    const ok = await navigateTree(() => api.deleteMessageRange(selected.messageIds, state.tree));
    if (ok) clearMessageSelection();
  };

  return (
    <>
      <div
        class="composer my-3 mx-auto p-1 flex relative bg-panel message-selection-bar items-center rounded-md items-end border border-solid border-control-line gap-chat-gap max-w-composer [&_textarea]:shadow-clear [&_textarea]:flex-1 [&_textarea]:w-auto [&_textarea]:min-w-0 [&_textarea]:max-h-50 [&_textarea]:resize-none [&_textarea]:overflow-y-hidden [&_textarea]:bg-clear [&_textarea]:border-clear [&_textarea]:leading-6 [&_input[type=search]]:shadow-clear [&_input[type=search]]:flex-1 [&_input[type=search]]:w-auto [&_input[type=search]]:min-w-0 [&_input[type=search]]:max-h-50 [&_input[type=search]]:resize-none [&_input[type=search]]:overflow-y-hidden [&_input[type=search]]:bg-clear [&_input[type=search]]:border-clear [&_input[type=search]]:leading-6 [&_textarea:focus]:outline-clear [&_input[type=search]:focus]:outline-clear [&>button:not(.icon-btn)]:min-h-chat-rail small-touch:w-auto small-touch:max-w-none small-touch:shrink-0 small-touch:m-0 small-touch:bg-panel small-touch:border-clear small-touch:rounded-none small-touch:[&_textarea]:bg-raised small-touch:[&_input[type=search]]:bg-raised w-[calc(100%_-_var(--space-6)_-_var(--space-6))] rounded-[calc(var(--composer-button-size)_/_2_+_var(--composer-shell-inset))] [&_textarea]:rounded-[calc(var(--composer-button-size)_/_2)] [&_input[type=search]]:rounded-[calc(var(--composer-button-size)_/_2)] small-touch:p-[4px_calc(4px_+_env(safe-area-inset-right))_calc(4px_+_env(safe-area-inset-bottom))_calc(4px_+_env(safe-area-inset-left))]"
        role="toolbar"
        aria-label="Selected messages"
      >
        <span class="py-0 px-3 text-foreground truncate flex-1 min-w-0 text-label font-semibold">
          {countLabel()}
        </span>
        <button
          type="button"
          class="icon-btn"
          title="Move selected range up"
          aria-label="Move selected range up"
          disabled={(range()?.start ?? 0) <= 0 || state.treeNavigationPending}
          onClick={() => void moveRangeOneStep('up')}
        >
          <FontAwesomeIcon icon={faArrowUp} size={14} />
        </button>
        <button
          type="button"
          class="icon-btn"
          title="Move selected range down"
          aria-label="Move selected range down"
          disabled={
            (range()?.end ?? 0) >= (range()?.pathLength ?? 1) - 1 || state.treeNavigationPending
          }
          onClick={() => void moveRangeOneStep('down')}
        >
          <FontAwesomeIcon icon={faArrowDown} size={14} />
        </button>
        <button
          type="button"
          disabled={maxPosition() <= 1 || state.treeNavigationPending}
          onClick={openMove}
        >
          Move
        </button>
        <button
          type="button"
          class="danger-btn"
          disabled={state.treeNavigationPending}
          onClick={(event) => void deleteRange(event)}
        >
          Delete
        </button>
        <button
          type="button"
          class="icon-btn"
          title="Cancel selection"
          aria-label="Cancel message selection"
          onClick={clearMessageSelection}
        >
          <FontAwesomeIcon icon={faXmark} size={14} />
        </button>
      </div>

      <Show when={moveOpen() && range()}>
        <Modal
          title={`Move ${range()!.messages.length} selected ${range()!.messages.length === 1 ? 'message' : 'messages'}`}
          class="h-auto w-full max-w-115 max-h-[min(80dvh,_520px)]"
          onClose={() => setMoveOpen(false)}
        >
          <div class="form message-move-form [&_label]:text-label [&_label]:text-foreground [&_label]:mt-2">
            <label for="message-range-position">Starting position</label>
            <div class="items-center grid gap-2 [&_input]:w-full [&_input]:min-w-0 [&>span]:text-dim [&>span]:text-sm [&>span]:whitespace-nowrap grid-cols-[auto_minmax(70px,_1fr)_auto_auto]">
              <button type="button" onClick={() => setTargetPosition(1)}>
                Top
              </button>
              <input
                id="message-range-position"
                data-modal-initial-focus
                type="number"
                min="1"
                max={maxPosition()}
                value={targetPosition()}
                onInput={(event) => setTargetPosition(Number(event.currentTarget.value))}
              />
              <span>of {maxPosition()}</span>
              <button type="button" onClick={() => setTargetPosition(maxPosition())}>
                Bottom
              </button>
            </div>
            <p class="hint">
              The selected messages move as one piece. Their swipe alternatives and generated images
              stay attached.
            </p>
            <div class="form-actions flex items-center gap-2 flex-wrap mt-4">
              <button
                type="button"
                class="primary-btn"
                disabled={!targetIsValid() || targetPosition() === range()!.start + 1}
                onClick={() => void moveRange()}
              >
                Move
              </button>
              <button type="button" onClick={() => setMoveOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      </Show>
    </>
  );
}
