import type { Settings } from '@tinytavern/shared';
import { api, ApiError } from './api.ts';
import { applySettings, state } from './store.ts';

export type SettingsEntityKey =
  'activeEndpointId' | 'defaultPresetId' | 'defaultPersonaId' | 'defaultTemplateId';
type MediaPromptKey = 'mediaChatPrompts' | 'mediaStandalonePrompts';
type SelectionKey = SettingsEntityKey | MediaPromptKey;
type SelectionId = number | string | null;

const pendingSelections = new Map<SelectionKey, { id: SelectionId; promise: Promise<void> }>();
const mediaPromptKey = (key: SelectionKey): key is MediaPromptKey =>
  key === 'mediaChatPrompts' || key === 'mediaStandalonePrompts';
const selected = (key: SelectionKey): SelectionId =>
  mediaPromptKey(key) ? state.settings[key].defaultPresetId : state.settings[key];
const selectionPatch = (key: SelectionKey, id: SelectionId): Partial<Settings> =>
  mediaPromptKey(key) ? { [key]: { ...state.settings[key], defaultPresetId: id } } : { [key]: id };

/** Serialize each selection and coalesce further clicks to the latest requested item. */
function select(key: SelectionKey, id: SelectionId): Promise<void> {
  const pending = pendingSelections.get(key);
  if (pending) {
    pending.id = id;
    return pending.promise;
  }
  if (selected(key) === id) return Promise.resolve();
  const operation = { id, promise: undefined as unknown as Promise<void> };
  pendingSelections.set(key, operation);
  operation.promise = (async () => {
    for (;;) {
      const target = operation.id;
      try {
        if (selected(key) !== target) {
          try {
            applySettings(
              await api.putSettings(selectionPatch(key, target), state.settings.revision),
            );
          } catch (err) {
            if (!(err instanceof ApiError && err.status === 409)) throw err;
            if (operation.id !== target) continue;
            applySettings(await api.settings());
            if (operation.id !== target) continue;
            applySettings(
              await api.putSettings(selectionPatch(key, target), state.settings.revision),
            );
          }
        }
      } catch (err) {
        if (operation.id === target) throw err;
      }
      if (operation.id === target) return;
    }
  })().finally(() => pendingSelections.delete(key));
  return operation.promise;
}

export const selectSettingsEntity = (key: SettingsEntityKey, id: number | null): Promise<void> =>
  select(key, id);

export const selectMediaPromptPreset = (key: MediaPromptKey, id: string | null): Promise<void> =>
  select(key, id);
