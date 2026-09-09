import type { ImageGenerationSettings } from './index.ts';
import type { MediaOperation } from './media.ts';

export const DEFAULT_IMAGE_CHAT_PROMPTS = {
  describe:
    "[System Note]\nDescribe {{char}}'s current appearance and surroundings as a single detailed image-generation prompt. Reply with only the prompt.",
  characterInstruction:
    "[System Note]\nDescribe {{char}}'s current appearance and surroundings as a single detailed image-generation prompt. Apply this instruction: {{instruction}}. Reply with only the prompt.",
  face: "[System Note]\nDescribe {{char}}'s face and current appearance as a single detailed close-up portrait image-generation prompt. Focus on facial features, hair, expression, and lighting. Reply with only the prompt.",
  faceInstruction:
    "[System Note]\nDescribe {{char}}'s face and current appearance as a single detailed close-up portrait image-generation prompt. Focus on facial features, hair, expression, and lighting, and apply this instruction: {{instruction}}. Reply with only the prompt.",
  instruction: '[System Note]\n{{instruction}}',
  references:
    '[System Note]\nUse the preceding conversation and any reference-image descriptions below to write a detailed image-generation prompt for rendering with reference images. Apply this instruction: {{instruction}}. Return only the complete final prompt.\n{{#if reference1_prompt}}\nReference image 1: {{reference1_prompt}}\n{{/if}}{{#if reference2_prompt}}\nReference image 2: {{reference2_prompt}}\n{{/if}}{{#if reference3_prompt}}\nReference image 3: {{reference3_prompt}}\n{{/if}}',
};

export type ImageChatPromptKind = keyof typeof DEFAULT_IMAGE_CHAT_PROMPTS;

const LABELS: Record<ImageChatPromptKind, string> = {
  describe: 'Character',
  characterInstruction: 'Character',
  face: 'Face',
  faceInstruction: 'Face',
  instruction: 'Generic image',
  references: 'Image from references',
};

export interface ChatImagePromptPreset {
  id: string;
  name: string;
  prompt: string;
}

function presetId(kind: ImageChatPromptKind, name?: string): string {
  return `chat-image/${kind}${name === undefined ? '' : `/${encodeURIComponent(name)}`}`;
}

/** The existing chat image commands and tool page share these settings and defaults. */
export function chatImagePromptPresets(
  settings: ImageGenerationSettings,
  hasInstruction: boolean,
  operation: MediaOperation = 'image',
): ChatImagePromptPreset[] {
  const result: ChatImagePromptPreset[] = [];
  const kinds: ImageChatPromptKind[] =
    operation === 'image-edit'
      ? ['references']
      : hasInstruction
        ? ['characterInstruction', 'faceInstruction', 'instruction']
        : ['describe', 'face', 'instruction'];
  for (const kind of kinds) {
    result.push({
      id: presetId(kind),
      name: `${LABELS[kind]} — Default`,
      prompt: DEFAULT_IMAGE_CHAT_PROMPTS[kind],
    });
    for (const preset of settings.promptPresets?.[kind]?.presets ?? []) {
      result.push({
        id: presetId(kind, preset.name),
        name: `${LABELS[kind]} — ${preset.name}`,
        prompt: preset.prompt,
      });
    }
  }
  return result;
}

/** Plain images match /imagechar; reference images use their own active preset. */
export function defaultChatImagePrompt(
  settings: ImageGenerationSettings,
  instruction: string,
  operation: MediaOperation = 'image',
): ChatImagePromptPreset {
  const kind =
    operation === 'image-edit'
      ? 'references'
      : instruction.trim()
        ? 'characterInstruction'
        : 'describe';
  const selection = settings.promptPresets?.[kind];
  const active = selection?.presets.find((preset) => preset.name === selection.active);
  return {
    id: presetId(kind, active?.name),
    name: `${LABELS[kind]} — ${active?.name ?? 'Default'}`,
    prompt: active?.prompt ?? DEFAULT_IMAGE_CHAT_PROMPTS[kind],
  };
}
