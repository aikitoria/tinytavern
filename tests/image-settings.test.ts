import assert from 'node:assert/strict';
import { parseImageGenerationSettings } from '../server/src/imageSettings.ts';
import { imageRevisionTemplateError } from '@tinytavern/shared';

const valid = {
  promptPresets: {
    avatar: {
      active: 'Portrait',
      presets: [{ name: 'Portrait', prompt: 'Describe', context: '{{description}}' }],
    },
  },
};
assert.equal(parseImageGenerationSettings(valid), valid);
assert.equal(parseImageGenerationSettings(undefined), undefined);

for (const invalid of [
  null,
  [],
  'nope',
  { comfyUrl: 'http://comfy:8588' },
  { describePrompt: 'Unsupported field' },
  { promptRevisionTemplate: 123 },
  { promptRevisionTemplate: 'missing instruction' },
  { workflows: {} },
  { workflows: [null] },
  { workflows: [{ name: 'Broken', json: {} }] },
  { promptPresets: [] },
  { promptPresets: { avatar: null } },
  { promptPresets: { avatar: { active: false, presets: [] } } },
  { promptPresets: { avatar: { active: '', presets: 'broken' } } },
  { promptPresets: { avatar: { active: '', presets: [null] } } },
  { promptPresets: { avatar: { active: '', presets: [{ name: 'A', prompt: 1 }] } } },
  { promptPresets: { avatar: { active: '', presets: [{ name: 'A', prompt: '', context: 1 }] } } },
]) {
  assert.throws(() => parseImageGenerationSettings(invalid), { status: 400 });
}
assert.equal(imageRevisionTemplateError('Revise: {{INSTRUCTION}}'), null);
assert.ok(imageRevisionTemplateError('No instruction slot'));
assert.deepEqual(
  parseImageGenerationSettings({ promptRevisionTemplate: 'Apply {{instruction}}' }),
  {
    promptRevisionTemplate: 'Apply {{instruction}}',
  },
);
console.log('Image settings validation regressions passed');

for (const invalid of [
  { promptRevisionOriginal: 'Missing source slot' },
  { promptRevisionContext: 1 },
  {
    promptPresets: {
      avatar: { active: 'Portrait', presets: [{ name: 'Portrait', prompt: 'Avatar' }] },
    },
  },
]) {
  assert.throws(() => parseImageGenerationSettings(invalid), { status: 400 });
}
assert.deepEqual(parseImageGenerationSettings({ promptRevisionContext: '' }), {
  promptRevisionContext: '',
});
