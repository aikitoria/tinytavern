import type { MediaImageConfig } from '@tinytavern/shared';

export function imageConfig(json: string, comfyUrl: string): MediaImageConfig {
  return {
    comfyUrl,
    workflow: {
      id: 'test-image-workflow',
      name: 'Test image workflow',
      operation: 'image',
      referenceCount: 0,
      json,
      galleryPromptPresetId: null,
      chatPromptPresetId: null,
    },
  };
}
