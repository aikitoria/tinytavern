import {
  mediaSettingsCollections,
  settingsPreferences,
  type Settings,
  type MediaSettingsChange,
} from '@tinytavern/shared';
import { changedFields } from './editorSync.ts';

/** Page Save stays atomic, but submits only changed rows and scalar preferences. */
export function mediaSettingsChanges(base: Settings, draft: Settings) {
  const previous = mediaSettingsCollections(base);
  const current = mediaSettingsCollections(draft);
  const changes: MediaSettingsChange[] = [];
  for (const key of Object.keys(current) as (keyof typeof current)[]) {
    const before = new Map(previous[key].map((item) => [item.id, item]));
    const retained = new Set<string>();
    for (const item of current[key]) {
      if (!item.id) {
        throw new Error('A media draft row is missing its request identity');
      }
      retained.add(item.id);
      const old = before.get(item.id);
      const { id, revision, ...fields } = item as typeof item & { revision?: number };
      const patch = old ? changedFields({ ...old }, fields) : fields;
      if (Object.keys(patch).length)
        changes.push({
          table: key,
          id: item.id,
          revision: (old as { revision?: number } | undefined)?.revision ?? 0,
          create: !old,
          fields: patch,
        });
    }
    for (const item of previous[key]) {
      if (item.id && !retained.has(item.id))
        changes.push({
          table: key,
          id: item.id,
          revision: (item as { revision?: number }).revision ?? 0,
          fields: null,
        });
    }
  }
  const preferences = changedFields(settingsPreferences(base), settingsPreferences(draft));
  return { ...preferences, mediaChanges: changes };
}
