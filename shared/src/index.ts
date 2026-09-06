export { readSseData } from './sse.ts';

/** 'tool' messages are plugin output shown in the chat but excluded from prompt history. */
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
  /** Assistant speaker name or plugin tool label; null = character default. */
  name: string | null;
  status: MessageStatus;
  activeChildId: number | null;
  model: string | null;
  genMeta: GenMeta | null;
  generationKind: GenerationKind;
  /** Generation attempt-group identity; changes on in-place continuation. */
  generationToken: number | null;
  /** /images/ paths, swipeable within the message. */
  images: string[];
  /** Server-persisted index into images. */
  activeImage: number;
  imagePending: boolean;
  /** A stored render config permits generating more images. */
  hasImageRender: boolean;
  createdAt: number;
}

/** Gallery-owned image copy; source links are metadata, so source deletion preserves it. */
export interface GalleryItem {
  id: number;
  characterId: number | null;
  /** Snapshotted when saved so grouping survives character deletion. */
  characterName: string;
  sourceConversationId: number | null;
  sourceMessageId: number | null;
  /** Original message image path, used only to recognize an already-saved swipe. */
  sourceImage: string | null;
  prompt: string;
  image: string;
  hasImageRender: boolean;
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
  /** Optional one-level grouping in character pickers. */
  folderId: number | null;
  avatar: string | null;
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
  /** Expands {{instruction}} for this regeneration only; empty = DEFAULT_STEER_TEMPLATE. */
  steerTemplate: string;
}

export interface Preset {
  id: number;
  name: string;
  content: string;
  createdAt: number;
}

export interface Template extends CustomTemplate {
  id: number;
  name: string;
  createdAt: number;
}

export interface Persona {
  id: number;
  name: string;
  avatar: string | null;
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

export interface Settings {
  /** Monotonic server revision used to reject stale cross-device writes. */
  revision: number;
  defaultPresetId: number | null;
  activeEndpointId: number | null;
  defaultPersonaId: number | null;
  defaultTemplateId: number | null;
  /** Auto-expand the thinking block while a model reasons with no answer text yet. */
  autoExpandThinking: boolean;
  /** Keep one unread assistant sibling prepared ahead of the active reply. */
  backgroundSwipeGeneration: boolean;
  /** Allow the one unread swipe to generate concurrently with the active reply. */
  parallelBackgroundSwipeGeneration: boolean;
  /** Whether the server has an access password. The password itself is never returned. */
  hasPassword: boolean;
  /** Keyed by plugin id; each plugin defines its settings shape. */
  pluginSettings: Record<string, Record<string, unknown>>;
}

/** {{system}} resolves the preset/custom prompt; empty slots omit their {{#if}} blocks. */
export const DEFAULT_PROMPT_TEMPLATE = `{{system}}

{{#if personality}}{{char}}'s personality:
{{personality}}{{/if}}

{{#if persona}}About {{user}}:
{{persona}}{{/if}}

{{#if scenario}}Scenario:
{{scenario}}{{/if}}

{{#if examples}}Example conversations:
{{examples}}{{/if}}`;

export const DEFAULT_STEER_TEMPLATE =
  '[Revision request: modify only this aspect of the immediately preceding assistant response: {{instruction}}. Preserve all other content and details. Do not modify anything else. Return only the revised response.]';

export const DEFAULT_SETTINGS: Settings = {
  revision: 0,
  defaultPresetId: null,
  activeEndpointId: null,
  defaultPersonaId: null,
  defaultTemplateId: null,
  autoExpandThinking: false,
  backgroundSwipeGeneration: false,
  parallelBackgroundSwipeGeneration: false,
  hasPassword: false,
  pluginSettings: {},
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
