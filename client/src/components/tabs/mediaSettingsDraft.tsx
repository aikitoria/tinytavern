import SettingsTransferButtons from '../SettingsTransferButtons.tsx';
import {
  exportRendering,
  importRendering,
  exportPromptCollection,
  importPromptCollection,
} from '@tinytavern/shared';
import SettingsActions from '../SettingsActions.tsx';
import { Show, createEffect, createSignal, untrack } from 'solid-js';
import type { Settings, MediaPromptSettingsKey } from '@tinytavern/shared';
import { state, applySettings } from '../../state/store.ts';
import { api, ApiError } from '../../state/api.ts';
import { errorMessage, createSavedFlash } from '../../util.ts';
import { useSettingsGuard } from '../SettingsGuard.tsx';

export function mediaSettingsDraft<K extends 'mediaRendering' | MediaPromptSettingsKey>(key: K) {
  const snapshot = () => JSON.parse(JSON.stringify(state.settings[key])) as Settings[K];
  const [draft, setDraft] = createSignal<Settings[K]>(snapshot());
  const [baseline, setBaseline] = createSignal(JSON.stringify(draft()));
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');
  const [saved, flashSaved] = createSavedFlash();
  let revision = state.settings.revision;
  const isDirty = () => JSON.stringify(draft()) !== baseline();
  const discard = () => {
    const next = snapshot();
    setDraft(() => next);
    setBaseline(JSON.stringify(next));
    revision = state.settings.revision;
    setError('');
  };
  createEffect(() => {
    void state.settings.revision;
    if (!untrack(isDirty) && !untrack(saving)) {
      untrack(discard);
    }
  });
  const save = async () => {
    if (saving()) {
      return false;
    }
    const value = draft();
    const encoded = JSON.stringify(value);
    setSaving(true);
    setError('');
    try {
      const next = await api.putSettings({ [key]: value }, revision);
      applySettings(next);
      revision = next.revision;
      setBaseline(encoded);
      flashSaved();
      return !isDirty();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? 'Settings changed elsewhere. Discard to load them, then review your changes.'
          : errorMessage(err),
      );
      return false;
    } finally {
      setSaving(false);
    }
  };
  useSettingsGuard({ isDirty, save, discard });
  const Actions = () => (
    <>
      <Show when={error()}>
        <p class="notice notice-error" role="alert">
          {error()}
        </p>
      </Show>
      <SettingsActions>
        <button class="primary-btn" disabled={saving()} onClick={() => void save()}>
          {saving() ? 'Saving…' : 'Save'}
        </button>
        <SettingsTransferButtons
          type={`page:${key}`}
          onError={setError}
          exportData={() =>
            key === 'mediaRendering'
              ? exportRendering({
                  ...state.settings,
                  mediaRendering: draft() as Settings['mediaRendering'],
                })
              : exportPromptCollection(draft() as Settings['chatVideoPrompts'])
          }
          importData={(data) => {
            const next =
              key === 'mediaRendering'
                ? importRendering(data, {
                    ...state.settings,
                    mediaRendering: draft() as Settings['mediaRendering'],
                  })
                : importPromptCollection(
                    data,
                    draft() as Settings['chatVideoPrompts'],
                    key === 'chatVideoPrompts',
                    key !== 'galleryImagePrompts',
                  );
            setDraft(() => next as Settings[K]);
            setError('');
          }}
        />
        <button disabled={saving()} onClick={discard}>
          Discard
        </button>
        <Show when={saved()}>
          <span class="saved-flash">Saved</span>
        </Show>
      </SettingsActions>
    </>
  );
  return { draft, setDraft, setError, Actions };
}
