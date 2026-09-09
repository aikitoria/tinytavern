import type { Settings } from '@tinytavern/shared';
import { DEFAULT_SETTINGS } from '@tinytavern/shared';
import { stmt } from './db.ts';
import { isPasswordConfigured } from './auth.ts';

export function getSettings(): Settings {
  const row = stmt('SELECT value FROM settings WHERE key = ?').get('app') as
    { value: string } | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  // Drop obsolete keys so they cannot leak into the API or future saves.
  const stored = JSON.parse(row.value) as Record<string, unknown>;
  const settings = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const key of Object.keys(settings)) {
    if (key in stored) settings[key] = stored[key];
  }
  settings.hasPassword = isPasswordConfigured();
  return settings as unknown as Settings;
}

export function putSettings(settings: Settings): void {
  stmt(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('app', JSON.stringify(settings));
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
