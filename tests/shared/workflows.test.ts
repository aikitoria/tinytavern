import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('workflows require strict JSON and numbered bindings without filename inference', async () => {
  const {
    compileMediaWorkflow,
    expandMediaWorkflow,
    mediaInputSlots,
    mediaWorkflowError,
    DEFAULT_MEDIA_RENDERING,
    defaultMediaPrompt,
    defaultChatMediaPrompt,
  } = await import('@tinytavern/shared');
  const { parseMediaRendering, parseMediaPrompts } = await import('../../server/src/media/mediaSettings.ts');
  const graph = {
    source: { class_type: 'LoadImage', inputs: { image: 'source.png' } },
    first: { class_type: 'LoadImage', inputs: { image: 'first_frame.png' } },
    reference: { class_type: 'LoadImageMask', inputs: { image: 'samples/reference1.png [input]' } },
    subject: {
      class_type: 'LoadImage',
      inputs: { image: 'reference1.png' },
      _meta: { title: 'Subject [image:input1]' },
    },
    custom: {
      class_type: 'CustomLoader',
      inputs: { filename: 'sample.png' },
      _meta: { title: 'Clothing [image:input2, field=filename]' },
    },
    text: {
      class_type: 'PrimitiveString',
      inputs: { value: 'example' },
      _meta: { title: 'Prompt [prompt]' },
    },
    sampler: { class_type: 'KSampler', inputs: { seed: 0 } },
    linked: { class_type: 'LoadImage', inputs: { image: ['filename', 0] } },
  };
  const workflow = {
    id: 'unusual',
    name: 'Unusual workflow',
    json: JSON.stringify(graph),
    standalonePromptPresetId: null,
    chatPromptPresetId: null,
    textOutputNodeId: null,
    inputBindings: { chat: { input1: 'character-avatar' as const } },
  };
  assert.equal(mediaWorkflowError(workflow), null);
  assert.deepEqual(mediaInputSlots(workflow), ['input1', 'input2']);
  const compiled = compileMediaWorkflow(workflow.json);
  assert.equal(compileMediaWorkflow(workflow.json), compiled);
  const original = JSON.stringify(compiled.graph);
  const prompt = 'Quotes " \\ newline\n literal {{seed}} $&';
  const values = {
    prompt,
    seed: 123,
    job_id: 'job',
    input1: 'subject.webp',
    input2: 'clothing.png',
  };
  const result = expandMediaWorkflow(compiled, values) as typeof graph;
  assert.equal(result.subject.inputs.image, values.input1);
  assert.equal(result.custom.inputs.filename, values.input2);
  assert.equal(result.text.inputs.value, prompt);
  assert.equal(result.sampler.inputs.seed, 123);
  for (const key of ['source', 'first', 'reference', 'linked'] as const) assert.deepEqual(result[key], graph[key]);
  result.subject.inputs.image = 'mutated';
  assert.equal(JSON.stringify(compiled.graph), original);
  assert.equal((expandMediaWorkflow(compiled, values) as typeof graph).subject.inputs.image, values.input1);
  assert.throws(() => expandMediaWorkflow(compiled, { prompt, seed: 1, job_id: 'missing' }), /Missing workflow input/);
  assert.equal(mediaWorkflowError({ ...workflow, textOutputNodeId: 'missing' })?.includes('existing node'), true);
  for (const json of [
    '{"seed":{{seed}}}',
    '{"seed":"{{seed}}"}',
    '{"text":{{prompt}}}',
    '{"{{prompt}}":1}',
    '{"text":"{{reference1}}"}',
    '{"text":"{{source}}"}',
    '{"text":"{{first_frame}}"}',
    '{"text":"{{unknown}}"}',
  ])
    assert.throws(() => compileMediaWorkflow(json), json);
  for (const name of ['subject', 'input0', 'input65', 'input01', 'prompt'])
    assert.throws(() =>
      compileMediaWorkflow(
        JSON.stringify({
          ...graph,
          subject: { ...graph.subject, _meta: { title: `Subject [image:${name}]` } },
        }),
      ),
    );
  const settings = {
    ...DEFAULT_MEDIA_RENDERING,
    workflows: [workflow],
    defaultWorkflowId: workflow.id,
  };
  assert.deepEqual(parseMediaRendering(settings)!.workflows[0], { ...workflow, folderId: null });
  for (const overrides of [
    { folders: [{ id: 'folder', name: 'Missing', workflowIds: ['missing'] }] },
    { folders: [{ id: 'folder', name: 'Duplicate', workflowIds: [workflow.id, workflow.id] }] },
    {
      folders: [
        { id: 'folder', name: 'Same', workflowIds: [] },
        { id: 'other', name: 'same', workflowIds: [] },
      ],
    },
    {
      folders: [
        { id: 'folder', name: 'First', workflowIds: [workflow.id] },
        { id: 'other', name: 'Second', workflowIds: [workflow.id] },
      ],
    },
    { defaultWorkflowId: 'missing' },
    { comfyUrl: 'file:///tmp' },
    { descriptionWorkflowId: workflow.id },
  ]) {
    assert.throws(() => parseMediaRendering({ ...settings, ...overrides }));
  }
  const standalone = { id: 'standalone', name: 'Model instructions', ...defaultMediaPrompt() };
  const chat = { id: 'chat', name: 'Model instructions', chatPrompt: defaultChatMediaPrompt() };
  for (const [preset, key] of [
    [standalone, 'mediaStandalonePrompts'],
    [chat, 'mediaChatPrompts'],
  ] as const) {
    const folder = { id: 'folder', name: 'My prompts' };
    const grouped = { presets: [{ ...preset, folderId: folder.id }], folders: [folder], defaultPresetId: preset.id };
    assert.deepEqual(parseMediaPrompts(grouped, key), grouped);
    assert.throws(() => parseMediaPrompts({ ...grouped, folders: [{ ...folder, presetIds: ['missing'] }] }, key));
  }
  for (const [preset, key] of [
    [standalone, 'mediaChatPrompts'],
    [chat, 'mediaStandalonePrompts'],
  ] as const) {
    assert.throws(
      () => parseMediaPrompts({ presets: [preset], defaultPresetId: null }, key),
      /Unexpected prompt field/,
    );
  }
  const evicted = compileMediaWorkflow('{"1":{"inputs":{"text":"{{prompt}}","tag":"eviction"}}}');
  for (let index = 0; index < 64; index++)
    compileMediaWorkflow(`{"1":{"inputs":{"text":"{{prompt}}","tag":${index}}}}`);
  assert.notEqual(compileMediaWorkflow('{"1":{"inputs":{"text":"{{prompt}}","tag":"eviction"}}}'), evicted);
  assert.deepEqual(expandMediaWorkflow(evicted, { prompt: 'after eviction', seed: 0, job_id: 'retained' }), {
    '1': { inputs: { text: 'after eviction', tag: 'eviction' } },
  });
});

test('workflow inputs', async () => {
  const { compileMediaWorkflow, expandMediaWorkflow, validateWorkflowValues } = await import('@tinytavern/shared');

  const compile = (graph: unknown) => compileMediaWorkflow(JSON.stringify(graph));
  const node = (class_type: string, value: number | string | boolean, title: string) => ({
    class_type,
    inputs: { value },
    _meta: { title },
  });
  const graph = {
    frames: node('PrimitiveInt', 81, 'Frames [input: min=1, max=241, step=4]'),
    duration: node('PrimitiveFloat', 2.5, 'Duration (seconds) [input: min=1, max=10, step=0.5, unit=s]'),
    text: node('PrimitiveStringMultiline', 'soft light', 'Style [input]'),
    sampler: { class_type: 'KSampler', inputs: { seed: 123, text: '{{prompt}}', steps: 20 } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: 456 } },
    seed: node('PrimitiveInt', 999, 'Seed'),
    linked: { class_type: 'KSampler', inputs: { seed: ['seed', 0] } },
    fixed: node('PrimitiveInt', 42, 'Chosen seed [input: min=0]'),
    fixedSampler: { class_type: 'KSampler', inputs: { seed: ['fixed', 0] } },
    toggle: node('PrimitiveBoolean', true, 'Enable upscale [input]'),
  };
  const compiled = compile(graph);
  assert.deepEqual(
    compiled.controls.map((control) => control.label),
    ['Frames', 'Duration (seconds)', 'Style', 'Chosen seed', 'Enable upscale'],
  );
  assert.equal(compiled.controls[1]!.type, 'float');
  assert.equal(compiled.controls[1]!.unit, 's');
  assert.equal(compiled.controls[0]!.unit, undefined, 'Units are optional');
  for (const unit of ['s', 'fps', '%', 'µs']) {
    const annotated = compile({
      custom: node('PrimitiveInt', 10, `Custom measurement [input unit=${unit}]`),
    });
    assert.equal(annotated.controls[0]!.unit, unit);
    assert.equal(annotated.controls[0]!.label, 'Custom measurement');
    assert.deepEqual(validateWorkflowValues(annotated.controls, { custom: 20 }), { custom: 20 });
  }
  for (const title of ['Bad [input: unit=]', 'Bad [input: unit=s, unit=ms]', 'Bad [input: unit=per second]']) {
    assert.throws(() => compile({ bad: node('PrimitiveInt', 10, title) }));
  }
  assert.throws(
    () => compile({ toggle: node('PrimitiveBoolean', true, 'Enabled [input: unit=s]') }),
    /Unknown boolean parameter unit/,
  );
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
    assert.throws(() => compile({ frames: node('PrimitiveInt', 81, title) }), title);
  }
  assert.throws(
    () => compile({ text: node('PrimitiveString', 'hello', 'Text [input: step=1]') }),
    /Unknown string parameter/,
  );
  assert.throws(() => compile({ node: node('KSampler', 1, 'Sampler [input]') }), /constant node/);
  assert.throws(() => compile({ text: node('PrimitiveString', '{{prompt}}', 'Prompt [input]') }), /literal default/);
  assert.throws(
    () => compile({ ...graph, frames: { ...graph.frames, inputs: { value: ['seed', 0] } } }),
    /Invalid default/,
  );
  for (const classType of [
    'PrimitiveString',
    'PrimitiveStringMultiline',
    'StringConstant',
    'StringConstantMultiline',
  ]) {
    const input = classType.startsWith('Primitive') ? 'value' : 'string';
    const textWorkflow = compile({
      text: {
        class_type: classType,
        inputs: { [input]: '' },
        _meta: { title: 'Text [input]' },
      },
    });
    const control = textWorkflow.controls[0]!;
    assert(control.type === 'string');
    assert.equal(control.multiline, classType.endsWith('Multiline'));
    assert.deepEqual(validateWorkflowValues(textWorkflow.controls, { text: '' }), { text: '' });
    const longText = 'x'.repeat(200001) + '\nSecond line';
    const expanded = expandMediaWorkflow(
      textWorkflow,
      { prompt: '', seed: 1, job_id: 'text' },
      { text: longText },
    ) as Record<string, { inputs: Record<string, string> }>;
    assert.equal(expanded.text!.inputs[input], longText, 'Workflow text has no per-field maximum or truncation');
  }

  const resolutionGraph = {
    size: {
      class_type: 'ResolutionSelector',
      inputs: { aspect_ratio: '16:9 (Widescreen)', megapixels: 1, multiple: 32 },
      _meta: { title: 'Resolution [input]' },
    },
    latent: { class_type: 'EmptyLatentImage', inputs: { width: ['size', 0], height: ['size', 1] } },
  };
  const resolution = compile(resolutionGraph);
  assert.equal(resolution.controls[0]!.unit, undefined, 'Aspect ratios have no numeric unit');
  assert.equal(resolution.controls[1]!.unit, 'MP', 'Resolution supplies its built-in display unit');
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
  const ordered = compile(orderedGraph);
  assert.deepEqual(
    ordered.controls.map((control) => control.key),
    ['5', '3', '4.aspect_ratio', '4.megapixels', '2', '1', '6'],
    'Explicit order sorts across control types, keeps ties stable and resolution fields together, then appends unordered fields',
  );
  assert.deepEqual(ordered.graph, orderedGraph, 'Display order does not change node IDs or inputs');
  for (const order of ['1.5', 'NaN', 'Infinity', 'later']) {
    assert.throws(() => compile({ bad: node('PrimitiveInt', 1, `Bad [input: order=${order}]`) }), /order must be/);
  }
  // Both overrides and omitted defaults preserve the latent's wiring and fixed multiple.
  for (const [aspect, megapixels] of [
    ['9:16 (Portrait Widescreen)', 2.5],
    ['1:1 (Square)', undefined],
  ] as const) {
    const values = {
      'size.aspect_ratio': aspect,
      ...(megapixels === undefined ? {} : { 'size.megapixels': megapixels }),
    };
    const expanded = expandMediaWorkflow(
      resolution,
      { prompt: '', seed: 1, job_id: 'size' },
      values,
    ) as typeof resolutionGraph;
    assert.deepEqual(expanded.size.inputs, {
      aspect_ratio: aspect,
      megapixels: megapixels ?? 1,
      multiple: 32,
    });
    assert.deepEqual(expanded.latent, resolutionGraph.latent);
  }
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
    assert.throws(() => compile({ size: { ...resolutionGraph.size, inputs } }), /Invalid default/);
  }
  const boundedResolution = compile({
    size: {
      ...resolutionGraph.size,
      _meta: { title: 'Resolution [input: min=0.5, max=4, step=0.5]' },
    },
  });
  assert.throws(() => validateWorkflowValues(boundedResolution.controls, { 'size.megapixels': 4.5 }));
  assert.throws(
    () =>
      compile({
        size: { ...resolutionGraph.size, _meta: { title: 'Resolution [input: max=32]' } },
      }),
    /0.1–16/,
  );
});

test('comfy graph progress', async () => {
  const { ComfyGraphProgress } = await import('../../server/src/media/comfy/comfyGraphProgress.ts');

  const progress = new ComfyGraphProgress({
    load: { class_type: 'CheckpointLoader' },
    sampler: { class_type: 'KSampler', _meta: { title: 'Motion sampler' } },
    save: { class_type: 'VHS_VideoCombine' },
  });
  assert.deepEqual(progress.update('execution_start', {})?.graph, { value: 0, max: 3 });
  assert.deepEqual(progress.update('execution_cached', { nodes: ['load', 'load', 'unrelated'] })?.graph, {
    value: 1,
    max: 3,
  });
  assert.deepEqual(progress.update('executing', { node: 'sampler' })?.node, {
    id: 'sampler',
    name: 'Motion sampler',
  });
  const sampling = progress.update('progress_state', {
    nodes: {
      sampler: { state: 'running', value: 4, max: 20 },
    },
  })!;
  assert.equal(sampling.value, 4);
  assert.equal(sampling.max, 20);
  assert.deepEqual(sampling.graph, { value: 1, max: 3 });
  progress.update('executing', { node: 'expanded-child', display_node: 'sampler' });
  const child = progress.update('progress', { node: 'expanded-child', value: 5, max: 20 })!;
  assert.equal(child.node!.name, 'Motion sampler', 'Expanded nodes keep the workflow display name');
  const parent = progress.update('progress_state', {
    nodes: {
      'expanded-child': { state: 'finished', value: 20, max: 20, display_node_id: 'sampler' },
      sampler: { state: 'running', value: 1, max: 2 },
    },
  })!;
  assert.deepEqual(parent.graph, { value: 1, max: 3 }, 'A child finishing does not finish its parent');
  const save = progress.update('progress_state', {
    nodes: {
      sampler: { state: 'finished', value: 20, max: 20 },
      save: { state: 'running', value: 0, max: 1 },
    },
  })!;
  assert.deepEqual(save.graph, { value: 2, max: 3 });
  assert.equal(save.node!.name, 'VHS_VideoCombine');
  assert.equal(save.value, 0, 'Sampler steps do not leak into the next node');
  assert.deepEqual(progress.update('execution_success', {})?.graph, { value: 3, max: 3 });
  assert.equal(progress.update('status', {}), null);
});

test('numbered bindings sort numerically, share images and retain sparse numbers', async () => {
  const { compileMediaWorkflow, expandMediaWorkflow } = await import('@tinytavern/shared');
  const graph = {
    last: {
      class_type: 'LoadImage',
      inputs: { image: 'sample.png' },
      _meta: { title: 'Style [image:input64]' },
    },
    second: {
      class_type: 'LoadImage',
      inputs: { image: 'sample.png' },
      _meta: { title: 'Subject [image:input2]' },
    },
    mask: {
      class_type: 'LoadImageMask',
      inputs: { image: 'sample.png' },
      _meta: { title: 'Subject [image:input2]' },
    },
  };
  const json = JSON.stringify(graph);
  const compiled = compileMediaWorkflow(json);
  assert.deepEqual(compiled.mediaInputs, [
    { name: 'input2', label: 'Subject', kind: 'image' },
    { name: 'input64', label: 'Style', kind: 'image' },
  ]);
  const expanded = expandMediaWorkflow(compiled, {
    prompt: '',
    seed: 0,
    job_id: 'job',
    input2: 'subject.webp',
    input64: 'style.png',
  }) as typeof graph;
  assert.equal(expanded.second.inputs.image, 'subject.webp');
  assert.equal(expanded.mask.inputs.image, 'subject.webp');
  assert.equal(expanded.last.inputs.image, 'style.png');
  const workflow = {
    id: 'sparse',
    name: 'Sparse',
    json,
    inputBindings: {},
    standalonePromptPresetId: null,
    chatPromptPresetId: null,
    textOutputNodeId: null,
  };
  assert.equal(compileMediaWorkflow(workflow.json), compiled);
  for (const invalid of ['input0', 'input65', 'input01'])
    assert.throws(() => compileMediaWorkflow(json.replaceAll('input64', invalid)), /input1 through input64/);
});

test('video bindings share numbered slots while preserving types, loader fields and graph links', async () => {
  const { compileMediaWorkflow, expandMediaWorkflow, mediaWorkflowError } = await import('@tinytavern/shared');
  const graph = {
    video: {
      class_type: 'LoadVideo',
      inputs: { file: 'sample.webm' },
      _meta: { title: 'Clip [video:input1]' },
    },
    repeat: { class_type: 'LoadVideo', inputs: { file: '{{input1}}' } },
    image: {
      class_type: 'LoadImage',
      inputs: { image: 'sample.png' },
      _meta: { title: 'Style [image:input2]' },
    },
    components: { class_type: 'GetVideoComponents', inputs: { video: ['video', 0] } },
  };
  const compiled = compileMediaWorkflow(JSON.stringify(graph));
  assert.deepEqual(compiled.mediaInputs, [
    { name: 'input1', label: 'Clip', kind: 'video' },
    { name: 'input2', label: 'Style', kind: 'image' },
  ]);
  const expanded = expandMediaWorkflow(compiled, {
    prompt: '',
    seed: 1,
    job_id: 'job',
    input1: 'original.webm',
    input2: 'style.webp',
  }) as typeof graph;
  assert.equal(expanded.video!.inputs.file, 'original.webm');
  assert.equal(expanded.repeat!.inputs.file, 'original.webm');
  assert.equal(expanded.image!.inputs.image, 'style.webp');
  assert.deepEqual(expanded.components!.inputs.video, ['video', 0]);
  assert.throws(
    () =>
      compileMediaWorkflow(
        JSON.stringify({
          ...graph,
          conflict: { class_type: 'LoadImage', inputs: { image: '{{input1}}' } },
        }),
      ),
    /both image and video/,
  );
  assert.throws(
    () => compileMediaWorkflow(JSON.stringify({ video: { ...graph.video, inputs: { file: ['other', 0] } } })),
    /literal string/,
  );
  const workflow = {
    id: 'video',
    name: 'Video',
    json: JSON.stringify(graph),
    inputBindings: { standalone: { input1: 'selected:1' as const } },
    standalonePromptPresetId: null,
    chatPromptPresetId: null,
    textOutputNodeId: null,
  };
  assert.equal(mediaWorkflowError(workflow), null);
  assert.match(
    mediaWorkflowError({
      ...workflow,
      inputBindings: { standalone: { input1: 'character-avatar' } },
    })!,
    /not an avatar/,
  );
});
