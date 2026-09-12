import type { Settings, SettingsPreferences, MediaSettingsCollections } from '@tinytavern/shared';
import { DEFAULT_SETTINGS, settingsPreferences, composeSettings, copySettingsData } from '@tinytavern/shared';
import { stmt, transaction } from '../db/db.ts';
import { scalarSettings } from './mediaEntities.ts';
import { mediaLibraryVersions, mediaLibraryCollections, clearMediaLibraryCache } from './mediaLibrarySnapshot.ts';
import { isPasswordConfigured } from '../http/auth.ts';

let cachedSource: string | undefined;
let cachedPreferences: SettingsPreferences | undefined;

/** Explicit invalidation also covers rolled-back transactions and restored test fixtures. */
export function invalidateSettingsCache(): void {
  cachedSource = undefined;
  clearMediaLibraryCache();
}

/** Resolve native selections over stored preferences, or an explicit import baseline. */
export function getSettingsPreferences(base?: SettingsPreferences): SettingsPreferences {
  if (!base) {
    const source = String(stmt("SELECT value FROM settings WHERE key = 'app'").get()?.value ?? '{}');
    if (cachedSource !== source || !cachedPreferences) {
      const stored = JSON.parse(source) as Record<string, unknown>;
      const defaults = settingsPreferences(DEFAULT_SETTINGS);
      const preferences = { ...defaults } as Record<string, unknown>;
      for (const key of Object.keys(defaults)) {
        if (key in stored) preferences[key] = stored[key];
      }
      cachedPreferences = preferences as SettingsPreferences;
      cachedSource = source;
    }
    base = cachedPreferences!;
  }
  const result = copySettingsData(base);
  const selected = stmt('SELECT * FROM media_selections WHERE id = 1').get()!;
  const id = (value: unknown) => (value == null ? null : String(value));
  result.mediaRendering.defaultWorkflowId = id(selected.default_workflow_id);
  result.mediaRendering.avatarWorkflowId = id(selected.avatar_workflow_id);
  result.mediaRendering.descriptionWorkflowId = id(selected.description_workflow_id);
  result.mediaChatPrompts = { defaultPresetId: id(selected.chat_prompt_id) };
  result.mediaStandalonePrompts = { defaultPresetId: id(selected.standalone_prompt_id) };
  result.imageGeneration.avatarPromptId = id(selected.avatar_prompt_id);
  result.hasPassword = isPasswordConfigured();
  return result;
}

/** Full projection for existing server readers and explicit import/export responses. */
export function getSettings(): Settings {
  return composeSettings(
    getSettingsPreferences(),
    mediaLibraryCollections(mediaLibraryVersions()) as MediaSettingsCollections,
  );
}

export function putSettings(settings: SettingsPreferences): void {
  transaction(() => {
    stmt(
      `UPDATE media_selections SET default_workflow_id = ?, avatar_workflow_id = ?, description_workflow_id = ?, chat_prompt_id = ?, standalone_prompt_id = ?, avatar_prompt_id = ? WHERE id = 1`,
    ).run(
      settings.mediaRendering.defaultWorkflowId,
      settings.mediaRendering.avatarWorkflowId,
      settings.mediaRendering.descriptionWorkflowId,
      settings.mediaChatPrompts.defaultPresetId,
      settings.mediaStandalonePrompts.defaultPresetId,
      settings.imageGeneration.avatarPromptId,
    );
    stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      'app',
      scalarSettings(settings),
    );
  });
  cachedSource = undefined;
}

/** Entity writes update only the scalar revision; library rows already own their data. */
export function touchMediaSettings(): void {
  stmt(
    "UPDATE settings SET value = json_set(value, '$.revision', COALESCE(json_extract(value, '$.revision'), 0) + 1) WHERE key = 'app'",
  ).run();
  cachedSource = undefined;
}

export const SETTINGS_REFERENCE_TABLES = {
  defaultPresetId: 'presets',
  activeEndpointId: 'endpoints',
  defaultPersonaId: 'personas',
  defaultTemplateId: 'templates',
} as const;
export type SettingsReferenceKey = keyof typeof SETTINGS_REFERENCE_TABLES;

export function clearSettingReference(key: SettingsReferenceKey, id: number): boolean {
  const settings = getSettingsPreferences();
  if (settings[key] !== id) return false;
  putSettings({ ...settings, [key]: null, revision: settings.revision + 1 });
  return true;
}
