import assert from 'node:assert/strict';
import { compileMediaWorkflow } from '@tinytavern/shared';
import { imageWorkflowDefaults } from '../client/src/media/workflowDefaults.ts';

const { controls } = compileMediaWorkflow(
  JSON.stringify({
    resolution: {
      class_type: 'ResolutionSelector',
      _meta: { title: 'Resolution [input]' },
      inputs: { aspect_ratio: '1:1 (Square)', megapixels: 1 },
    },
  }),
);

for (const [width, height, expected] of [
  [1344, 768, '16:9 (Widescreen)'],
  [768, 1344, '9:16 (Portrait Widescreen)'],
  [1024, 1024, '1:1 (Square)'],
  [1200, 800, '3:2 (Photo)'],
  [800, 1200, '2:3 (Portrait Photo)'],
  [1920, 800, '21:9 (Ultrawide)'],
] as const) {
  assert.deepEqual(imageWorkflowDefaults(controls, { width, height }), {
    'resolution.aspect_ratio': expected,
  });
}
assert.deepEqual(imageWorkflowDefaults(controls, { width: null, height: null }), {});
assert.deepEqual(imageWorkflowDefaults(controls, { width: 100, height: 0 }), {});
assert.deepEqual(imageWorkflowDefaults([], { width: 1344, height: 768 }), {});
assert.equal(controls.find((control) => control.input === 'megapixels')?.value, 1);
console.log('Media workflow aspect-ratio defaults passed');
