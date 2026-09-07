import assert from 'node:assert/strict';
import {
  parseImageGenerationSettings,
  parseGalleryRevisionTemplate,
} from '../server/src/imageSettings.ts';
import { DEFAULT_GALLERY_REVISION_TEMPLATE, imageRevisionTemplateError } from '@tinytavern/shared';

const valid = {
  comfyUrl: 'http://comfy:8588',
  workflows: [{ name: 'Default', json: '{"prompt":"{{prompt}}"}' }],
  activeWorkflow: 'Default',
  avatarWorkflow: '',
  promptPresets: {
    avatar: {
      active: 'Portrait',
      presets: [{ name: 'Portrait', prompt: 'Describe', context: '{{description}}' }],
    },
  },
};
assert.equal(parseImageGenerationSettings(valid), valid);
assert.equal(parseImageGenerationSettings(undefined), undefined);
assert.deepEqual(parseImageGenerationSettings({ describePrompt: 'Legacy custom prompt' }), {
  describePrompt: 'Legacy custom prompt',
});

for (const invalid of [
  null,
  [],
  'nope',
  { comfyUrl: 123 },
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
  parseGalleryRevisionTemplate(DEFAULT_GALLERY_REVISION_TEMPLATE),
  DEFAULT_GALLERY_REVISION_TEMPLATE,
);
for (const invalid of [
  null,
  [],
  {},
  { ...DEFAULT_GALLERY_REVISION_TEMPLATE, reasoningPrefill: false },
  { ...DEFAULT_GALLERY_REVISION_TEMPLATE, userMessage: '' },
  { ...DEFAULT_GALLERY_REVISION_TEMPLATE, userMessage: '{{prompt}}' },
  { ...DEFAULT_GALLERY_REVISION_TEMPLATE, userMessage: '{{instruction}}' },
]) {
  assert.throws(() => parseGalleryRevisionTemplate(invalid), { status: 400 });
}
assert.deepEqual(
  parseImageGenerationSettings({ promptRevisionTemplate: 'Apply {{instruction}}' }),
  {
    promptRevisionTemplate: 'Apply {{instruction}}',
  },
);
console.log('Image settings validation regressions passed');
