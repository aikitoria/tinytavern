import type { Settings } from '@tinytavern/shared';
import { api, ApiError } from './api.ts';
import { applySettings, state } from './store.ts';

export type SettingsEntityKey =
  'activeEndpointId' | 'defaultPresetId' | 'defaultPersonaId' | 'defaultTemplateId';

/** Persist one global entity selection, retrying once after a stale revision. */
export async function selectSettingsEntity(
  key: SettingsEntityKey,
  id: number | null,
): Promise<void> {
  if (state.settings[key] === id) return;
  const patch: Partial<Settings> = { [key]: id };
  try {
    applySettings(await api.putSettings(patch, state.settings.revision));
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 409)) throw err;
    const latest = await api.settings();
    applySettings(latest);
    applySettings(await api.putSettings(patch, latest.revision));
  }
}
