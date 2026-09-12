import {
  MEDIA_SETTINGS_TABLES,
  composeSettings,
  copySettingsData,
  type SettingsSnapshot,
  type MediaSettingsCollections,
} from '@tinytavern/shared';

type CompleteSnapshot = SettingsSnapshot & { collections: MediaSettingsCollections };

/** Reconstruct each delta against its own request baseline, so overlapping responses cannot lose a collection. */
export function createSettingsSnapshotLoader(fetchSnapshot: (query: string) => Promise<SettingsSnapshot>) {
  let cached: CompleteSnapshot | undefined;
  let requested = 0;
  let accepted = 0;
  return async (fetch = fetchSnapshot) => {
    const sequence = ++requested;
    const base = cached;
    const query = new URLSearchParams({ snapshot: '1' });
    if (base) {
      query.set('epoch', base.epoch);
      query.set('versions', JSON.stringify(base.versions));
    }
    const response = await fetch(query.toString());
    const collections = {
      ...(response.epoch === base?.epoch ? base.collections : {}),
      ...response.collections,
    } as MediaSettingsCollections;
    for (const table of MEDIA_SETTINGS_TABLES) {
      if (!Array.isArray(collections[table])) {
        throw new Error(`Settings snapshot omitted ${table}`);
      }
    }
    const snapshot = { ...response, collections };
    if (
      sequence >= accepted &&
      (!cached || cached.epoch !== response.epoch || response.preferences.revision >= cached.preferences.revision)
    ) {
      cached = snapshot;
      accepted = sequence;
    }
    return {
      settings: composeSettings(copySettingsData(response.preferences), copySettingsData(collections)),
      assigned: response.assigned ?? {},
    };
  };
}
