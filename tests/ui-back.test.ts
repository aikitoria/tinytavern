import assert from 'node:assert/strict';

class Surface {
  dataset: Record<string, string> = {};
  hidden = false;
  visibility = 'visible';
  closest() {
    return this.hidden ? this : null;
  }
  getClientRects() {
    return this.hidden ? [] : [{}];
  }
}

let surfaces: Surface[] = [];
const target = new EventTarget();
Object.defineProperty(globalThis, 'window', { value: target });
Object.defineProperty(globalThis, 'document', {
  value: { querySelectorAll: () => surfaces.filter((surface) => 'uiBack' in surface.dataset) },
});
Object.defineProperty(globalThis, 'getComputedStyle', { value: (surface: Surface) => surface });

const modulePath = '../client/src/state/uiBack.ts';
const { registerUiBack, installMouseBack } = await import(modulePath);
const stop = installMouseBack();
const actions: string[] = [];
function layer(name: string) {
  const surface = new Surface();
  surfaces.push(surface);
  registerUiBack(surface, () => {
    actions.push(name);
    surfaces = surfaces.filter((item) => item !== surface);
  });
  return surface;
}
function mouse(type: string, button = 3) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'button', { value: button });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}
function back(expected: boolean, pointer = true, auxiliary = true) {
  const events = pointer
    ? ['pointerdown', 'mousedown', 'pointerup', 'mouseup']
    : ['mousedown', 'mouseup'];
  if (auxiliary) events.push('auxclick');
  for (const event of events) assert.equal(mouse(event), expected, event);
}

layer('gallery');
layer('detail');
layer('menu');
back(true);
assert.deepEqual(actions, ['menu'], 'One press closes only the topmost surface');
back(true);
assert.deepEqual(actions, ['menu', 'detail']);
back(true);
assert.deepEqual(actions, ['menu', 'detail', 'gallery']);
back(false);
assert.equal(actions.length, 3, 'Browser Back is untouched once no UI can close');

layer('page');
const hidden = layer('hidden editor back button');
hidden.hidden = true;
back(true);
assert.equal(actions.at(-1), 'page', 'Hidden UI cannot intercept Back');
back(false);
surfaces = [];

layer('settings');
const settings = surfaces[0]!;
registerUiBack(settings, () => {
  actions.push('save guard');
  layer('cancel save guard');
});
back(true);
assert.equal(actions.at(-1), 'save guard', 'Guard opened during release survives auxclick');
back(true);
assert.equal(actions.at(-1), 'cancel save guard');
assert(surfaces.includes(settings), 'Cancelling leaves the editor open');
surfaces = [];

back(false, false);
layer('mouse-only menu');
back(true, false, false);
layer('next mouse-only menu');
back(true, false);
assert.equal(
  actions.at(-1),
  'next mouse-only menu',
  'Missing auxclick does not retain old actions',
);

layer('pointer-only menu');
assert(mouse('pointerdown'));
assert(mouse('pointerup'));
assert(mouse('auxclick'));
assert.equal(
  actions.at(-1),
  'pointer-only menu',
  'Cancelled pointerdown can suppress mouse events',
);

layer('unchanged');
for (const button of [0, 1, 2, 4]) {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick']) {
    assert.equal(mouse(type, button), false, 'Other buttons retain their normal behavior');
  }
}
stop();
back(false);
assert.equal(surfaces.length, 1, 'Unmount removes the listeners');
console.log('Mouse Back closes one visible UI layer per press and preserves browser navigation.');
