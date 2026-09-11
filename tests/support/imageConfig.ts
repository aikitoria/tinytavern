import { getSettings, putSettings } from '../../server/src/settings/settingsStore.ts';
import type { MediaImageConfig } from '@tinytavern/shared';

export function imageConfig(json: string, comfyUrl: string): MediaImageConfig {
  const config: MediaImageConfig = {
    comfyUrl,
    workflow: {
      id: 'test-image-workflow',
      name: 'Test image workflow',
      inputBindings: {},
      textOutputNodeId: null,
      json,
      standalonePromptPresetId: null,
      chatPromptPresetId: null,
    },
  };
  const settings = getSettings();
  putSettings({
    ...settings,
    mediaRendering: {
      ...settings.mediaRendering,
      workflows: [
        ...settings.mediaRendering.workflows.filter((w) => w.id !== config.workflow.id),
        config.workflow,
      ],
    },
  });
  return config;
}
