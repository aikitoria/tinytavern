import assert from 'node:assert/strict';

const stackModule = '../client/src/state/dialogStack.ts';
const locationModule = '../client/src/state/pageLocation.ts';
const layersModule = '../client/src/state/dialogLayers.ts';
const { createDialogStack } = await import(stackModule);
const { parsePageLocation, formatPageLocation, pageStack, paneLocation } = await import(
  locationModule
);
const { createDialogLayers } = await import(layersModule);

const stack = createDialogStack();
const gallery = parsePageLocation('#71+/gallery/123?q=night+sky&character=4&sort=oldest');
stack.restore(gallery);
const galleryFrame = stack.top()!;
const localState = new WeakMap<object, object>();
const galleryEdits = { prompt: 'Unsaved gallery prompt', selected: [4, 7], scrollTop: 420 };
localState.set(galleryFrame, galleryEdits);
const jobs = parsePageLocation(formatPageLocation(gallery) + '+/jobs');
stack.push(jobs, gallery);
assert.equal(stack.frames().length, 2, 'Jobs from details does not create an empty draft');
assert.equal(stack.top()!.page.modal, 'media-jobs');
assert.equal(stack.top()!.media, undefined, 'Jobs has no editor session or draft');
assert.equal(stack.parent(), galleryFrame.page);
assert.equal(stack.pop(), galleryFrame.page);
assert.equal(localState.get(stack.top()!), galleryEdits);

const draft = parsePageLocation(formatPageLocation(gallery) + '+/media/create-image');
const session = {
  id: 'session-a',
  operation: 'image' as const,
  jobId: null,
  contextConversationId: null,
  destination: 'gallery' as const,
  prompt: 'Prompt from a chat selection',
  inputs: [],
  assets: [],
};
stack.push(draft, gallery, session);
const draftFrame = stack.top()!;
const draftEdits = {
  instruction: 'My tuned instruction',
  prompt: 'My tuned prompt',
  referenceIds: [3, 6],
  scrollTop: 870,
};
localState.set(draftFrame, draftEdits);
const draftJobs = parsePageLocation(formatPageLocation(draft) + '+/jobs');
stack.push(draftJobs, draft);
const jobsFrame = stack.top()!;
const other = parsePageLocation(formatPageLocation(draftJobs) + '+/media/job/job-b');
stack.push(other, draftJobs);
assert.equal(stack.frames().length, 4);
assert.equal(stack.retains(draftFrame, draftJobs), true);
assert.equal(stack.retains(draftFrame, gallery), false);
stack.restore(draftJobs);
assert.equal(stack.top(), jobsFrame, 'Browser Back preserves the mounted Jobs list');
stack.restore(draft);
assert.equal(stack.top(), draftFrame, 'Returning to a draft preserves its component identity');
assert.equal(localState.get(stack.top()!), draftEdits);
assert.equal(stack.top()!.media, session);
assert.equal(stack.frames()[0], galleryFrame);

// URL writes update only the top frame, keeping its ancestors and component identity.
const updated = stack.remember({
  ...paneLocation(draft),
  media: { ...draft.media!, jobId: 'job-a' },
});
assert.equal(stack.top(), draftFrame);
assert.equal(formatPageLocation(updated), formatPageLocation(gallery) + '+/media/job/job-a');
assert.equal(localState.get(stack.top()!), draftEdits);
const snapshot = formatPageLocation(updated) + '+/jobs+/media/job/job-b';
const restored = createDialogStack();
restored.restore(parsePageLocation(snapshot));
assert.deepEqual(
  restored.frames().map((frame: { page: { modal: string } }) => frame.page.modal),
  ['gallery', 'media-tools', 'media-jobs', 'media-tools'],
);
assert.equal(restored.frames()[0]!.page.galleryId, 123);
assert.equal(restored.frames()[0]!.page.query, 'night sky');
assert.equal(restored.frames()[1]!.media!.jobId, 'job-a');
assert.equal(restored.frames()[2]!.media, undefined, 'Restored Jobs has no editor session');
assert.equal(restored.frames()[3]!.media!.jobId, 'job-b');
assert.equal(
  restored.frames()[1]!.media!.prompt,
  '',
  'Reload reconstructs panes, not unsaved form text',
);
assert.equal(pageStack(parsePageLocation(snapshot))[0]!.chatId, 71);
for (const text of ['Unsaved', 'tuned', 'selection', 'referenceIds', 'scrollTop', 'return='])
  assert(!snapshot.includes(text));
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
console.log(
  'Dialog frames retain local state, reconstruct from flat URLs, and share modal activation.',
);

const inputsModule = '../client/src/media/restoreInputs.ts';
const { restoreMediaInputs } = await import(inputsModule);
const image = { id: 11, kind: 'image', url: '/images/source.png', width: 640, height: 960 };
const otherImage = { ...image, id: 12, url: '/images/other.png' };
const video = { id: 13, kind: 'video', url: '/images/source.webm' };
const galleryItems = [
  { id: 35, media: image },
  { id: 36, media: video },
];
const sourceUrl = '#71+/gallery/35?sort=newest+/media/create-video?mode=first-frame';
const sourcePage = parsePageLocation(sourceUrl);
assert.deepEqual(restoreMediaInputs(sourcePage, galleryItems, {}), {
  inputs: [{ slot: 'first_frame', assetId: 11 }],
  assets: [image],
});
const inferredStack = createDialogStack();
const infer = (page: unknown) => restoreMediaInputs(page, galleryItems, {});
inferredStack.restore(sourcePage, infer);
assert.equal(
  inferredStack.top()!.media!.inputs[0].assetId,
  11,
  'Reload reselects the gallery starting image',
);
assert.equal(
  inferredStack.top()!.media!.assets[0].height,
  960,
  'Restored input retains dimensions for workflow defaults',
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
for (const [route, slot] of [
  ['create-video?mode=references', 'reference1'],
  ['edit-image', 'reference1'],
  ['describe-image', 'source'],
]) {
  const page = parsePageLocation('#71+/gallery/35+/jobs+/media/' + route);
  assert.equal(restoreMediaInputs(page, galleryItems, {}).inputs[0].slot, slot);
}
for (const hash of [
  '#71+/gallery/35+/media/create-video',
  '#71+/gallery/35+/media/create-image',
  '#71+/gallery/35+/jobs',
  '#71+/gallery/35+/media/job/saved-job',
  '#71+/gallery/999+/media/create-video?mode=first-frame',
  '#71+/gallery/36+/media/create-video?mode=first-frame',
  '#71+/media/create-video?mode=first-frame',
]) {
  assert.equal(restoreMediaInputs(parsePageLocation(hash), galleryItems, {}), undefined, hash);
}
const sourceJobs = {
  old: { outputs: [otherImage], draft: { id: 'review', selectedAssetId: 12 } },
  current: { outputs: [], draft: { id: 'review', selectedAssetId: 12 } },
};
const nestedSource = parsePageLocation(
  '#71+/gallery/35+/media/job/current+/jobs+/media/create-video?mode=first-frame',
);
assert.equal(
  restoreMediaInputs(nestedSource, galleryItems, sourceJobs).inputs[0].assetId,
  12,
  'Nearest job uses its selected variation before a more distant gallery source',
);
assert.equal(
  restoreMediaInputs(nestedSource, galleryItems, {}).inputs[0].assetId,
  11,
  'Unavailable ancestor jobs can fall back to a suitable gallery image',
);
console.log(
  'Restored media panes infer suitable ancestor images without overriding saved jobs or live edits.',
);

// The route follows newly created job IDs; the immutable launch session may still have no ID.
const existingEditor = stack.top()!;
assert.equal(existingEditor.media.jobId, null);
assert.equal(existingEditor.page.media.jobId, 'job-a');
const reviewJobs = {
  'job-a': { draft: { id: 'review-a' } },
  'job-a-variation': { draft: { id: 'review-a' } },
  'job-b': { draft: { id: 'review-b' } },
};
assert.equal(
  stack.findJob('job-a', {}),
  existingEditor,
  'Job identity works before history DTOs load',
);
assert.equal(
  stack.findJob('job-a-variation', reviewJobs),
  existingEditor,
  'A grouped variation returns to its existing editor',
);
assert.equal(stack.findJob('job-b', reviewJobs), undefined, 'Different jobs open independently');
const originalPage = existingEditor.page;
const listPage = parsePageLocation(formatPageLocation(originalPage) + '+/jobs');
stack.push(listPage, originalPage);
const target = stack.findJob('job-a', reviewJobs)!;
stack.restore(target.page);
assert.equal(stack.top(), existingEditor);
assert.equal(
  localState.get(stack.top()!),
  draftEdits,
  'Returning from Jobs preserves tuned form state',
);
assert.equal(stack.frames().length, 2, 'Reopening leaves one job editor above gallery details');
