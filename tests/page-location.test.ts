import assert from 'node:assert/strict';

const modulePath = '../client/src/state/pageLocation.ts';
const { parsePageLocation, formatPageLocation, pageStack } = await import(modulePath);
for (const hash of [
  '#70',
  '#+/gallery',
  '#70+/gallery/123',
  '#70+/gallery/123?q=night&character=uploads&sort=oldest',
  '#70+/settings/media-rendering',
  '#70+/settings/characters/12?detail=1',
  '#70+/settings/templates/new?detail=1',
  '#70+/conversation',
  '#70/map',
  '#70/trace',
  '#70/map+/gallery/123',
  '#70+/gallery/123+/jobs+/media/job/job-123',
  '#71+/media/create-image+/jobs',
  '#71+/gallery/35?sort=newest+/media/create-video?mode=first-frame',
  '#71+/media/job/job-a',
  '#71+/media/edit-image',
  '#71+/media/describe-image',
  '#70+/gallery/123?q=night+sky%2B%2F&sort=oldest+/jobs',
  '#70+/conversation+/settings/characters/12?detail=1',
]) {
  assert.equal(formatPageLocation(parsePageLocation(hash)), hash, `Round trip ${hash}`);
}
assert.equal(
  formatPageLocation(parsePageLocation('#71+/gallery/35?sort=newest+/media/video-first')),
  '#71+/gallery/35?sort=newest+/media/create-video?mode=first-frame',
);
for (const old of [
  '#71+/gallery/35?sort=newest+/media/create-video/e886b56a-cd06-490f-9c22-5dcecbf75623?mode=first-frame',
  '#71+/gallery/35?sort=newest+/media/create-video/e886b56a-cd06-490f-9c22-5dcecbf75623?mode=references&context=71',
]) {
  assert.equal(
    formatPageLocation(parsePageLocation(old)),
    '#71+/gallery/35?sort=newest+/media/job/e886b56a-cd06-490f-9c22-5dcecbf75623',
  );
}
const media = parsePageLocation('#70/media/video/job-123?return=%2370%2Fgallery%2F123');
assert.equal(media.chatId, 70);
assert.equal(
  media.media.contextConversationId,
  null,
  'The background chat is separate from generation context',
);
assert.equal(pageStack(media)[1].modal, 'gallery');
assert.equal(pageStack(media)[1].galleryId, 123);
assert.equal(formatPageLocation(media), '#70+/gallery/123+/media/job/job-123');
assert.equal(
  parsePageLocation('#+/gallery').chatId,
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
const {
  installPageNavigation,
  writePageLocation,
  applyPageLocation,
  guardPageNavigation,
  returnToPageLocation,
} = await import(modulePath);
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
open('#70+/gallery');
open('#70+/settings/general');
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
assert.equal(location.hash, '#70+/settings/general');
assert.equal(rendered, '#70+/settings/general');
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
assert.equal(rendered, '#70+/gallery');
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
assert.equal(rendered, '#70+/settings/general');

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
assert.equal(rendered, '#70+/gallery');
assert.equal(guards, 4, 'Unguarded navigation proceeds without another confirmation');
console.log(
  'Guarded Back/Forward preserves the history cursor and entries on Cancel and approval.',
);

// Closing a pane uses its actual parent entry, without adding a duplicate Back step.
open('#70+/gallery/123');
open('#70+/gallery/123+/jobs');
const jobsCursor = cursor;
let fallback = false;
returnToPageLocation(parsePageLocation('#70+/gallery/123'), () => {
  fallback = true;
});
settle();
assert.equal(fallback, false);
assert.equal(cursor, jobsCursor - 1);
assert.equal(rendered, '#70+/gallery/123');
history.go(1);
settle();
assert.equal(rendered, '#70+/gallery/123+/jobs', 'Forward reconstructs the child pane');
returnToPageLocation(parsePageLocation('#99'), () => {
  fallback = true;
});
assert.equal(fallback, true, 'A reloaded link can close without an earlier parent history entry');

// Browser jumps guard every removed pane, but never editors retained underneath Jobs.
const draftHash = '#70+/gallery/123+/media/job/draft-a';
const jobsHash = draftHash + '+/jobs';
const otherHash = jobsHash + '+/media/job/draft-b';
open(draftHash);
open(jobsHash);
open(otherHash);
const guardOrder: string[] = [];
const retains = (target: unknown, hash: string) =>
  pageStack(target).some((page: unknown) => formatPageLocation(page) === hash);
const removeDraftGuard = guardPageNavigation(
  (action: () => void) => {
    guardOrder.push('draft-a');
    approve = action;
  },
  (target: unknown) => !retains(target, draftHash),
);
const removeJobGuard = guardPageNavigation(
  (action: () => void) => {
    guardOrder.push('draft-b');
    action();
  },
  (target: unknown) => !retains(target, otherHash),
);
history.go(-1);
settle();
assert.deepEqual(guardOrder, ['draft-b']);
assert.equal(rendered, jobsHash);
removeJobGuard();
history.go(-2);
settle();
assert.deepEqual(guardOrder, ['draft-b', 'draft-a']);
assert.equal(rendered, jobsHash, 'A covered editor can cancel without losing any panes');
approve = undefined;
history.go(-2);
settle();
approve!();
settle();
assert.equal(rendered, '#70+/gallery/123+/jobs');
removeJobGuard();
removeDraftGuard();
console.log('Pane Back/Forward and multi-pane guards preserve the navigation stack.');

const repeated = '#71+/gallery/35?sort=newest+/media/job/job-a+/jobs+/media/job/job-a';
assert.equal(
  formatPageLocation(parsePageLocation(repeated)),
  '#71+/gallery/35?sort=newest+/media/job/job-a',
);
assert.equal(
  formatPageLocation(parsePageLocation(repeated + '+/jobs+/media/job/job-b')),
  '#71+/gallery/35?sort=newest+/media/job/job-a+/jobs+/media/job/job-b',
  'Unwinding repeated job panes keeps subsequent different panes',
);

const { navigatePageWithGuards } = await import(modulePath);
open('#70+/gallery/123+/media/job/job-a');
open('#70+/gallery/123+/media/job/job-a+/jobs');
const targetJob = parsePageLocation('#70+/gallery/123+/media/job/job-a');
let approveChild: (() => void) | undefined;
const unguardRetained = guardPageNavigation(
  () => assert.fail('The retained editor must not be saved or discarded'),
  (target: unknown) => !retains(target, formatPageLocation(targetJob)),
);
const unguardChild = guardPageNavigation((action: () => void) => {
  approveChild = action;
});
let reopened = false;
navigatePageWithGuards(targetJob, () => {
  reopened = true;
  returnToPageLocation(targetJob, () => assert.fail('Reuse the existing history entry'));
});
assert.equal(reopened, false, 'Reopening waits for any removed child editor guard');
assert.equal(rendered, '#70+/gallery/123+/media/job/job-a+/jobs');
approveChild!();
settle();
assert.equal(reopened, true);
assert.equal(rendered, '#70+/gallery/123+/media/job/job-a');
unguardChild();
unguardRetained();
console.log('Reopening an existing job guards removed children and reuses its history entry.');

// Saving a removed child can replace its job ID without cancelling the intended return.
const stackModule = '../client/src/state/dialogStack.ts';
const { dialogStack } = await import(stackModule);
const child = parsePageLocation('#70+/media/job/job-a+/jobs+/media/job/job-b');
open(formatPageLocation(child));
dialogStack.restore(child);
const stopSaveGuard = guardPageNavigation((action: () => void) => {
  writePageLocation({ ...child, media: { ...child.media, jobId: 'saved-variation' } });
  action();
});
let returnedAfterSave = false;
navigatePageWithGuards(parsePageLocation('#70+/media/job/job-a'), () => {
  returnedAfterSave = true;
});
assert(
  returnedAfterSave,
  'Saving a child variation must still finish the return to the existing pane',
);
stopSaveGuard();
dialogStack.restore(parsePageLocation('#70'));
