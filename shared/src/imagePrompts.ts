import type { MediaPromptPreset } from './media.ts';

const IMAGE_CHAT_PROMPTS = {
  describe:
    "[System Note]\nDescribe {{char}}'s current appearance and surroundings as a single detailed image-generation prompt. Reply with only the prompt.",
  characterInstruction:
    "[System Note]\nDescribe {{char}}'s current appearance and surroundings as a single detailed image-generation prompt. Apply this instruction: {{instruction}}. Reply with only the prompt.",
  face: "[System Note]\nDescribe {{char}}'s face and current appearance as a single detailed close-up portrait image-generation prompt. Focus on facial features, hair, expression, and lighting. Reply with only the prompt.",
  faceInstruction:
    "[System Note]\nDescribe {{char}}'s face and current appearance as a single detailed close-up portrait image-generation prompt. Focus on facial features, hair, expression, and lighting, and apply this instruction: {{instruction}}. Reply with only the prompt.",
  instruction: '[System Note]\n{{instruction}}',
};

export const DEFAULT_MEDIA_CHAT_PRESETS: MediaPromptPreset[] = [
  {
    id: 'character',
    name: 'Character',
    chatPrompt: `{{#if instruction}}${IMAGE_CHAT_PROMPTS.characterInstruction}{{/if}}{{#if no_instruction}}${IMAGE_CHAT_PROMPTS.describe}{{/if}}`,
  },
  {
    id: 'face',
    name: 'Face',
    chatPrompt: `{{#if instruction}}${IMAGE_CHAT_PROMPTS.faceInstruction}{{/if}}{{#if no_instruction}}${IMAGE_CHAT_PROMPTS.face}{{/if}}`,
  },
  { id: 'generic', name: 'Generic media', chatPrompt: IMAGE_CHAT_PROMPTS.instruction },
];
