import { Show, createSignal } from 'solid-js';
import { api } from '../state/api.ts';
import { confirmAction } from '../state/confirm.ts';
import { clearMessageSelection, selectedMessageRange } from '../state/messageSelection.ts';
import { navigateTree, state } from '../state/store.ts';
import Modal from './Modal.tsx';

export default function MessageSelectionBar() {
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
    await navigateTree(() =>
      api.moveMessageRange(
        selected.messageIds,
        direction,
        1,
        state.tree.activeLeafId,
        state.tree.mutationRevision,
      ),
    );
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
        state.tree.activeLeafId,
        state.tree.mutationRevision,
      ),
    );
    if (ok) {
      setMoveOpen(false);
    }
  };

  const deleteRange = async () => {
    const selected = range();
    if (!selected) return;
    const count = selected.messages.length;
    if (
      !(await confirmAction({
        title: `Delete ${count === 1 ? 'message' : `${count} messages`}?`,
        message:
          'This removes the selected range and every swipe alternative in those message blocks. The conversation after the range will be kept.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    ) {
      return;
    }
    const ok = await navigateTree(() =>
      api.deleteMessageRange(
        selected.messageIds,
        state.tree.activeLeafId,
        state.tree.mutationRevision,
      ),
    );
    if (ok) clearMessageSelection();
  };

  return (
    <>
      <div class="composer message-selection-bar" role="toolbar" aria-label="Selected messages">
        <span class="message-selection-summary">{countLabel()}</span>
        <button
          type="button"
          class="icon-btn"
          title="Move selected range up"
          aria-label="Move selected range up"
          disabled={(range()?.start ?? 0) <= 0 || state.treeNavigationPending}
          onClick={() => void moveRangeOneStep('up')}
        >
          ↑
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
          ↓
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
          onClick={() => void deleteRange()}
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
          ✕
        </button>
      </div>

      <Show when={moveOpen() && range()}>
        <Modal
          title={`Move ${range()!.messages.length} selected ${range()!.messages.length === 1 ? 'message' : 'messages'}`}
          class="message-move-modal"
          onClose={() => setMoveOpen(false)}
        >
          <div class="form message-move-form">
            <label for="message-range-position">Starting position</label>
            <div class="message-position-row">
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
            <div class="form-actions">
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
