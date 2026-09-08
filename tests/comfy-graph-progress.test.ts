import assert from 'node:assert/strict';
import { ComfyGraphProgress } from '../server/src/comfyGraphProgress.ts';

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
console.log(
  'Comfy graph progress counts cached/completed nodes and keeps dynamic node names and steps separate',
);
