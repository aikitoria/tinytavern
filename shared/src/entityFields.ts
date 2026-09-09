import { DEFAULT_CUSTOM_TEMPLATE, type CustomTemplate } from './template.ts';
import type { GenParams } from './index.ts';

/** Editable fields define DTO types, create defaults, CRUD fields and transfer keys. */
export const ENTITY_FIELDS = {
  characters: {
    name: '',
    /** Optional in-chat name for {{char}} and default assistant speaker labels. */
    chatName: null as string | null,
    /** Optional one-level grouping in character pickers. */
    folderId: null as number | null,
    personality: '',
    scenario: '',
    /** SillyTavern mes_example -> {{examples}}; users supply separators such as <START>. */
    examples: '',
    firstMessage: '',
    presetId: null as number | null,
    customPrompt: null as string | null,
    templateId: null as number | null,
    /** Opt out of background swipes even when the global setting is enabled. */
    disableBackgroundSwipeGeneration: false,
    /** Inline template override; replaces templateId with the same settings. */
    customTemplate: null as CustomTemplate | null,
  },
  presets: { name: '', content: '' },
  templates: { name: '', ...DEFAULT_CUSTOM_TEMPLATE },
  personas: { name: '', description: '' },
  endpoints: {
    name: '',
    baseUrl: '',
    apiKey: '',
    /** Null omits the model field, letting the endpoint choose. */
    model: null as string | null,
    genParams: {} as GenParams,
    /** 'none' uses a trailing message; 'vllm' uses continue_final_message; 'deepseek' uses prefix. */
    prefillMode: 'none' as 'disabled' | 'none' | 'vllm' | 'deepseek',
  },
};

type Entity<K extends keyof typeof ENTITY_FIELDS> = (typeof ENTITY_FIELDS)[K] & {
  id: number;
  createdAt: number;
};
type Avatar = { avatar: string | null; avatarThumbnail?: string | null };
export type Character = Entity<'characters'> & Avatar;
export type Persona = Entity<'personas'> & Avatar;
export type Preset = Entity<'presets'> & { readOnly: boolean };
export type Template = Entity<'templates'> & { readOnly: boolean };
export type Endpoint = Entity<'endpoints'> & {
  /** Whether a secret is stored; the secret itself is never returned by the API. */
  hasApiKey: boolean;
  models: string[];
};
