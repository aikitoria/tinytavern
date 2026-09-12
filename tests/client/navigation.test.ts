import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('page location', async () => {
  const modulePath = '../../client/src/state/pageLocation.ts';
  const { parsePageLocation, formatPageLocation, pageStack } = await import(modulePath);
  for (const hash of [
    '#70',
    '#+/gallery',
    '#70+/gallery/123',
    '#70+/gallery/123?folder=7&q=night&character=uploads&sort=oldest',
    '#70+/gallery?folder=root',
    '#70+/settings/generation-settings',
    '#70+/settings/characters/12?detail=1',
    '#70+/settings/workflows/image-edit?detail=1',
    '#70+/settings/workflows/12?detail=1',
    '#70+/settings/chat-templates/new?detail=1',
    '#70+/conversation',
    '#70/map',
    '#70/trace',
    '#70/map+/gallery/123',
    '#70+/gallery/123+/jobs+/media/job/123',
    '#71+/media/generate+/jobs',
    '#71+/gallery/35?sort=newest+/media/generate?workflow=animate',
    '#71+/media/job/1',
    '#71+/media/job/1?asset=42',
    '#71+/media/job/2?preview=1&asset=42',
    '#71+/media/job/1?asset=42+/jobs+/media/job/2?asset=43',
    '#71+/media/generate?workflow=edit',
    '#71+/gallery?folder=7+/media/generate?workflow=edit&folder=7',
    '#70+/gallery/123?q=night+sky%2B%2F&sort=oldest+/jobs',
    '#70+/conversation+/settings/characters/12?detail=1',
  ]) {
    assert.equal(formatPageLocation(parsePageLocation(hash)), hash, `Round trip ${hash}`);
  }
  for (const [old, current] of [
    ['presets', 'system-prompts'],
    ['media-rendering', 'generation-settings'],
  ] as const) {
    assert.equal(
      formatPageLocation(parsePageLocation(`#70+/settings/${old}/new?detail=1`)),
      `#70+/settings/${current}/new?detail=1`,
    );
  }
  assert.equal(
    formatPageLocation(parsePageLocation('#71+/gallery/35?sort=newest+/media/video-first')),
    '#71+/gallery/35?sort=newest+/media/generate',
  );
  for (const old of [
    '#71+/gallery/35?sort=newest+/media/create-video/8?mode=first-frame',
    '#71+/gallery/35?sort=newest+/media/create-video/8?mode=references&context=71',
  ]) {
    assert.equal(formatPageLocation(parsePageLocation(old)), '#71+/gallery/35?sort=newest+/media/job/8');
  }
  for (const hash of ['#71/jobs', '#71/media/image?jobs=1', '#71/media/video/job-id?jobs=1&context=71']) {
    const page = parsePageLocation(hash);
    assert.equal(page.modal, 'media-jobs');
    assert.equal(page.media, undefined, 'Legacy Jobs links cannot restore a media editor');
    assert.equal(formatPageLocation(page), '#71+/jobs');
  }
  const legacyJobs = '#71/media/image?jobs=1&return=%2371%2Fgallery%2F35';
  assert.equal(
    formatPageLocation(
      parsePageLocation('#70+/gallery/123+/settings/generation-settings+/settings/workflows/example?detail=1'),
    ),
    '#70+/gallery/123+/settings/workflows/example?detail=1',
    'Old nested settings URLs restore only the last requested editor',
  );
  assert.equal(formatPageLocation(parsePageLocation(legacyJobs)), '#71+/gallery/35+/jobs');
  const media = parsePageLocation('#70/media/video/123?return=%2370%2Fgallery%2F123');
  assert.equal(media.chatId, 70);
  assert.equal(media.media.contextConversationId, null, 'The background chat is separate from generation context');
  assert.equal(pageStack(media)[1].modal, 'gallery');
  assert.equal(pageStack(media)[1].galleryId, 123);
  assert.equal(formatPageLocation(media), '#70+/gallery/123+/media/job/123');
  assert.equal(parsePageLocation('#+/gallery').chatId, null, 'An explicit gallery URL can have no background chat');
  for (const asset of ['0', '-1', 'NaN', '1.5']) {
    assert.equal(
      formatPageLocation(parsePageLocation('#71+/media/job/1?asset=' + asset)),
      '#71+/media/job/1',
      'Invalid result IDs cannot select an asset',
    );
  }

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
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  Object.defineProperty(globalThis, 'location', { value: location });
  Object.defineProperty(globalThis, 'history', { value: history });
  const { installPageNavigation, writePageLocation, applyPageLocation, guardPageNavigation, returnToPageLocation } =
    await import(modulePath);
  let rendered = '#70';
  let restoreDialogs: ((page: unknown) => void) | undefined;
  installPageNavigation((page: unknown) => {
    applyPageLocation(page, () => {
      rendered = formatPageLocation(page);
      restoreDialogs?.(page);
    });
  });
  function settle() {
    let steps = 0;
    while (traversals.length) {
      assert(++steps < 20, 'History traversal must settle');
      traversals.shift()!();
    }
  }
  function go(delta: number) {
    history.go(delta);
    settle();
  }
  function at(index: number, hash: string, message = 'History cursor and rendered page agree') {
    assert.equal(cursor, index, message);
    assert.equal(rendered, hash, message);
    assert.equal(location.hash, hash, message);
  }
  function unchangedHistory() {
    assert.deepEqual(
      entries.map((entry) => entry.hash),
      initialEntries,
    );
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
  go(-1);
  assert.equal(guards, 1);
  at(2, '#70+/settings/general', 'The guard opens at the original history entry');
  unchangedHistory();
  approve = undefined; // Cancel: the navigation action is deliberately not called.
  go(-1);
  assert.equal(guards, 2, 'Back after Cancel still targets the same preceding page');
  approve!();
  settle();
  at(1, '#70+/gallery');
  unchangedHistory();

  go(1);
  assert.equal(cursor, 1, 'Forward also restores the origin before asking');
  approve!();
  settle();
  at(2, '#70+/settings/general');

  go(-2);
  approve!();
  settle();
  at(0, '#70', 'Multi-entry traversals preserve their original distance');
  unchangedHistory();
  unguard();
  go(1);
  at(1, '#70+/gallery');
  assert.equal(guards, 4, 'Unguarded navigation proceeds without another confirmation');

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
  at(jobsCursor - 1, '#70+/gallery/123');
  go(1);
  assert.equal(rendered, '#70+/gallery/123+/jobs', 'Forward reconstructs the child pane');
  returnToPageLocation(parsePageLocation('#99'), () => {
    fallback = true;
  });
  assert.equal(fallback, true, 'A reloaded link can close without an earlier parent history entry');

  // Browser jumps guard every removed pane, but never editors retained underneath Jobs.
  const draftHash = '#70+/gallery/123+/media/job/3';
  const jobsHash = draftHash + '+/jobs';
  const otherHash = jobsHash + '+/media/job/4';
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
  go(-1);
  assert.deepEqual(guardOrder, ['draft-b']);
  assert.equal(rendered, jobsHash);
  removeJobGuard();
  go(-2);
  assert.deepEqual(guardOrder, ['draft-b', 'draft-a']);
  assert.equal(rendered, jobsHash, 'A covered editor can cancel without losing any panes');
  approve = undefined;
  go(-2);
  approve!();
  settle();
  assert.equal(rendered, '#70+/gallery/123+/jobs');
  removeJobGuard();
  removeDraftGuard();

  const repeated = '#71+/gallery/35?sort=newest+/media/job/1+/jobs+/media/job/1';
  const repeatedJobs = '#71+/gallery?sort=newest+/jobs+/media/job/9+/jobs';
  for (const [input, expected, suffix] of [
    [repeated, '#71+/gallery/35?sort=newest+/media/job/1', '+/jobs+/media/job/2'],
    [repeatedJobs, '#71+/gallery?sort=newest+/jobs', '+/media/job/2'],
  ] as const) {
    assert.equal(formatPageLocation(parsePageLocation(input)), expected, 'Repeated panes unwind');
    assert.equal(
      formatPageLocation(parsePageLocation(input + suffix)),
      expected + suffix,
      'Unwinding preserves subsequent different panes',
    );
  }

  const { navigatePageWithGuards } = await import(modulePath);
  open('#70+/gallery/123+/media/job/1');
  open('#70+/gallery/123+/media/job/1+/jobs');
  const targetJob = parsePageLocation('#70+/gallery/123+/media/job/1');
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
  assert.equal(rendered, '#70+/gallery/123+/media/job/1+/jobs');
  approveChild!();
  settle();
  assert.equal(reopened, true);
  assert.equal(rendered, '#70+/gallery/123+/media/job/1');
  unguardChild();
  unguardRetained();

  // Saving a removed child can replace its job ID without cancelling the intended return.
  const stackModule = '../../client/src/state/dialogStack.ts';
  const { dialogStack } = await import(stackModule);
  const child = parsePageLocation('#70+/media/job/1+/jobs+/media/job/2');
  open(formatPageLocation(child));
  dialogStack.restore(child);
  const stopSaveGuard = guardPageNavigation((action: () => void) => {
    writePageLocation({ ...child, media: { ...child.media, jobId: 5 } });
    action();
  });
  let returnedAfterSave = false;
  navigatePageWithGuards(parsePageLocation('#70+/media/job/1'), () => {
    returnedAfterSave = true;
  });
  assert(returnedAfterSave, 'Saving a child variation must still finish the return to the existing pane');
  stopSaveGuard();
  dialogStack.restore(parsePageLocation('#70'));

  // Exercise the actual Jobs button: reuse the mounted list and its history entry.
  const navigationModule = '../../client/src/media/navigation.ts';
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: () => Object.assign(new EventTarget(), { matches: false }),
  });
  const { openMediaJobs, openMediaTool } = await import(navigationModule);
  const galleryPage = parsePageLocation('#+/gallery?sort=newest');
  applyPageLocation(galleryPage, () => dialogStack.restore(galleryPage));
  restoreDialogs = (page) => dialogStack.restore(page);
  openMediaJobs();
  const originalJobs = dialogStack.top()!;
  const originalJobsCursor = cursor;
  const originalJobsHash = location.hash;
  openMediaJobs();
  assert.equal(dialogStack.top(), originalJobs, 'Opening the active Jobs pane is a no-op');
  assert.equal(cursor, originalJobsCursor);
  openMediaTool('image', { jobId: 6 });
  const editor = dialogStack.top()!;
  const editorHash = location.hash;
  let approveJobs: (() => void) | undefined;
  const removeEditorGuard = guardPageNavigation(
    (action: () => void) => {
      approveJobs = action;
    },
    (target: unknown) => !dialogStack.retains(editor, target),
  );
  openMediaJobs();
  assert(approveJobs, 'Returning to Jobs consults the removed editor guard');
  approveJobs = undefined; // Cancel retains the editor and original list.
  assert.equal(dialogStack.top(), editor);
  assert.equal(location.hash, editorHash);
  assert.equal(dialogStack.frames().length, 3);
  openMediaJobs();
  approveJobs!();
  settle();
  assert.equal(dialogStack.top(), originalJobs, 'List identity preserves filters and scroll');
  assert.equal(location.hash, originalJobsHash);
  assert.equal(cursor, originalJobsCursor, 'Reuse the existing history entry');
  removeEditorGuard();
  go(1);
  assert.equal(location.hash, editorHash, 'Forward can reopen the editor after returning to Jobs');
  assert.equal(dialogStack.frames()[1], originalJobs);
  const storeModule = '../../client/src/state/store.ts';
  const referencesModule = '../../client/src/state/entityReferences.ts';
  const { openDialog, openModal } = await import(storeModule);
  const { editReferencedEntity } = await import(referencesModule);
  applyPageLocation(galleryPage, () => dialogStack.restore(galleryPage));
  const retainedGallery = dialogStack.top()!;
  openDialog({ chatId: null, modal: 'settings', settingsTab: 'generation-settings' });
  const settings = dialogStack.top()!;
  let approveSettings: (() => void) | undefined;
  const removeSettingsGuard = guardPageNavigation(
    (action: () => void) => {
      approveSettings = action;
    },
    (target: unknown) => !dialogStack.retains(settings, target),
  );
  editReferencedEntity('workflows', 'example');
  assert(approveSettings, 'Changing settings editors guards the current draft');
  assert.equal(dialogStack.top(), settings);
  assert.equal(dialogStack.frames().length, 2, 'No second settings panel while awaiting the guard');
  approveSettings = undefined; // Cancel keeps the original editor.
  editReferencedEntity('workflows', 'example');
  approveSettings!();
  removeSettingsGuard();
  const workflowEditor = dialogStack.top()!;
  assert.equal(workflowEditor.page.settingsEntity, 'example');
  assert.equal(dialogStack.frames().length, 2);
  assert.equal(dialogStack.frames()[0], retainedGallery);
  editReferencedEntity('workflows', 'example');
  assert.equal(dialogStack.top(), workflowEditor, 'Looking up the current entity retains its open draft');
  openModal('settings');
  assert.equal(dialogStack.top(), workflowEditor, 'The settings button also reuses the panel');
  openMediaTool('example');
  const settingsChild = dialogStack.top()!;
  let approveSettingsChild: (() => void) | undefined;
  const removeChildGuard = guardPageNavigation(
    (action: () => void) => {
      approveSettingsChild = action;
    },
    (target: unknown) => !dialogStack.retains(settingsChild, target),
  );
  editReferencedEntity('workflows', 'example');
  assert(approveSettingsChild, 'Returning to existing settings guards the removed child');
  assert.equal(dialogStack.top(), settingsChild);
  approveSettingsChild!();
  removeChildGuard();
  assert.equal(dialogStack.top(), workflowEditor);
  assert.equal(dialogStack.frames().length, 2, 'Returning cannot stack settings panels');
  restoreDialogs = undefined;
  dialogStack.restore(parsePageLocation('#70'));

  // Native hash changes have no app history state, but must preserve the dirty
  // editor and the original entry until its guard approves the new location.
  open('#70+/settings/general');
  const nativeOrigin = cursor;
  let approveNative: (() => void) | undefined;
  const removeNativeGuard = guardPageNavigation((action: () => void) => {
    approveNative = action;
  });
  const enterHash = (hash: string) => {
    entries.splice(cursor + 1);
    entries.push({ hash, state: null });
    cursor++;
    location.hash = hash;
    const event = new Event('popstate');
    Object.defineProperty(event, 'state', { value: null });
    browser.dispatchEvent(event);
    settle();
  };
  enterHash('#70+/settings/characters');
  assert(approveNative, 'An address-bar hash change must consult the settings guard');
  at(nativeOrigin, '#70+/settings/general');
  approveNative = undefined; // Cancel leaves the new target available through Forward.
  go(1);
  assert(approveNative);
  at(nativeOrigin, '#70+/settings/general');
  (approveNative as unknown as () => void)();
  settle();
  at(nativeOrigin + 1, '#70+/settings/characters');
  removeNativeGuard();
  go(-1);
  at(nativeOrigin, '#70+/settings/general');
});

test('dialog stack', async () => {
  const stackModule = '../../client/src/state/dialogStack.ts';
  const locationModule = '../../client/src/state/pageLocation.ts';
  const layersModule = '../../client/src/state/dialogLayers.ts';
  const { createDialogStack } = await import(stackModule);
  const { parsePageLocation, formatPageLocation, pageStack, paneLocation } = await import(locationModule);
  const { createDialogLayers } = await import(layersModule);

  const stack = createDialogStack();
  const gallery = parsePageLocation('#71+/gallery/123?q=night+sky&character=4&sort=oldest');
  stack.restore(gallery);
  const galleryFrame = stack.top()!;
  const jobs = parsePageLocation(formatPageLocation(gallery) + '+/jobs');
  stack.push(jobs, gallery);
  assert.equal(stack.frames().length, 2, 'Jobs from details does not create an empty draft');
  assert.equal(stack.top()!.page.modal, 'media-jobs');
  assert.equal(stack.top()!.media, undefined, 'Jobs has no editor session or draft');
  assert.equal(stack.parent(), galleryFrame.page);
  assert.equal(stack.pop(), galleryFrame.page);
  assert.equal(stack.top(), galleryFrame, 'Returning preserves the mounted gallery');

  const draft = parsePageLocation(formatPageLocation(gallery) + '+/media/generate');
  const session = {
    requestKey: '12345678901234567890',
    workflowId: null,
    jobId: null,
    contextConversationId: null,
    destination: 'gallery' as const,
    prompt: 'Prompt from a chat selection',
    inputs: [],
    assets: [],
  };
  stack.push(draft, gallery, session);
  const draftFrame = stack.top()!;
  const draftJobs = parsePageLocation(formatPageLocation(draft) + '+/jobs');
  stack.push(draftJobs, draft);
  const jobsFrame = stack.top()!;
  const other = parsePageLocation(formatPageLocation(draftJobs) + '+/media/job/2');
  stack.push(other, draftJobs);
  assert.equal(stack.frames().length, 4);
  assert.equal(stack.retains(draftFrame, draftJobs), true);
  assert.equal(stack.retains(draftFrame, gallery), false);
  stack.restore(draftJobs);
  assert.equal(stack.top(), jobsFrame, 'Browser Back preserves the mounted Jobs list');
  stack.restore(draft);
  assert.equal(stack.top(), draftFrame, 'Returning to a draft preserves its component identity');
  assert.equal(stack.top()!.media, session);
  assert.equal(stack.frames()[0], galleryFrame);

  // URL writes update only the top frame, keeping its ancestors and component identity.
  const updated = stack.remember({
    ...paneLocation(draft),
    media: { ...draft.media!, jobId: 1 },
  });
  assert.equal(stack.top(), draftFrame);
  assert.equal(formatPageLocation(updated), formatPageLocation(gallery) + '+/media/job/1');
  const snapshot = formatPageLocation(updated) + '+/jobs+/media/job/2';
  const restored = createDialogStack();
  restored.restore(parsePageLocation(snapshot));
  assert.deepEqual(
    restored.frames().map((frame: { page: { modal: string } }) => frame.page.modal),
    ['gallery', 'media-tools', 'media-jobs', 'media-tools'],
  );
  assert.equal(restored.frames()[0]!.page.galleryId, 123);
  assert.equal(restored.frames()[0]!.page.query, 'night sky');
  assert.equal(restored.frames()[1]!.media!.jobId, 1);
  assert.equal(restored.frames()[2]!.media, undefined, 'Restored Jobs has no editor session');
  assert.equal(restored.frames()[3]!.media!.jobId, 2);
  assert.equal(restored.frames()[1]!.media!.prompt, '', 'Reload reconstructs panes, not unsaved form text');
  assert.equal(pageStack(parsePageLocation(snapshot))[0]!.chatId, 71);
  restored.pop();
  restored.pop();
  restored.pop();
  assert.equal(restored.top()!.page.galleryId, 123);
  assert.equal(formatPageLocation(restored.pop()), '#71');
  assert.equal(restored.frames().length, 0);

  // Explicit modal activation is independent of mount order for hidden routed panes.
  const layers = createDialogLayers();
  let galleryActive = true;
  let draftActive = false;
  const galleryLayer = layers.register(() => galleryActive);
  const draftLayer = layers.register(() => draftActive);
  assert(galleryLayer.isTop());
  galleryActive = false;
  draftActive = true;
  assert(draftLayer.isTop());
  const pickerLayer = layers.register(() => draftActive);
  assert(pickerLayer.isTop());
  assert(!draftLayer.isTop());
  const guardLayer = layers.register(() => true);
  assert(guardLayer.isTop(), 'A navigation confirmation can cover a hidden editor');
  pickerLayer.dispose();
  assert(guardLayer.isTop(), 'Disposing a lower surface cannot change the top');
  guardLayer.dispose();
  assert(draftLayer.isTop());
  draftLayer.dispose();
  galleryActive = true;
  assert(galleryLayer.isTop());
  galleryLayer.dispose();

  const inputsModule = '../../client/src/media/restoreInputs.ts';
  const { restoreMediaInputs } = await import(inputsModule);
  const image = { id: 11, kind: 'image', url: '/images/source.png', width: 640, height: 960 };
  const otherImage = { ...image, id: 12, url: '/images/other.png' };
  const video = { id: 13, kind: 'video', url: '/images/source.webm' };
  const galleryItems = [
    { id: 35, media: image },
    { id: 36, media: video },
  ];
  const sourceUrl = '#71+/gallery/35?sort=newest+/media/generate?workflow=animate';
  const sourcePage = parsePageLocation(sourceUrl);
  const inferredStack = createDialogStack();
  inferredStack.restore(sourcePage, (page: unknown) => restoreMediaInputs(page, galleryItems, {}));
  const inferred = inferredStack.top()!.media!;
  assert.deepEqual(
    { inputs: inferred.inputs, assets: inferred.assets },
    { inputs: [], assets: [image] },
    'Reload reselects the source and retains dimensions for workflow defaults',
  );
  inferredStack.top()!.media!.inputs = [];
  inferredStack.restore(sourcePage, () => {
    throw new Error('Retained panes must not re-infer inputs');
  });
  assert.deepEqual(
    inferredStack.top()!.media!.inputs,
    [],
    'Returning to a mounted pane preserves deliberate deselection',
  );
  for (const hash of [
    '#71+/gallery/35+/jobs',
    '#71+/gallery/35+/media/job/10',
    '#71+/gallery/999+/media/generate?workflow=animate',
    '#71+/media/generate?workflow=animate',
  ]) {
    assert.equal(restoreMediaInputs(parsePageLocation(hash), galleryItems, {}), undefined, hash);
  }
  assert.deepEqual(
    restoreMediaInputs(parsePageLocation('#71+/gallery/36+/media/generate?workflow=animate'), galleryItems, {}),
    { inputs: [], assets: [video] },
  );
  const sourceJobs = {
    6: { outputs: [otherImage], draft: { id: 4, selectedAssetId: 12 } },
    7: { outputs: [], draft: { id: 4, selectedAssetId: 12 } },
  };
  const nestedSource = parsePageLocation('#71+/gallery/35+/media/job/7+/jobs+/media/generate?workflow=animate');
  assert.equal(
    restoreMediaInputs(nestedSource, galleryItems, sourceJobs).assets[0].id,
    12,
    'Nearest job uses its selected variation before a more distant gallery source',
  );
  assert.equal(
    restoreMediaInputs(nestedSource, galleryItems, {}).assets[0].id,
    11,
    'Unavailable ancestor jobs can fall back to a suitable gallery image',
  );
  assert.equal(
    restoreMediaInputs(parsePageLocation('#71+/media/job/6?asset=11+/media/generate?workflow=animate'), galleryItems, {
      6: { outputs: [image, otherImage], draft: { id: 4, selectedAssetId: 12 } },
    }).assets[0].id,
    11,
    'A nested editor restores the result in its parent URL ahead of shared draft selection',
  );

  // The route follows newly created job IDs; the immutable launch session may still have no ID.
  const existingEditor = stack.top()!;
  assert.equal(existingEditor.media.jobId, null);
  assert.equal(existingEditor.page.media.jobId, 1);
  const reviewJobs = {
    1: { draft: { id: 1 } },
    11: { draft: { id: 1 } },
    2: { draft: { id: 2 } },
  };
  assert.equal(stack.findJob(1, {}), existingEditor, 'Job identity works before history DTOs load');
  assert.equal(stack.findJob(11, reviewJobs), existingEditor, 'A grouped variation returns to its existing editor');
  assert.equal(stack.findJob(2, reviewJobs), undefined, 'Different jobs open independently');
  const originalPage = existingEditor.page;
  const selectedPage = stack.remember({
    ...originalPage,
    media: { ...originalPage.media, jobId: 11, assetId: 42 },
  });
  assert.equal(stack.top(), existingEditor, 'Variation URL updates preserve the mounted editor');
  assert.equal(stack.top()!.media, session, 'Choosing a preview preserves the working draft');
  const linked = createDialogStack();
  linked.restore(parsePageLocation(formatPageLocation(selectedPage)));
  assert.equal(linked.top()!.media!.jobId, 11);
  assert.equal(linked.top()!.media!.assetId, 42, 'Reload restores the exact result selection');
  stack.remember(originalPage);
  const listPage = parsePageLocation(formatPageLocation(originalPage) + '+/jobs');
  stack.push(listPage, originalPage);
  const target = stack.findJob(1, reviewJobs)!;
  stack.restore(target.page);
  assert.equal(stack.top(), existingEditor);
  assert.equal(stack.frames().length, 2, 'Reopening leaves one job editor above gallery details');
});

test('ui back', async () => {
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

  const modulePath = '../../client/src/state/uiBack.ts';
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
    const events = pointer ? ['pointerdown', 'mousedown', 'pointerup', 'mouseup'] : ['mousedown', 'mouseup'];
    if (auxiliary) events.push('auxclick');
    for (const event of events) assert.equal(mouse(event), expected, event);
  }

  for (const name of ['gallery', 'detail', 'menu']) layer(name);
  for (const name of ['menu', 'detail', 'gallery']) {
    const previous = actions.length;
    back(true);
    assert.deepEqual(actions.slice(previous), [name], 'One press closes only the topmost surface');
  }
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
  assert.equal(actions.at(-1), 'next mouse-only menu', 'Missing auxclick does not retain old actions');

  layer('pointer-only menu');
  assert(mouse('pointerdown'));
  assert(mouse('pointerup'));
  assert(mouse('auxclick'));
  assert.equal(actions.at(-1), 'pointer-only menu', 'Cancelled pointerdown can suppress mouse events');

  layer('unchanged');
  for (const button of [0, 1, 2, 4]) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick']) {
      assert.equal(mouse(type, button), false, 'Other buttons retain their normal behavior');
    }
  }
  stop();
  back(false);
  assert.equal(surfaces.length, 1, 'Unmount removes the listeners');

  const { installUiBack } = await import(modulePath);
  const stopUi = installUiBack();
  surfaces = [];
  const previousActions = actions.length;
  layer('gallery details');
  layer('jobs');
  layer('job');
  layer('picker');
  layer('dropdown');
  function escape() {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { value: 'Escape' });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }
  for (let i = 0; i < 5; i++) assert(escape());
  assert.deepEqual(actions.slice(previousActions), ['dropdown', 'picker', 'job', 'jobs', 'gallery details']);
  assert(!escape(), 'Escape reaches inline editors when no dialog can close');
  stopUi();
});
