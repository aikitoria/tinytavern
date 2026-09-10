import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('system Back uses UI actions before page history, including direct links and dirty editors', async () => {
  const initialHash = '#70+/gallery+/media/job/1';
  const entries = [
    { hash: 'outside', state: null as Record<string, unknown> | null },
    { hash: initialHash, state: null as Record<string, unknown> | null },
  ];
  let cursor = 1;
  const pending: (() => void)[] = [];
  let browser = new EventTarget();
  const location = { hash: initialHash };
  const history = {
    get state() {
      return entries[cursor]!.state;
    },
    replaceState(state: Record<string, unknown>, _title: string, hash = location.hash) {
      entries[cursor] = { state, hash };
      location.hash = hash;
    },
    pushState(state: Record<string, unknown>, _title: string, hash: string) {
      entries.splice(cursor + 1, Infinity, { state, hash });
      cursor++;
      location.hash = hash;
    },
    go(delta: number) {
      const target = cursor + delta;
      if (target < 0 || target >= entries.length) return;
      pending.push(() => {
        cursor = target;
        location.hash = entries[cursor]!.hash;
        if (location.hash === 'outside') return;
        const event = new Event('popstate');
        Object.defineProperty(event, 'state', { value: history.state });
        browser.dispatchEvent(event);
      });
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, get: () => browser });
  Object.defineProperty(globalThis, 'location', { value: location });
  Object.defineProperty(globalThis, 'history', { value: history });
  const modulePath = '../../client/src/state/pageLocation.ts';
  const {
    applyPageLocation,
    formatPageLocation,
    installPageNavigation,
    parsePageLocation,
    returnToPageLocation,
    writePageLocation,
  } = await import(modulePath);
  const actions: (() => void)[] = [];
  let rendered = initialHash;
  const apply = (page: unknown) => {
    applyPageLocation(page, () => {
      rendered = formatPageLocation(page);
    });
  };
  const install = () => installPageNavigation(apply, () => actions.at(-1));
  const settle = () => {
    let steps = 0;
    while (pending.length) {
      assert(++steps < 20, 'Back must settle without a traversal loop');
      pending.shift()!();
    }
  };
  const back = () => {
    history.go(-1);
    settle();
  };
  const at = (hash: string) => {
    assert.equal(location.hash, hash);
    assert.equal(rendered, hash);
  };
  install();
  assert.equal(cursor, 2, 'A direct link has a same-document Back boundary');
  const size = entries.length;
  browser = new EventTarget();
  install();
  assert.equal(entries.length, size, 'Reload does not add another boundary');

  let approve: (() => void) | undefined;
  const closeEditor = () => {
    approve = () => {
      actions.pop();
      const parent = parsePageLocation('#70+/gallery');
      returnToPageLocation(parent, () => apply(parent));
    };
    actions.push(() => {
      actions.pop();
      approve = undefined;
    });
  };
  actions.push(closeEditor);
  for (const name of ['picker', 'dropdown']) {
    actions.push(() => {
      assert.equal(cursor, 2, `${name} closes after restoring the original entry`);
      actions.pop();
    });
  }
  back();
  assert.equal(actions.length, 2, 'Back closes only the dropdown');
  at(initialHash);
  back();
  assert.equal(actions.length, 1, 'The next Back closes the picker');
  back();
  assert(approve, 'Editor Back opens its leave guard');
  at(initialHash);
  back();
  assert.equal(approve, undefined, 'Back cancels the confirmation and preserves the editor');
  assert.equal(actions.length, 1);
  at(initialHash);
  back();
  actions.pop(); // Click Discard in the confirmation.
  (approve as unknown as () => void)();
  settle();
  at('#70+/gallery');
  assert.equal(entries.length, size, 'Closing local UI does not accumulate history entries');

  writePageLocation(parsePageLocation(initialHash), true);
  rendered = initialHash;
  actions.push(() => {
    actions.pop();
    returnToPageLocation(parsePageLocation('#70+/gallery'), () => assert.fail('Parent exists'));
  });
  back();
  at('#70+/gallery');
  history.go(1);
  settle();
  at(initialHash);
  assert.equal(actions.length, 0, 'Forward restores the page without invoking UI Back');
  back();
  at('#70+/gallery');

  // A rapid second Back before restoration must still close just one surface.
  let closes = 0;
  actions.push(() => {
    closes++;
    actions.pop();
  });
  history.go(-1);
  history.go(-1);
  settle();
  assert.equal(closes, 1);
  at('#70+/gallery');

  // An action removed while traversal is pending must never close a different pane.
  actions.push(() => assert.fail('Stale Back action'));
  history.go(-1);
  pending.shift()!();
  actions.pop();
  settle();
  at('#70+/gallery');

  apply(parsePageLocation('#70'));
  back();
  assert.equal(cursor, 0, 'With no open UI, Back passes the boundary and leaves the app');
  history.go(1);
  settle();
  assert.equal(cursor, 2, 'Forward skips the boundary when returning to the app');
  at('#70');
});
