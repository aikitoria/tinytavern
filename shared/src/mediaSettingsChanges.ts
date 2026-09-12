import type { Settings } from './index.ts';

/** Native row collections. Portable documents resolve names before producing these rows. */
export function mediaSettingsCollections(settings: Settings) {
  return {
    media_workflow_folders: settings.mediaRendering.folders,
    media_chat_prompts_folders: settings.mediaChatPrompts.folders,
    media_standalone_prompts_folders: settings.mediaStandalonePrompts.folders,
    media_chat_prompts: settings.mediaChatPrompts.presets,
    media_standalone_prompts: settings.mediaStandalonePrompts.presets,
    media_workflows: settings.mediaRendering.workflows,
    avatar_prompts: settings.imageGeneration.promptPresets?.avatar?.presets ?? [],
    media_shortcuts: settings.mediaRendering.shortcuts.map((item, position) => ({ ...item, position })),
    media_favorites: settings.mediaFavorites.map((item, position) => ({ ...item, position })),
  };
}

export type MediaSettingsTable = keyof ReturnType<typeof mediaSettingsCollections>;
export interface MediaSettingsChange {
  table: MediaSettingsTable;
  id: string;
  revision?: number;
  create?: boolean;
  fields: Record<string, unknown> | null;
}

/** Strip library rows from ordinary preferences requests and responses. */
export function settingsPreferences(settings: Settings) {
  const { workflows, folders, shortcuts, ...mediaRendering } = settings.mediaRendering;
  const { promptPresets, ...imageGeneration } = settings.imageGeneration;
  const { mediaFavorites, mediaChatPrompts, mediaStandalonePrompts, ...rest } = settings;
  return {
    ...rest,
    mediaRendering,
    mediaChatPrompts: { defaultPresetId: mediaChatPrompts.defaultPresetId },
    mediaStandalonePrompts: { defaultPresetId: mediaStandalonePrompts.defaultPresetId },
    imageGeneration: {
      ...imageGeneration,
      avatarPromptId: promptPresets?.avatar?.activeId ?? null,
    },
  };
}

export const MEDIA_SETTINGS_TABLES = [
  'media_workflow_folders',
  'media_chat_prompts_folders',
  'media_standalone_prompts_folders',
  'media_chat_prompts',
  'media_standalone_prompts',
  'media_workflows',
  'avatar_prompts',
  'media_shortcuts',
  'media_favorites',
] as const satisfies readonly MediaSettingsTable[];

export type SettingsPreferences = ReturnType<typeof settingsPreferences>;
export type MediaSettingsCollections = ReturnType<typeof mediaSettingsCollections>;
export type MediaLibraryVersions = Record<MediaSettingsTable, number>;
export interface SettingsSnapshot {
  assigned?: Partial<Record<MediaSettingsTable, Record<string, string>>>;
  epoch: string;
  preferences: SettingsPreferences;
  versions: MediaLibraryVersions;
  collections: Partial<MediaSettingsCollections>;
}

/** Copy mutable metadata while sharing immutable graph and prompt strings. */
export function copySettingsData<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(copySettingsData) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copySettingsData(item)])) as T;
  }
  return value;
}

/** Compose the editor/read DTO at the snapshot boundary; persistence owns native rows. */
export function composeSettings(preferences: SettingsPreferences, collections: MediaSettingsCollections): Settings {
  const { avatarPromptId, ...imageGeneration } = preferences.imageGeneration;
  const avatarPresets = collections.avatar_prompts;
  return {
    ...preferences,
    mediaRendering: {
      ...preferences.mediaRendering,
      workflows: collections.media_workflows,
      folders: collections.media_workflow_folders,
      shortcuts: collections.media_shortcuts,
    },
    mediaChatPrompts: {
      ...preferences.mediaChatPrompts,
      presets: collections.media_chat_prompts,
      folders: collections.media_chat_prompts_folders,
    },
    mediaStandalonePrompts: {
      ...preferences.mediaStandalonePrompts,
      presets: collections.media_standalone_prompts,
      folders: collections.media_standalone_prompts_folders,
    },
    mediaFavorites: collections.media_favorites,
    imageGeneration: {
      ...imageGeneration,
      promptPresets: {
        avatar: {
          activeId: avatarPromptId,
          active: avatarPresets.find((preset) => preset.id === avatarPromptId)?.name ?? '',
          presets: avatarPresets,
        },
      },
    },
  };
}
