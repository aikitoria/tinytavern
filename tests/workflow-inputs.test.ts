import assert from 'node:assert/strict';
import {
  compileMediaWorkflow,
  expandMediaWorkflow,
  validateWorkflowValues,
} from '@tinytavern/shared';

const node = (class_type: string, value: number | string | boolean, title: string) => ({
  class_type,
  inputs: { value },
  _meta: { title },
});
const graph = {
  frames: node('PrimitiveInt', 81, 'Frames [input: min=1, max=241, step=4]'),
  duration: node('PrimitiveFloat', 2.5, 'Duration (seconds) [input: min=1, max=10, step=0.5]'),
  text: node('PrimitiveStringMultiline', 'soft light', 'Style [input]'),
  sampler: { class_type: 'KSampler', inputs: { seed: 123, text: '{{prompt}}', steps: 20 } },
  noise: { class_type: 'RandomNoise', inputs: { noise_seed: 456 } },
  seed: node('PrimitiveInt', 999, 'Seed'),
  linked: { class_type: 'KSampler', inputs: { seed: ['seed', 0] } },
  fixed: node('PrimitiveInt', 42, 'Chosen seed [input: min=0]'),
  fixedSampler: { class_type: 'KSampler', inputs: { seed: ['fixed', 0] } },
  toggle: node('PrimitiveBoolean', true, 'Enable upscale [input]'),
};
const compiled = compileMediaWorkflow(JSON.stringify(graph));
assert.deepEqual(
  compiled.controls.map((control) => control.label),
  ['Frames', 'Duration (seconds)', 'Style', 'Chosen seed', 'Enable upscale'],
);
assert.equal(compiled.controls[1]!.type, 'float');
const original = JSON.stringify(compiled.graph);
const text = '"quoted" \\ path\n{{seed}} {{prompt}} $&';
const result = expandMediaWorkflow(
  compiled,
  { prompt: 'Scene', seed: 12345, job_id: 'job' },
  {
    frames: 121,
    duration: 3.5,
    text,
    toggle: false,
  },
) as typeof graph;
assert.equal(result.frames.inputs.value, 121);
assert.equal(result.duration.inputs.value, 3.5);
assert.equal(result.text.inputs.value, text, 'User strings are never expanded as workflow macros');
assert.equal(result.sampler.inputs.seed, 12345);
assert.equal(result.noise.inputs.noise_seed, 12345);
assert.equal(result.seed.inputs.value, 12345);
assert.deepEqual(result.linked.inputs.seed, ['seed', 0]);
assert.equal(result.fixed.inputs.value, 42, 'An exposed seed remains user-controlled');
assert.equal(result.sampler.inputs.steps, 20);
assert.equal(result.toggle.inputs.value, false);
assert.equal(JSON.stringify(compiled.graph), original);
const next = expandMediaWorkflow(compiled, {
  prompt: 'Scene',
  seed: 54321,
  job_id: 'next',
}) as typeof graph;
assert.equal(next.frames.inputs.value, 81);
assert.equal(next.sampler.inputs.seed, 54321);
assert.equal(next.toggle.inputs.value, true);

for (const values of [
  { frames: 82 },
  { frames: 1.5 },
  { frames: 245 },
  { duration: 3.1 },
  { duration: Infinity },
  { text: 5 },
  { unknown: 2 },
  { toggle: 'false' },
  { toggle: 0 },
  [],
  null,
]) {
  assert.throws(() => validateWorkflowValues(compiled.controls, values));
}
for (const title of [
  'Frames [input: min=2, max=1]',
  'Frames [input: step=0]',
  'Frames [input: step=0.5]',
  'Frames [input: min=1, min=2]',
  'Frames [input: minimum=1]',
  'Frames [input: min=oops]',
  'Frames [input: min=1 step=4]',
  'Frames [input: min=1',
]) {
  assert.throws(
    () => compileMediaWorkflow(JSON.stringify({ frames: node('PrimitiveInt', 81, title) })),
    title,
  );
}
for (const title of [
  'Text [input: minLength=-1]',
  'Text [input: minLength=1.5]',
  'Text [input: minLength=6]',
  'Text [input: step=1]',
]) {
  assert.throws(
    () => compileMediaWorkflow(JSON.stringify({ text: node('PrimitiveString', 'hello', title) })),
    title,
  );
}
assert.throws(
  () => compileMediaWorkflow(JSON.stringify({ node: node('KSampler', 1, 'Sampler [input]') })),
  /constant node/,
);
assert.throws(
  () =>
    compileMediaWorkflow(
      JSON.stringify({ text: node('PrimitiveString', '{{prompt}}', 'Prompt [input]') }),
    ),
  /literal default/,
);
assert.throws(
  () =>
    compileMediaWorkflow(
      JSON.stringify({ ...graph, frames: { ...graph.frames, inputs: { value: ['seed', 0] } } }),
    ),
  /Invalid default/,
);
const kj = compileMediaWorkflow(
  JSON.stringify({
    text: {
      class_type: 'StringConstantMultiline',
      inputs: { string: 'hello' },
      _meta: { title: 'Text [input]' },
    },
  }),
);
assert.deepEqual(kj.controls[0], {
  key: 'text',
  nodeId: 'text',
  input: 'string',
  label: 'Text',
  type: 'string',
  value: 'hello',
  multiline: true,
});
// Removed title options are rejected rather than silently retained or ignored.
for (const option of ['minLength=1', 'maxLength=100', 'multiline=true', 'multiline=false']) {
  assert.throws(
    () =>
      compileMediaWorkflow(
        JSON.stringify({ text: node('PrimitiveString', '', `Text [input: ${option}]`) }),
      ),
    /Unknown string parameter/,
  );
}
for (const classType of [
  'PrimitiveString',
  'PrimitiveStringMultiline',
  'StringConstant',
  'StringConstantMultiline',
]) {
  const input = classType.startsWith('Primitive') ? 'value' : 'string';
  const textWorkflow = compileMediaWorkflow(
    JSON.stringify({
      text: {
        class_type: classType,
        inputs: { [input]: '' },
        _meta: { title: 'Text [input]' },
      },
    }),
  );
  const control = textWorkflow.controls[0]!;
  assert(control.type === 'string');
  assert.equal(control.multiline, classType.endsWith('Multiline'));
  assert(!('maxLength' in control));
  assert(!('minLength' in control));
  assert.deepEqual(validateWorkflowValues(textWorkflow.controls, { text: '' }), { text: '' });
  const longText = 'x'.repeat(200001) + '\nSecond line';
  const expanded = expandMediaWorkflow(
    textWorkflow,
    { prompt: '', seed: 1, job_id: 'text' },
    { text: longText },
  ) as Record<string, { inputs: Record<string, string> }>;
  assert.equal(
    expanded.text!.inputs[input],
    longText,
    'Workflow text has no per-field maximum or truncation',
  );
}

const resolutionGraph = {
  size: {
    class_type: 'ResolutionSelector',
    inputs: { aspect_ratio: '16:9 (Widescreen)', megapixels: 1, multiple: 32 },
    _meta: { title: 'Resolution [input]' },
  },
  latent: { class_type: 'EmptyLatentImage', inputs: { width: ['size', 0], height: ['size', 1] } },
};
const resolution = compileMediaWorkflow(JSON.stringify(resolutionGraph));
const orderedGraph = {
  '1': node('PrimitiveInt', 20, 'Steps [input]'),
  '2': node('PrimitiveFloat', 5, 'Duration [input: min=1, max=15, order=2]'),
  '3': node('PrimitiveString', '', 'Style [input: order=1]'),
  '4': {
    ...resolutionGraph.size,
    _meta: { title: 'Resolution [input: order=1]' },
  },
  '5': node('PrimitiveBoolean', true, 'Hybrid [input: order=0]'),
  '6': node('PrimitiveStringMultiline', '', 'Notes [input]'),
};
const ordered = compileMediaWorkflow(JSON.stringify(orderedGraph));
assert.deepEqual(
  ordered.controls.map((control) => control.key),
  ['5', '3', '4.aspect_ratio', '4.megapixels', '2', '1', '6'],
  'Explicit order sorts across control types, keeps ties stable and resolution fields together, then appends unordered fields',
);
assert.deepEqual(ordered.graph, orderedGraph, 'Display order does not change node IDs or inputs');
for (const type of ['PrimitiveInt', 'PrimitiveFloat', 'PrimitiveString', 'PrimitiveBoolean']) {
  for (const order of ['1.5', 'NaN', 'Infinity', 'later']) {
    assert.throws(
      () =>
        compileMediaWorkflow(JSON.stringify({ bad: node(type, 1, `Bad [input: order=${order}]`) })),
      /order must be/,
    );
  }
}
assert.deepEqual(
  resolution.controls.map((control) => [control.key, control.type]),
  [
    ['size.aspect_ratio', 'select'],
    ['size.megapixels', 'float'],
  ],
);
assert.deepEqual(resolution.controls[1], {
  key: 'size.megapixels',
  nodeId: 'size',
  input: 'megapixels',
  label: 'Megapixels',
  type: 'float',
  value: 1,
  min: 0.1,
  max: 16,
  step: 0.1,
});
const aspectRatio = resolution.controls[0]!;
assert.equal(aspectRatio.label, 'Aspect ratio');
assert(aspectRatio.type === 'select');
assert.equal(aspectRatio.options.length, 8);
assert(aspectRatio.options.includes('9:16 (Portrait Widescreen)'));
const changedResolution = expandMediaWorkflow(
  resolution,
  { prompt: '', seed: 1, job_id: 'size' },
  {
    'size.aspect_ratio': '9:16 (Portrait Widescreen)',
    'size.megapixels': 2.5,
  },
) as typeof resolutionGraph;
assert.deepEqual(changedResolution.size.inputs, {
  aspect_ratio: '9:16 (Portrait Widescreen)',
  megapixels: 2.5,
  multiple: 32,
});
assert.deepEqual(changedResolution.latent.inputs, resolutionGraph.latent.inputs);
assert.equal(resolutionGraph.size.inputs.megapixels, 1);
const aspectOnly = expandMediaWorkflow(
  resolution,
  { prompt: '', seed: 1, job_id: 'size' },
  {
    'size.aspect_ratio': '1:1 (Square)',
  },
) as typeof resolutionGraph;
assert.equal(aspectOnly.size.inputs.megapixels, 1);
assert.equal(aspectOnly.size.inputs.multiple, 32);
for (const values of [
  { 'size.multiple': 64 },
  { 'size.aspect_ratio': '16:9' },
  { 'size.aspect_ratio': 1 },
  { 'size.megapixels': 0 },
  { 'size.megapixels': 16.1 },
  { 'size.megapixels': '2.5' },
]) {
  assert.throws(() => validateWorkflowValues(resolution.controls, values));
}
for (const inputs of [
  { aspect_ratio: 'unknown', megapixels: 1, multiple: 32 },
  { aspect_ratio: ['other', 0], megapixels: 1, multiple: 32 },
  { aspect_ratio: '1:1 (Square)', megapixels: ['other', 0], multiple: 32 },
]) {
  assert.throws(
    () => compileMediaWorkflow(JSON.stringify({ size: { ...resolutionGraph.size, inputs } })),
    /Invalid default/,
  );
}
const boundedResolution = compileMediaWorkflow(
  JSON.stringify({
    size: {
      ...resolutionGraph.size,
      _meta: { title: 'Resolution [input: min=0.5, max=4, step=0.5]' },
    },
  }),
);
assert.throws(() => validateWorkflowValues(boundedResolution.controls, { 'size.megapixels': 4.5 }));
assert.throws(
  () =>
    compileMediaWorkflow(
      JSON.stringify({
        size: { ...resolutionGraph.size, _meta: { title: 'Resolution [input: max=32]' } },
      }),
    ),
  /0.1–16/,
);
console.log(
  'Workflow controls validate metadata and typed values, preserve strings and wiring, and randomize seeds',
);
