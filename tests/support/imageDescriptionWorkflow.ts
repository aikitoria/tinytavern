import type { MediaWorkflow } from '@tinytavern/shared';

// Supplied Comfy workflow, saved explicitly by the description tests.
export const IMAGE_DESCRIPTION_WORKFLOW_JSON = JSON.stringify(
  {
    '2': {
      inputs: {
        image: 'source.png',
      },
      class_type: 'LoadImage',
      _meta: { title: 'Image [image:input1]' },
    },
    '3': {
      inputs: {
        prompt: 'Describe this image.',
        'sampling_mode.seed': 0,
        image: ['2', 0],
      },
      class_type: 'TextGenerate',
    },
    '4': {
      inputs: {
        source: ['3', 0],
      },
      class_type: 'PreviewAny',
    },
  },
  null,
  2,
);

export const IMAGE_DESCRIPTION_WORKFLOW: MediaWorkflow = {
  id: 'image-description',
  name: 'Qwen image description',
  inputBindings: { standalone: { input1: 'selected:1' } },
  textOutputNodeId: '4',
  json: IMAGE_DESCRIPTION_WORKFLOW_JSON,
  standalonePromptPresetId: null,
  chatPromptPresetId: null,
};
