import type { MediaWorkflow } from '@tinytavern/shared';

// Supplied Comfy workflow, saved explicitly by the description tests.
export const IMAGE_DESCRIPTION_WORKFLOW_JSON = JSON.stringify(
  {
    '1': {
      inputs: {
        clip_name: 'qwen3.5_4b_bf16.safetensors',
        type: 'stable_diffusion',
        device: 'default',
      },
      class_type: 'CLIPLoader',
      _meta: {
        title: 'Load CLIP',
      },
    },
    '2': {
      inputs: {
        image: 'source.png',
      },
      class_type: 'LoadImage',
      _meta: {
        title: 'Load Image',
      },
    },
    '3': {
      inputs: {
        prompt:
          'Describe this image in extreme detail, including subject appearance, clothing, pose, expression, background elements, lighting, camera angle, composition, color palette, and overall aesthetic style. Use precise, descriptive language suitable for AI image generation prompts. Do not use vague terms. Only return the prompts itself. Focus on 90s retro tech aesthetic and photorealistic quality.',
        max_length: 512,
        sampling_mode: 'on',
        'sampling_mode.temperature': 0.7,
        'sampling_mode.top_k': 64,
        'sampling_mode.top_p': 0.95,
        'sampling_mode.min_p': 0.05,
        'sampling_mode.repetition_penalty': 1.05,
        'sampling_mode.seed': 0,
        'sampling_mode.presence_penalty': 0,
        thinking: false,
        use_default_template: true,
        clip: ['1', 0],
        image: ['2', 0],
      },
      class_type: 'TextGenerate',
      _meta: {
        title: 'Generate Text',
      },
    },
    '4': {
      inputs: {
        source: ['3', 0],
      },
      class_type: 'PreviewAny',
      _meta: {
        title: 'Preview as Text',
      },
    },
  },
  null,
  2,
);

export const IMAGE_DESCRIPTION_WORKFLOW: MediaWorkflow = {
  id: 'image-description',
  name: 'Qwen image description',
  operation: 'image-describe',
  referenceCount: 0,
  json: IMAGE_DESCRIPTION_WORKFLOW_JSON,
  galleryPromptPresetId: null,
  chatPromptPresetId: null,
};
