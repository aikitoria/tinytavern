import assert from 'node:assert/strict';
import { prepareTextareaResize } from '../client/src/textareaResize.ts';

const area = {
  getBoundingClientRect: () => ({ right: 500, bottom: 800, height: 437.5 }),
  style: { height: '', flex: '' },
};
const event = { button: 0, clientX: 496, clientY: 796, currentTarget: area };
prepareTextareaResize({ ...event, button: 2 });
prepareTextareaResize({ ...event, clientY: 500 });
prepareTextareaResize({ ...event, clientX: 300 });
prepareTextareaResize({ ...event, clientY: 801 });
assert.deepEqual(
  area.style,
  { height: '', flex: '' },
  'Editing and scrolling retain automatic height',
);
prepareTextareaResize(event);
assert.deepEqual(
  area.style,
  { height: '437.5px', flex: '0 0 auto' },
  'Grabbing the native grip preserves the displayed height and releases flex growth',
);
console.log(
  'Prompt resize grips retain their initial size and hand sizing to the native textarea.',
);
