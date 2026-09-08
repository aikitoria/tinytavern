import assert from 'node:assert/strict';
import {
  compileMediaWorkflow,
  expandMediaWorkflow,
  mediaInputSlots,
  mediaWorkflowError,
  migrateMediaRendering,
  DEFAULT_MEDIA_RENDERING,
  defaultMediaPrompt,
  defaultChatMediaPrompt,
  type MediaWorkflow,
} from '@tinytavern/shared';
import { parseMediaRendering, parseMediaPrompts } from '../server/src/mediaSettings.ts';

const workflow: MediaWorkflow = {
  id: 'three',
  name: 'Three references',
  operation: 'image-edit',
  referenceCount: 3,
  json: '{"1":{"class_type":"Edit","inputs":{"text":"prefix {{prompt}}","seed":{{seed}},"refs":["{{reference1}}","{{reference2}}","{{reference3}}"],"prefix":"{{job_id}}"}}}',
  galleryPromptPresetId: null,
  chatPromptPresetId: null,
};
assert.equal(mediaWorkflowError(workflow), null);
const compiled = compileMediaWorkflow(workflow.json);
const before = JSON.stringify(compiled.graph);
const prompt = 'Quotes " \\ newline\n literal {{seed}} $&';
const result = expandMediaWorkflow(compiled, {
  prompt,
  seed: 0,
  job_id: 'job',
  source: 'source.png',
  reference1: 'a.png',
  reference2: 'b.png',
  reference3: 'c.png',
}) as { '1': { inputs: Record<string, unknown> } };
assert.equal(result['1'].inputs.text, `prefix ${prompt}`);
assert.equal(result['1'].inputs.seed, 0);
assert.deepEqual(result['1'].inputs.refs, ['a.png', 'b.png', 'c.png']);
assert.equal(JSON.stringify(compiled.graph), before, 'Compilation can be reused without mutation');
assert.equal(compileMediaWorkflow(workflow.json), compiled, 'Identical source reuses compilation');
const changedWorkflow = { ...workflow, json: workflow.json.replace('prefix ', 'edited ') };
assert.notEqual(
  compileMediaWorkflow(changedWorkflow.json),
  compiled,
  'Edits under the same workflow ID compile the changed source',
);
const nextResult = expandMediaWorkflow(compiled, {
  prompt: 'Second prompt',
  seed: 42,
  job_id: 'next-job',
  reference1: 'next-a.png',
  reference2: 'next-b.png',
  reference3: 'next-c.png',
}) as typeof result;
(result['1'].inputs.refs as string[])[0] = 'mutated-output.png';
assert.equal(nextResult['1'].inputs.text, 'prefix Second prompt');
assert.equal(nextResult['1'].inputs.seed, 42);
assert.deepEqual(nextResult['1'].inputs.refs, ['next-a.png', 'next-b.png', 'next-c.png']);
assert.equal(JSON.stringify(compiled.graph), before, 'Expanded jobs cannot mutate cached inputs');
for (const count of [1, 2, 3]) {
  assert.deepEqual(
    mediaInputSlots('image-edit', count),
    Array.from({ length: count }, (_, index) => `reference${index + 1}`),
  );
}
assert.throws(() => mediaInputSlots('image-edit', 0));
assert.throws(() => mediaInputSlots('image-edit', 4));
assert.deepEqual(mediaInputSlots('video-first', 0), ['first_frame']);
assert.throws(() => mediaInputSlots('video', 1));
assert.throws(() => mediaInputSlots('video-references', 0));
for (const json of [
  '{"seed":"{{seed}}"}',
  '{"text":{{prompt}}}',
  '{"{{prompt}}":1}',
  '{"text":"{{reference4}}"}',
  '{"text":"{{last_frame}}"}',
  '{"seed":1{{seed}}}',
]) {
  assert.throws(() => compileMediaWorkflow(json), json);
}
assert.ok(mediaWorkflowError({ ...workflow, referenceCount: 2 }));
assert.throws(
  () => expandMediaWorkflow(compiled, { prompt, seed: 1, job_id: 'job' }),
  /Missing workflow input/,
);
const settings = {
  ...DEFAULT_MEDIA_RENDERING,
  workflows: [workflow],
  defaults: { 'image-edit:3': 'three' },
};
assert.deepEqual(parseMediaRendering(settings), settings);
assert.throws(() => parseMediaRendering({ ...settings, defaults: { 'video:0': 'three' } }));
assert.throws(() => parseMediaRendering({ ...settings, comfyUrl: 'file:///tmp' }));
assert.throws(() => parseMediaRendering({ ...settings, avatarWorkflowId: 'three' }));
assert.throws(() =>
  parseMediaRendering({
    ...settings,
    workflows: [{ ...workflow, operation: 'video-frames', referenceCount: 0 }],
  }),
);

const legacy = {
  workflows: [
    { name: 'My image', json: '{"prompt":"{{prompt}}"}' },
    { name: 'Avatar', json: '{"seed":{{seed}}}' },
  ],
  activeWorkflow: 'My image',
  avatarWorkflow: 'Avatar',
  comfyUrl: 'http://private-comfy:8588',
};
const migrated = migrateMediaRendering(legacy);
assert.deepEqual(
  migrated.workflows.map(({ name, json }) => ({ name, json })),
  legacy.workflows,
);
assert.equal(migrated.defaults['image:0'], migrated.workflows[0]!.id);
assert.equal(migrated.avatarWorkflowId, migrated.workflows[1]!.id);
assert.equal(migrated.comfyUrl, legacy.comfyUrl);

const galleryPrompt = {
  id: 'gallery',
  name: 'Video formatting',
  operation: 'video',
  ...defaultMediaPrompt('video'),
};
const chatPrompt = {
  id: 'chat',
  name: 'Video formatting',
  operation: 'video',
  chatPrompt: defaultChatMediaPrompt('video'),
};
assert.deepEqual(
  parseMediaPrompts(
    { presets: [galleryPrompt], defaults: { video: 'gallery' } },
    'galleryVideoPrompts',
  )?.presets,
  [galleryPrompt],
);
assert.deepEqual(
  parseMediaPrompts({ presets: [chatPrompt], defaults: { video: 'chat' } }, 'chatVideoPrompts')
    ?.presets,
  [chatPrompt],
);
assert.throws(
  () => parseMediaPrompts({ presets: [galleryPrompt], defaults: {} }, 'chatVideoPrompts'),
  /Unexpected prompt field/,
);
assert.throws(
  () => parseMediaPrompts({ presets: [chatPrompt], defaults: {} }, 'galleryVideoPrompts'),
  /Unexpected prompt field/,
);
assert.throws(
  () => parseMediaPrompts({ presets: [galleryPrompt], defaults: {} }, 'galleryImagePrompts'),
  /operation/,
);
for (const key of ['systemPrompt', 'userMessage', 'reasoningPrefill', 'messagePrefill']) {
  assert.throws(
    () =>
      parseMediaPrompts(
        { presets: [{ ...galleryPrompt, [key]: '{{references}}' }], defaults: {} },
        'galleryVideoPrompts',
      ),
    /Reference images are workflow inputs/,
  );
}
// Reserved filenames bind only actual image loader inputs, preserving the saved export.
const filenameGraph = {
  source: { class_type: 'LoadImage', inputs: { image: 'source.png' } },
  mask: {
    class_type: 'LoadImageMask',
    inputs: { image: 'samples/source.png [input]', channel: 'alpha' },
  },
  ref1: { class_type: 'LoadImage', inputs: { image: 'reference1.png' } },
  ref2: { class_type: 'LoadImage', inputs: { image: 'samples/reference2.png' } },
  ref3: { class_type: 'LoadImage', inputs: { image: 'reference3.png [input]' } },
  text: { class_type: 'Text', inputs: { text: '{{prompt}}', image: 'reference1.png' } },
  fixed: { class_type: 'LoadImage', inputs: { image: 'my-reference1.png' } },
  output: { class_type: 'LoadImage', inputs: { image: 'reference1.png [output]' } },
  linked: { class_type: 'LoadImage', inputs: { image: ['filename', 0] } },
};
const filenameJson = JSON.stringify(filenameGraph);
const filenameWorkflow = { ...workflow, json: filenameJson };
assert.match(mediaWorkflowError(filenameWorkflow)!, /source is not an input/);
assert.ok(mediaWorkflowError({ ...filenameWorkflow, referenceCount: 2 }));
const filenameCompiled = compileMediaWorkflow(filenameJson);
assert.deepEqual([...filenameCompiled.slots].sort(), [
  'prompt',
  'reference1',
  'reference2',
  'reference3',
  'source',
]);
const bindings = {
  prompt: 'Do not replace source.png in text',
  seed: 123,
  job_id: 'files',
  source: 'jobs/source.webp',
  reference1: 'jobs/one.jpg',
  reference2: 'jobs/two.png',
  reference3: 'jobs/three.png',
};
const filenameResult = expandMediaWorkflow(filenameCompiled, bindings) as typeof filenameGraph;
assert.equal(filenameResult.source.inputs.image, bindings.source);
assert.equal(filenameResult.mask.inputs.image, bindings.source);
assert.equal(filenameResult.ref1.inputs.image, bindings.reference1);
assert.equal(filenameResult.ref2.inputs.image, bindings.reference2);
assert.equal(filenameResult.ref3.inputs.image, bindings.reference3);
assert.equal(filenameResult.text.inputs.text, bindings.prompt);
assert.equal(filenameResult.text.inputs.image, 'reference1.png');
assert.equal(filenameResult.fixed.inputs.image, 'my-reference1.png');
assert.equal(filenameResult.output.inputs.image, 'reference1.png [output]');
assert.deepEqual(filenameResult.linked.inputs.image, ['filename', 0]);
assert.equal(JSON.stringify(filenameGraph), filenameJson);
assert.equal(filenameWorkflow.json, filenameJson);
assert.throws(
  () => expandMediaWorkflow(filenameCompiled, { prompt, seed: 1, job_id: 'missing' }),
  /Missing workflow input/,
);
const firstFrame = {
  ...workflow,
  operation: 'video-first' as const,
  referenceCount: 0 as const,
  json: JSON.stringify({
    image: { class_type: 'LoadImage', inputs: { image: 'first_frame.png' } },
    text: { class_type: 'Text', inputs: { text: '{{prompt}}' } },
  }),
};
assert.equal(mediaWorkflowError(firstFrame), null);
assert.ok(compileMediaWorkflow(firstFrame.json).slots.has('first_frame'));
// Eviction drops only the derived cache; existing jobs can still expand their capture.
const evictionSource = '{"1":{"inputs":{"text":"{{prompt}}","tag":"eviction"}}}';
const evicted = compileMediaWorkflow(evictionSource);
for (let index = 0; index < 64; index++) {
  compileMediaWorkflow(`{"1":{"inputs":{"text":"{{prompt}}","tag":${index}}}}`);
}
assert.notEqual(compileMediaWorkflow(evictionSource), evicted, 'Compilation cache is bounded');
assert.deepEqual(
  expandMediaWorkflow(evicted, { prompt: 'after eviction', seed: 0, job_id: 'retained' }),
  { '1': { inputs: { text: 'after eviction', tag: 'eviction' } } },
);
console.log('Media workflow bindings and independent chat/gallery prompt schemas passed');
