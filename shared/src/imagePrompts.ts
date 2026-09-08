import type { ImageGenerationSettings } from './index.ts';

export const DEFAULT_IMAGE_CHAT_PROMPTS = {
  describe:
    "[System Note]\nDescribe {{char}}'s current appearance and surroundings as a single detailed image-generation prompt. Reply with only the prompt.",
  characterInstruction:
    "[System Note]\nDescribe {{char}}'s current appearance and surroundings as a single detailed image-generation prompt. Apply this instruction: {{instruction}}. Reply with only the prompt.",
  face: "[System Note]\nDescribe {{char}}'s face and current appearance as a single detailed close-up portrait image-generation prompt. Focus on facial features, hair, expression, and lighting. Reply with only the prompt.",
  faceInstruction:
    "[System Note]\nDescribe {{char}}'s face and current appearance as a single detailed close-up portrait image-generation prompt. Focus on facial features, hair, expression, and lighting, and apply this instruction: {{instruction}}. Reply with only the prompt.",
  instruction: '[System Note]\n{{instruction}}',
};

export type ImageChatPromptKind = keyof typeof DEFAULT_IMAGE_CHAT_PROMPTS;

const LABELS: Record<ImageChatPromptKind, string> = {
  describe: 'Character',
  characterInstruction: 'Character',
  face: 'Face',
  faceInstruction: 'Face',
  instruction: 'Generic image',
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
): ChatImagePromptPreset[] {
  const result: ChatImagePromptPreset[] = [];
  const kinds: ImageChatPromptKind[] = hasInstruction
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

/** Matches /imagechar: the instruction chooses the corresponding character preset set. */
export function defaultChatImagePrompt(
  settings: ImageGenerationSettings,
  instruction: string,
): ChatImagePromptPreset {
  const kind = instruction.trim() ? 'characterInstruction' : 'describe';
  const selection = settings.promptPresets?.[kind];
  const active = selection?.presets.find((preset) => preset.name === selection.active);
  return {
    id: presetId(kind, active?.name),
    name: `${LABELS[kind]} — ${active?.name ?? 'Default'}`,
    prompt: active?.prompt ?? DEFAULT_IMAGE_CHAT_PROMPTS[kind],
  };
}
