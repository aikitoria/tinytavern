import SettingsTransferButtons from '../SettingsTransferButtons.tsx';
import {
  exportRendering,
  importRendering,
  exportPromptCollection,
  importPromptCollection,
} from '@tinytavern/shared';
import SettingsActions from '../SettingsActions.tsx';
import { Show, createSignal } from 'solid-js';
import type { Settings, MediaPromptSettingsKey } from '@tinytavern/shared';
import { state, applySettings } from '../../../state/store.ts';
import { api } from '../../../state/api.ts';
import { createSavedFlash } from '../../../util.ts';
import { useSettingsGuard } from '../SettingsGuard.tsx';
import { createSettingsSubmission } from '../../../state/settingsSubmission.ts';

export function mediaSettingsDraft<K extends 'mediaRendering' | MediaPromptSettingsKey>(key: K) {
  const snapshot = () => JSON.parse(JSON.stringify(state.settings[key])) as Settings[K];
  const [draft, setDraft] = createSignal<Settings[K]>(snapshot());
  const [baseline, setBaseline] = createSignal(JSON.stringify(draft()));
  const [error, setError] = createSignal('');
  const [saved, flashSaved] = createSavedFlash();
  const submission = createSettingsSubmission({
    revision: () => state.settings.revision,
    isDirty: () => JSON.stringify(draft()) !== baseline(),
    snapshot: draft,
    submit: (value, revision) => api.putSettings({ [key]: value }, revision),
    accepted: (value, next) => {
      applySettings(next);
      setBaseline(JSON.stringify(value));
      flashSaved();
    },
    discard: () => {
      const next = snapshot();
      setDraft(() => next);
      setBaseline(JSON.stringify(next));
    },
    onError: setError,
  });
  const { saving, save, discard } = submission;
  useSettingsGuard(submission);
  const Actions = () => (
    <>
      <Show when={error()}>
        <p class="notice notice-error" role="alert">
          {error()}
        </p>
      </Show>
      <SettingsActions save={save} discard={discard} saving={saving()} saved={saved()}>
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
      </SettingsActions>
    </>
  );
  return { draft, setDraft, setError, Actions };
}
