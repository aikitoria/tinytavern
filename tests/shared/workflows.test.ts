import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('media workflow', async () => {
  const {
    compileMediaWorkflow,
    expandMediaWorkflow,
    mediaInputSlots,
    mediaWorkflowError,
    DEFAULT_MEDIA_RENDERING,
    defaultMediaPrompt,
    defaultChatMediaPrompt,
  } = await import('@tinytavern/shared');
  type MediaWorkflow = import('@tinytavern/shared').MediaWorkflow;
  const { parseMediaRendering, parseMediaPrompts } =
    await import('../../server/src/mediaSettings.ts');

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
  assert.equal(
    JSON.stringify(compiled.graph),
    before,
    'Compilation can be reused without mutation',
  );
  assert.equal(
    compileMediaWorkflow(workflow.json),
    compiled,
    'Identical source reuses compilation',
  );
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
});

test('workflow inputs', async () => {
  const { compileMediaWorkflow, expandMediaWorkflow, validateWorkflowValues } =
    await import('@tinytavern/shared');

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
  assert.equal(
    result.text.inputs.value,
    text,
    'User strings are never expanded as workflow macros',
  );
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
          compileMediaWorkflow(
            JSON.stringify({ bad: node(type, 1, `Bad [input: order=${order}]`) }),
          ),
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
  assert.throws(() =>
    validateWorkflowValues(boundedResolution.controls, { 'size.megapixels': 4.5 }),
  );
  assert.throws(
    () =>
      compileMediaWorkflow(
        JSON.stringify({
          size: { ...resolutionGraph.size, _meta: { title: 'Resolution [input: max=32]' } },
        }),
      ),
    /0.1–16/,
  );
});

test('comfy graph progress', async () => {
  const { ComfyGraphProgress } = await import('../../server/src/comfyGraphProgress.ts');

  const progress = new ComfyGraphProgress({
    load: { class_type: 'CheckpointLoader' },
    sampler: { class_type: 'KSampler', _meta: { title: 'Motion sampler' } },
    save: { class_type: 'VHS_VideoCombine' },
  });
  assert.deepEqual(progress.update('execution_start', {})?.graph, { value: 0, max: 3 });
  assert.deepEqual(
    progress.update('execution_cached', { nodes: ['load', 'load', 'unrelated'] })?.graph,
    { value: 1, max: 3 },
  );
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
  assert.deepEqual(
    parent.graph,
    { value: 1, max: 3 },
    'A child finishing does not finish its parent',
  );
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
