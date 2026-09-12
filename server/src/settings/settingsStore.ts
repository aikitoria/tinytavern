import type { Settings } from '@tinytavern/shared';
import { DEFAULT_SETTINGS } from '@tinytavern/shared';
import { stmt, transaction } from '../db/db.ts';
import { readMediaLibraries, writeMediaLibraries, scalarSettings } from './mediaEntities.ts';
import { isPasswordConfigured } from '../http/auth.ts';

let cachedSource: string | undefined;
let cachedSettings: Settings | undefined;
export function invalidateSettingsCache(): void {
  cachedSource = undefined;
}
// Copy mutable metadata while sharing immutable graph/prompt strings. Never stringify the library.
function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) as T;
  return value;
}

export function getSettings(): Settings {
  const row = stmt('SELECT value FROM settings WHERE key = ?').get('app') as
    { value: string } | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  if (cachedSource === row.value && cachedSettings) {
    const result = copy(cachedSettings);
    result.hasPassword = isPasswordConfigured();
    return result;
  }
  // Drop obsolete keys so they cannot leak into the API or future saves.
  const stored = JSON.parse(row.value) as Record<string, unknown>;
  const settings = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const key of Object.keys(settings)) {
    if (key in stored) settings[key] = stored[key];
  }
  settings.hasPassword = isPasswordConfigured();
  const result = settings as unknown as Settings;
  readMediaLibraries(result);
  cachedSource = row.value;
  cachedSettings = result;
  return copy(result);
}

export function putSettings(settings: Settings): void {
  transaction(() => {
    writeMediaLibraries(settings);
    readMediaLibraries(settings);
    stmt(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('app', scalarSettings(settings));
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
  const settings = getSettings();
  if (settings[key] !== id) return false;
  putSettings({ ...settings, [key]: null, revision: settings.revision + 1 });
  return true;
}
