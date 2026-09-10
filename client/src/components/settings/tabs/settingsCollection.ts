import type { Settings } from '@tinytavern/shared';
import { unwrap } from 'solid-js/store';
import { api } from '../../../state/api.ts';
import { applySettings, state } from '../../../state/store.ts';

/** Read the latest collection for each mutation; the server guards the whole settings revision. */
export function settingsCollection<K extends keyof Settings>(key: K) {
  return async (change: (current: Settings[K]) => Settings[K]) => {
    const settings = state.settings;
    const next = await api.putSettings(
      { [key]: change(structuredClone(unwrap(settings[key]))) },
      settings.revision,
    );
    applySettings(next);
    return next[key];
  };
}
