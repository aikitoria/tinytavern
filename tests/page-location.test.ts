import assert from 'node:assert/strict';

const modulePath = '../client/src/state/pageLocation.ts';
const { parsePageLocation, formatPageLocation } = await import(modulePath);
for (const hash of [
  '#70',
  '#/gallery',
  '#70/gallery/123',
  '#70/gallery/123?q=night&character=uploads&sort=oldest',
  '#70/settings/media-rendering',
  '#70/settings/characters/12?detail=1',
  '#70/settings/templates/new?detail=1',
  '#70/conversation',
  '#70/map',
  '#70/trace',
  '#70/gallery/123?view=map',
  '#70/media/video/job-123?context=70&return=%2370%2Fgallery%2F123&jobs=1',
]) {
  assert.equal(formatPageLocation(parsePageLocation(hash)), hash, `Round trip ${hash}`);
}
const media = parsePageLocation('#70/media/video/job-123?return=%2370%2Fgallery%2F123');
assert.equal(media.chatId, 70);
assert.equal(
  media.media.contextConversationId,
  null,
  'The background chat is separate from generation context',
);
assert.equal(media.media.returnModal, 'gallery');
assert.equal(media.media.returnHash, '#70/gallery/123');
assert.equal(
  parsePageLocation('#/gallery').chatId,
  null,
  'An explicit gallery URL can have no background chat',
);
console.log(
  'Page URLs preserve background chats, gallery items/filters, settings entities and media jobs',
);

// Browser traversals are asynchronous. Model the history cursor separately from
// the rendered page so Cancel must restore the actual entry, not just its URL.
const entries = [{ hash: '#70', state: null as Record<string, unknown> | null }];
let cursor = 0;
const traversals: (() => void)[] = [];
const browser = new EventTarget();
const location = { hash: '#70' };
const history = {
  get state() {
    return entries[cursor]!.state;
  },
  replaceState(state: Record<string, unknown>, _title: string, hash = location.hash) {
    entries[cursor] = { hash, state };
    location.hash = hash;
  },
  pushState(state: Record<string, unknown>, _title: string, hash: string) {
    entries.splice(cursor + 1);
    entries.push({ hash, state });
    cursor++;
    location.hash = hash;
  },
  go(delta: number) {
    const target = cursor + delta;
    if (target < 0 || target >= entries.length) return;
    traversals.push(() => {
      cursor = target;
      location.hash = entries[cursor]!.hash;
      const event = new Event('popstate');
      Object.defineProperty(event, 'state', { value: entries[cursor]!.state });
      browser.dispatchEvent(event);
    });
  },
};
Object.defineProperty(globalThis, 'window', { value: browser });
Object.defineProperty(globalThis, 'location', { value: location });
Object.defineProperty(globalThis, 'history', { value: history });
const { installPageNavigation, writePageLocation, applyPageLocation, guardPageNavigation } =
  await import(modulePath);
let rendered = '#70';
installPageNavigation((page: unknown) => {
  applyPageLocation(page, () => {
    rendered = formatPageLocation(page);
  });
});
function settle() {
  let steps = 0;
  while (traversals.length) {
    assert(++steps < 20, 'History traversal must settle');
    traversals.shift()!();
  }
}
function open(hash: string) {
  writePageLocation(parsePageLocation(hash), true);
  rendered = hash;
}
open('#70/gallery');
open('#70/settings/general');
const initialEntries = entries.map((entry) => entry.hash);
let approve: (() => void) | undefined;
let guards = 0;
const unguard = guardPageNavigation((action: () => void) => {
  guards++;
  approve = action;
});
history.go(-1);
settle();
assert.equal(guards, 1);
assert.equal(cursor, 2, 'The guard opens at the original history entry');
assert.equal(location.hash, '#70/settings/general');
assert.equal(rendered, '#70/settings/general');
assert.deepEqual(
  entries.map((entry) => entry.hash),
  initialEntries,
);
approve = undefined; // Cancel: the navigation action is deliberately not called.
history.go(-1);
settle();
assert.equal(guards, 2, 'Back after Cancel still targets the same preceding page');
approve!();
settle();
assert.equal(cursor, 1);
assert.equal(rendered, '#70/gallery');
assert.deepEqual(
  entries.map((entry) => entry.hash),
  initialEntries,
);

history.go(1);
settle();
assert.equal(cursor, 1, 'Forward also restores the origin before asking');
approve!();
settle();
assert.equal(cursor, 2);
assert.equal(rendered, '#70/settings/general');

history.go(-2);
settle();
approve!();
settle();
assert.equal(cursor, 0, 'Multi-entry traversals preserve their original distance');
assert.equal(rendered, '#70');
assert.deepEqual(
  entries.map((entry) => entry.hash),
  initialEntries,
);
unguard();
history.go(1);
settle();
assert.equal(cursor, 1);
assert.equal(rendered, '#70/gallery');
assert.equal(guards, 4, 'Unguarded navigation proceeds without another confirmation');
console.log(
  'Guarded Back/Forward preserves the history cursor and entries on Cancel and approval.',
);
