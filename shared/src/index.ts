export { readSseData } from './sse.ts';
export * from './media.ts';
export * from './imagePrompts.ts';
export * from './settingsTransfer.ts';
import { DEFAULT_MEDIA_RENDERING, DEFAULT_MEDIA_PROMPTS } from './media.ts';
import type { MediaAsset, MediaRenderingSettings, MediaPromptSettings, MediaJob } from './media.ts';

/** 'tool' messages are tool output shown in the chat but excluded from prompt history. */
export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type MessageStatus = 'done' | 'streaming' | 'error' | 'stopped';
export type GenerationKind = 'normal' | 'speculative';

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max';

export interface GenParams {
  temperature?: number;
  topP?: number;
  minP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  /** Sent verbatim as reasoning_effort; unset = field omitted (backend default). */
  reasoningEffort?: ReasoningEffort;
}

export interface GenMeta {
  error?: string;
  /** Image render failure (the text generation itself succeeded). */
  imageError?: string;
}

export interface Message {
  id: number;
  conversationId: number;
  parentId: number | null;
  role: Role;
  content: string;
  reasoning: string | null;
  /** Assistant speaker name or tool label; null = character default. */
  name: string | null;
  status: MessageStatus;
  activeChildId: number | null;
  model: string | null;
  genMeta: GenMeta | null;
  generationKind: GenerationKind;
  /** Generation attempt-group identity; changes on in-place continuation. */
  generationToken: number | null;
  /** Ordered image/video alternatives, swipeable within the message. */
  media: MediaAsset[];
  /** Server-persisted index into media. */
  activeImage: number;
  imagePending: boolean;
  /** A stored render config permits generating more images. */
  hasImageRender: boolean;
  createdAt: number;
}

/** Gallery-owned image copy; source links are metadata, so source deletion preserves it. */
export interface GalleryItem {
  id: number;
  characters: { id: number; name: string }[];
  /** Snapshotted when saved so grouping survives character deletion. */
  characterName: string;
  sourceConversationId: number | null;
  sourceMessageId: number | null;
  /** Original message image path, used only to recognize an already-saved swipe. */
  sourceImage: string | null;
  prompt: string;
  image: string;
  imageWidth: number | null;
  imageHeight: number | null;
  media?: MediaAsset;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation {
  id: number;
  title: string;
  characterId: number | null;
  personaId: number | null;
  /** Endpoint override for this conversation; null = the global active endpoint. */
  endpointId: number | null;
  /** Current assistant speaker name (set via /char); null = character's name. */
  speakerName: string | null;
  /** Scenario override for this conversation; null = the character's scenario. */
  scenarioOverride: string | null;
  activeLeafId: number | null;
  /** Monotonic optimistic-concurrency token for conversation state. */
  mutationRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface Character {
  id: number;
  name: string;
  /** Optional in-chat name for {{char}} and default assistant speaker labels. */
  chatName: string | null;
  /** Optional one-level grouping in character pickers. */
  folderId: number | null;
  avatar: string | null;
  avatarThumbnail?: string | null;
  personality: string;
  scenario: string;
  /** SillyTavern mes_example -> {{examples}}; users supply separators such as <START>. */
  examples: string;
  firstMessage: string;
  presetId: number | null;
  customPrompt: string | null;
  templateId: number | null;
  /** Inline template override; replaces templateId with the same settings. */
  customTemplate: CustomTemplate | null;
  /** Opt out of background swipes even when the global setting is enabled. */
  disableBackgroundSwipeGeneration: boolean;
  createdAt: number;
}

/** UI lists use Character.name; chat speakers and character macros use this name. */
export function characterChatName(
  character: Pick<Character, 'name' | 'chatName'> | null | undefined,
): string {
  return character?.chatName?.trim() || character?.name || 'Assistant';
}

export interface CharacterFolder {
  id: number;
  name: string;
  createdAt: number;
}

export interface CustomTemplate {
  /** Template for the system message. */
  content: string;
  /** Fake first user message; empty = omitted. */
  userPrologue: string;
  /** Seeds the final assistant turn's reasoning; empty = no prefill. */
  reasoningPrefill: string;
  /** Seeds the final assistant turn's visible content; empty = no prefill. */
  messagePrefill: string;
  /** Prefix speaker names into message contents ("User: …", "Char: …") and prefill "Char:" for the reply. */
  prefixNames: boolean;
  /** When false, chats using this template ignore personas entirely ({{user}} = "User"). */
  usesPersonas: boolean;
  /** Expands {{instruction}} for this regeneration only. */
  steerTemplate: string;
  /** Speaker handoff when prefills are disabled; empty = no note. */
  speakerHandoffTemplate: string;
}

export interface Preset {
  id: number;
  readOnly: boolean;
  name: string;
  content: string;
  createdAt: number;
}

export interface Template extends CustomTemplate {
  id: number;
  readOnly: boolean;
  name: string;
  createdAt: number;
}

export interface Persona {
  id: number;
  name: string;
  avatar: string | null;
  avatarThumbnail?: string | null;
  description: string;
  createdAt: number;
}

export interface Endpoint {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Whether a secret is stored; the secret itself is never returned by the API. */
  hasApiKey: boolean;
  models: string[];
  /** Null omits the model field, letting the endpoint choose. */
  model: string | null;
  genParams: GenParams;
  /** 'none' uses a trailing message; 'vllm' uses continue_final_message; 'deepseek' uses prefix. */
  prefillMode: 'disabled' | 'none' | 'vllm' | 'deepseek';
  createdAt: number;
}

/** Saved image-generation overrides; omitted fields use the built-in defaults. */
export interface ImageGenerationSettings {
  /** One global revision instruction for image prompts inside chats. */
  promptRevisionTemplate: string;
  promptRevisionContext: string;
  promptRevisionOriginal: string;
  promptPresets?: Record<
    string,
    {
      presets: { name: string; prompt: string; context?: string }[];
      active: string;
    }
  >;
}

export interface StandalonePromptTemplate {
  systemPrompt: string;
  userMessage: string;
  reasoningPrefill: string;
  messagePrefill: string;
}

export interface Settings {
  /** Monotonic server revision used to reject stale cross-device writes. */
  revision: number;
  defaultPresetId: number | null;
  activeEndpointId: number | null;
  defaultPersonaId: number | null;
  defaultTemplateId: number | null;
  /** Auto-expand the thinking block while a model reasons with no answer text yet. */
  autoExpandThinking: boolean;
  /** Maximum thumbnail dimension in pixels; saving a change rebuilds gallery thumbnails. */
  galleryThumbnailSize: number;
  titlePrompt: string;
  draftCompletionPrompt: string;
  /** Keep one unread assistant sibling prepared ahead of the active reply. */
  backgroundSwipeGeneration: boolean;
  /** Allow the one unread swipe to generate concurrently with the active reply. */
  parallelBackgroundSwipeGeneration: boolean;
  /** Whether the server has an access password. The password itself is never returned. */
  hasPassword: boolean;
  imageGeneration: ImageGenerationSettings;
  mediaRendering: MediaRenderingSettings;
  galleryImagePrompts: MediaPromptSettings;
  galleryVideoPrompts: MediaPromptSettings;
  chatVideoPrompts: MediaPromptSettings;
}

/** {{system}} resolves the preset/custom prompt; empty slots omit their {{#if}} blocks. */
export const DEFAULT_SYSTEM_PROMPT =
  'You are {{char}}, a helpful assistant. Answer accurately and concisely.';

export const DEFAULT_PROMPT_TEMPLATE = `{{system}}

{{#if personality}}{{char}}'s personality:
{{personality}}{{/if}}

{{#if persona}}About {{user}}:
{{persona}}{{/if}}

{{#if scenario}}Scenario:
{{scenario}}{{/if}}

{{#if examples}}Example conversations:
{{examples}}{{/if}}`;

/** Mark an interjected instruction without changing its text or duplicating the marker. */
export function systemNote(prompt: string): string {
  if (!prompt.trim()) return prompt;
  const body = prompt.replace(
    /^(?:\s*\[(?:System Note|(?:IMAGE|VIDEO) PROMPT(?: REVISION)? (?:TASK|CONTEXT))\]\s*)+/i,
    '',
  );
  return `[System Note]\n${body}`;
}

export const DEFAULT_TITLE_PROMPT = `[System Note]
Pause the conversation and summarize it as a short sidebar title.
Use the conversation above as context; do not answer its dialogue or continue the roleplay.

Write a concise title of 3–6 words that captures the main topic or situation.
Return only the title, without quotation marks, labels, or commentary.`;

export const DEFAULT_DRAFT_COMPLETION_PROMPT = `[System Note]
The conversation above is context for a writing-assistance task.
Complete the unfinished user message below instead of answering it.

Return the full user message in two parts, without a separator:
1. Repeat the existing draft exactly, character for character.
2. Continue directly from its end, writing as the user in the same voice and style.

Preserve all spaces, tabs, line breaks, punctuation, and Markdown, including leading and trailing whitespace.
Do not correct or reformat the existing text.

Output only the complete message, without explanations, speaker labels, or delimiter tags.
Do not wrap it in quotation marks or additional code fences.

<unfinished_user_input>
{{draft}}
</unfinished_user_input>`;

export const DEFAULT_SPEAKER_HANDOFF_TEMPLATE = '[System Note]\n<Note: Reply as {{speaker}}>';

export const DEFAULT_AVATAR_CONTEXT =
  'Name: {{name}}\nAvatar details: {{description}}\nScenario: {{scenario}}\nFirst message: {{firstMessage}}';

export const DEFAULT_CHAT_IMAGE_REVISION_CONTEXT =
  '[System Note]\nThe next assistant message is the original image-generation prompt to revise.';

export const DEFAULT_CHAT_IMAGE_REVISION_ORIGINAL =
  '<original_image_prompt>\n{{prompt}}\n</original_image_prompt>';

/** Substitute supplied values once, leaving macro-like text inside user content untouched. */
export function expandPromptSlots(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-z]+)\}\}/gi, (match, key: string) =>
    Object.hasOwn(values, key.toLowerCase()) ? values[key.toLowerCase()]! : match,
  );
}

export const DEFAULT_STEER_TEMPLATE =
  '[System Note]\n[Revision request: modify only this aspect of the immediately preceding assistant response: {{instruction}}. Preserve all other content and details. Do not modify anything else. Return only the revised response.]';

export const DEFAULT_CHAT_IMAGE_REVISION_TEMPLATE =
  '[System Note]\n' +
  'The conversation above is reference context only. Do not continue the roleplay or answer its dialogue. ' +
  'Revise the specified image-generation prompt and return only the complete revised image-generation prompt, with no analysis, commentary, tags, or quotation marks. ' +
  'Preserve every detail that the revision does not explicitly change. Do not modify anything else.\n\n' +
  'The immediately preceding assistant message contains the original image prompt.\n\n' +
  '<revision_instruction>\n{{instruction}}\n</revision_instruction>';

export const DEFAULT_IMAGE_PROMPT_REVISION: StandalonePromptTemplate = {
  systemPrompt:
    'Revise the supplied image-generation prompt and return only the complete revised prompt, ' +
    'with no analysis, commentary, tags, or quotation marks. Preserve every detail that the ' +
    'revision does not explicitly change. Do not modify anything else.',
  userMessage:
    '<original_image_prompt>\n{{prompt}}\n</original_image_prompt>\n\n' +
    '<revision_instruction>\n{{instruction}}\n</revision_instruction>',
  reasoningPrefill: '',
  messagePrefill: '',
};

export function imageRevisionTemplateError(template: string): string | null {
  if (!/\{\{instruction\}\}/i.test(template))
    return 'Include {{instruction}} in the revision template.';
  return null;
}

export const DEFAULT_SETTINGS: Settings = {
  revision: 0,
  defaultPresetId: null,
  activeEndpointId: null,
  defaultPersonaId: null,
  defaultTemplateId: null,
  autoExpandThinking: false,
  galleryThumbnailSize: 512,
  titlePrompt: DEFAULT_TITLE_PROMPT,
  draftCompletionPrompt: DEFAULT_DRAFT_COMPLETION_PROMPT,
  backgroundSwipeGeneration: false,
  parallelBackgroundSwipeGeneration: false,
  hasPassword: false,
  imageGeneration: {
    promptRevisionTemplate: DEFAULT_CHAT_IMAGE_REVISION_TEMPLATE,
    promptRevisionContext: DEFAULT_CHAT_IMAGE_REVISION_CONTEXT,
    promptRevisionOriginal: DEFAULT_CHAT_IMAGE_REVISION_ORIGINAL,
  },
  mediaRendering: DEFAULT_MEDIA_RENDERING,
  galleryImagePrompts: {
    defaults: {},
    presets: [
      {
        id: 'image-prompt-revision',
        name: 'Revise image prompt',
        operation: 'image',
        ...DEFAULT_IMAGE_PROMPT_REVISION,
      },
    ],
  },
  galleryVideoPrompts: DEFAULT_MEDIA_PROMPTS,
  chatVideoPrompts: DEFAULT_MEDIA_PROMPTS,
};

function workflowMacroPlacementError(workflow: string): string | null {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < workflow.length; i++) {
    const macro = workflow.slice(i).match(/^\{\{(prompt|seed)\}\}/i);
    if (macro) {
      const key = macro[1]!.toLowerCase();
      if (key === 'prompt') {
        if (!inString) return '{{prompt}} must be inside a JSON string';
        if (escaped) return '{{prompt}} must not follow an unpaired backslash';
      } else {
        if (inString) return '{{seed}} must be a JSON number value, not a string';
        let before = i - 1;
        while (before >= 0 && /\s/.test(workflow[before]!)) before--;
        let after = i + macro[0].length;
        while (after < workflow.length && /\s/.test(workflow[after]!)) after++;
        if (!':[,'.includes(workflow[before] ?? '') || !',]}'.includes(workflow[after] ?? '')) {
          return '{{seed}} must occupy a complete JSON value';
        }
      }
      i += macro[0].length - 1;
      continue;
    }

    const char = workflow[i]!;
    if (!inString) {
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === '"') inString = false;
  }
  return null;
}

export function expandWorkflowTemplate(workflow: string, prompt: string, seed: number): string {
  const placementError = workflowMacroPlacementError(workflow);
  if (placementError) throw new Error(placementError);
  const escapedPrompt = JSON.stringify(prompt).slice(1, -1);
  return workflow.replaceAll(/\{\{(prompt|seed)\}\}/gi, (_, key: string) =>
    key.toLowerCase() === 'prompt' ? escapedPrompt : String(seed),
  );
}

/** Uses the same macro placement and escaping rules as rendering. */
export function workflowValidationError(workflow: string): string | null {
  let substituted: string;
  try {
    // Probe JSON-sensitive characters; plain text misses backslash-adjacent macros.
    substituted = expandWorkflowTemplate(workflow, 'test "quote" \\ slash\nline', 1);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  try {
    const parsed: unknown = JSON.parse(substituted);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? null
      : 'must be a JSON object (ComfyUI API format)';
  } catch (err) {
    return `is not valid JSON after macro substitution: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export interface TreeSnapshot {
  conversationId: number;
  messages: Message[];
  activeLeafId: number | null;
  mutationRevision: number;
}

export type InvalidateEntity =
  | 'conversations'
  | 'gallery'
  | 'characters'
  | 'characterFolders'
  | 'presets'
  | 'templates'
  | 'personas'
  | 'endpoints'
  | 'settings';

/** Structural view of a message; body fields travel separately in tree patches. */
export interface TreeNode {
  id: number;
  parentId: number | null;
  activeChildId: number | null;
  status: MessageStatus;
  generationKind: GenerationKind;
  generationToken: number | null;
}

export type ServerEvent =
  | { t: 'mediaThumbnails'; items: { id: number; thumbnail: string; revision: number }[] }
  | { t: 'mediaJob'; job: MediaJob }
  | { t: 'mediaJobDeleted'; id: string }
  | {
      t: 'mediaJobProgress';
      id: string;
      progress: NonNullable<MediaJob['progress']>;
      prompt?: string;
      reasoning?: string;
    }
  | { t: 'hello' }
  | { t: 'invalidate'; entity: InvalidateEntity }
  /** Subscribe/resync snapshot. */
  | ({ t: 'tree' } & TreeSnapshot)
  /** nodes lists the whole tree (absent ids were deleted); messages carries changed bodies. */
  | {
      t: 'treePatch';
      conversationId: number;
      activeLeafId: number | null;
      mutationRevision: number;
      nodes: TreeNode[];
      messages: Message[];
    }
  | { t: 'delta'; mid: number; d?: string; r?: string }
  | {
      t: 'final';
      conversationId: number;
      mutationRevision: number;
      message: Message;
    }
  /** Ephemeral image-render progress/preview for a message with imagePending. */
  | {
      t: 'imageProgress';
      conversationId: number;
      mid: number;
      value?: number;
      max?: number;
      /** Validated raster data URL; never persisted. */
      preview?: string;
    };

export type ClientCommand = { sub: number | null };
