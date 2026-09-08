import assert from 'node:assert/strict';
import { createStreamScroll } from '../client/src/streamScroll.ts';

let top = 0;
const area = {
  isConnected: true,
  clientHeight: 100,
  scrollHeight: 400,
  get scrollTop() {
    return top;
  },
  set scrollTop(value: number) {
    top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
  },
};
let element: typeof area | undefined;
const frames = new Map<number, () => void>();
let sequence = 0;
const scroll = createStreamScroll(
  () => element,
  (callback) => {
    frames.set(++sequence, callback);
    return sequence;
  },
  (frame) => {
    frames.delete(frame);
  },
);
function paint() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback();
}
scroll.update(null, true);
assert.equal(frames.size, 0, 'Normal prompt edits do not trigger scrolling');
scroll.update('job-a', false); // Reasoning is displayed; the textarea does not exist yet.
scroll.update('job-a', true);
element = area; // Solid mounts the prompt textarea before the animation frame.
scroll.update('job-a', true);
scroll.update('job-a', true);
assert.equal(frames.size, 1, 'Token updates coalesce into one layout read/write per frame');
paint();
assert.equal(top, 300);
scroll.onScroll();
area.scrollHeight = 600;
scroll.update('job-a', true);
paint();
assert.equal(top, 500, 'Actual prompt text follows each streamed chunk');
scroll.update('job-a', true);
area.scrollTop = 200;
scroll.onScroll();
paint();
assert.equal(top, 200, 'Scrolling up cancels a queued jump to the bottom');
area.scrollHeight = 800;
scroll.update('job-a', true);
assert.equal(frames.size, 0, 'Manual reading remains undisturbed as tokens arrive');
area.scrollTop = 700;
scroll.onScroll();
area.scrollHeight = 900;
scroll.update('job-a', true);
paint();
assert.equal(top, 800, 'Scrolling back to the bottom resumes following');
area.scrollHeight = 1000;
scroll.update(null, true);
scroll.update(null, true);
paint();
assert.equal(top, 900, 'The final completion snapshot is followed too');
area.scrollTop = 100;
scroll.onScroll();
scroll.update(null, true);
assert.equal(frames.size, 0, 'Completed prompt editing retains the cursor position');
scroll.update('job-b', true);
paint();
assert.equal(top, 900, 'A new generation starts following again');
scroll.update('job-b', true);
scroll.update('job-b', false);
assert.equal(frames.size, 0, 'Covered panes and pickers cancel pending scrolling');
area.scrollHeight = 1100;
scroll.update('job-b', true);
paint();
assert.equal(top, 1000, 'An uncovered pane catches up with the stream');
scroll.update('job-b', true);
scroll.dispose();
assert.equal(frames.size, 0, 'Unmount releases pending animation callbacks');
console.log(
  'Prompt streaming follows text, respects manual scrolling, coalesces updates and pauses when hidden.',
);
