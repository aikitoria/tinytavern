import assert from 'node:assert/strict';
import type { MediaWorkflow } from '@tinytavern/shared';
import { resultWorkflowDetails } from '../client/src/media/resultWorkflowDetails.ts';

const workflowSnapshot: MediaWorkflow = {
  id: 'video',
  name: 'Captured video',
  operation: 'video',
  referenceCount: 0,
  galleryPromptPresetId: null,
  chatPromptPresetId: null,
  json: JSON.stringify({
    duration: {
      class_type: 'PrimitiveInt',
      _meta: { title: 'Duration [input]' },
      inputs: { value: 5 },
    },
    strength: {
      class_type: 'PrimitiveFloat',
      _meta: { title: 'Strength [input]' },
      inputs: { value: 1 },
    },
    enabled: {
      class_type: 'PrimitiveBoolean',
      _meta: { title: 'Enabled [input]' },
      inputs: { value: true },
    },
    text: {
      class_type: 'PrimitiveString',
      _meta: { title: 'Text [input]' },
      inputs: { value: 'default' },
    },
    resolution: {
      class_type: 'ResolutionSelector',
      _meta: { title: 'Resolution [input]' },
      inputs: { aspect_ratio: '1:1 (Square)', megapixels: 1 },
    },
  }),
};
const job = {
  workflowSnapshot,
  workflowValues: { strength: 0, enabled: false, text: '', 'resolution.megapixels': 2 },
  seed: 0,
};
const details = resultWorkflowDetails(job);
assert.equal(details.name, 'Captured video');
assert.equal(details.seed, 0);
assert.equal(details.available, true);
assert.deepEqual(details.parameters, [
  { label: 'Duration', value: '5' },
  { label: 'Strength', value: '0' },
  { label: 'Enabled', value: 'Off' },
  { label: 'Text', value: '(empty)' },
  { label: 'Aspect ratio', value: '1:1 (Square)' },
  { label: 'Megapixels', value: '2' },
]);
job.workflowValues.strength = 9;
workflowSnapshot.name = 'Changed later';
assert.equal(details.name, 'Captured video', 'Open details retain their selected result snapshot');
assert.equal(details.parameters[1]!.value, '0');

for (const snapshot of [null, { ...workflowSnapshot, json: 'invalid' }]) {
  const fallback = resultWorkflowDetails({
    workflowSnapshot: snapshot,
    workflowValues: { duration: 7 },
    seed: null,
  });
  assert.equal(fallback.available, false);
  assert.equal(fallback.seed, null);
  assert.deepEqual(fallback.parameters, [{ label: 'duration', value: '7' }]);
}
assert.deepEqual(
  resultWorkflowDetails({
    workflowSnapshot: { ...workflowSnapshot, json: '{}' },
    workflowValues: {},
    seed: 12,
  }).parameters,
  [],
);
console.log(
  'Result details retain captured defaults, overrides and seed, including unavailable workflows.',
);
