import { settingsPreferences, type Settings } from '@tinytavern/shared';
import { transaction } from '../../server/src/db/db.ts';
import { importMediaLibraries } from '../../server/src/settings/mediaEntities.ts';
import { getSettingsPreferences, putSettings as putPreferences } from '../../server/src/settings/settingsStore.ts';

export { getSettings } from '../../server/src/settings/settingsStore.ts';

/** Fixtures explicitly install libraries; production preference writes never replace them. */
export function putSettings(settings: Settings): void {
  transaction(() => {
    importMediaLibraries(settings);
    putPreferences(getSettingsPreferences(settingsPreferences(settings)));
  });
}
