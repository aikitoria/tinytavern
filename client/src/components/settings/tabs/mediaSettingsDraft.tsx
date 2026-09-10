import SettingsTransferButtons from '../SettingsTransferButtons.tsx';
import {
  exportGenerationSettings,
  importGenerationSettings,
  type Settings,
} from '@tinytavern/shared';
import SettingsActions from '../SettingsActions.tsx';
import { Show, createMemo, createSignal, onMount } from 'solid-js';
import { unwrap } from 'solid-js/store';
import { state, applySettings } from '../../../state/store.ts';
import { api } from '../../../state/api.ts';
import { createSavedFlash } from '../../../util.ts';
import { useSettingsGuard } from '../SettingsGuard.tsx';
import { createSettingsSubmission } from '../../../state/settingsSubmission.ts';
import { mergeRemoteDraft } from '../../../state/editorSync.ts';

import type { ImageGenerationSettingsHandle } from '../../../images/imageGeneration.tsx';

type Draft = Pick<Settings, 'mediaRendering' | 'mediaFavorites' | 'imageGeneration'>;

/** Every generation settings section shares one save/discard boundary. */
export function mediaSettingsDraft() {
  const snapshot = (settings = state.settings): Draft =>
    structuredClone(
      unwrap({
        mediaRendering: settings.mediaRendering,
        mediaFavorites: settings.mediaFavorites,
        imageGeneration: settings.imageGeneration,
      }),
    );
  let imageFields: ImageGenerationSettingsHandle | undefined;
  const [draft, setDraft] = createSignal(snapshot());
  let remoteBase = draft();
  const readDraft = (): Draft => ({
    ...draft(),
    imageGeneration: imageFields?.value ?? draft().imageGeneration,
  });
  const writeDraft = (next: Draft) => {
    setDraft(next);
    if (imageFields) imageFields.value = next.imageGeneration;
  };
  const rendering = createMemo(() => draft().mediaRendering);
  const favorites = createMemo(() => draft().mediaFavorites);
  const [baseline, setBaseline] = createSignal(JSON.stringify(draft()));
  const [error, setError] = createSignal('');
  const [saved, flashSaved] = createSavedFlash();
  const submission = createSettingsSubmission({
    revision: () => state.settings.revision,
    isDirty: () => JSON.stringify(readDraft()) !== baseline(),
    snapshot: () => {
      imageFields?.validate();
      return readDraft();
    },
    submit: (value, revision) => api.putSettings(value, revision),
    rebase: () => {
      const latest = snapshot();
      const merged = mergeRemoteDraft(remoteBase, readDraft(), latest, true);
      if (merged.conflicts.length) return false;
      const clean = mergeRemoteDraft(remoteBase, JSON.parse(baseline()) as Draft, latest, true);
      setDraft(merged.draft);
      if (imageFields) imageFields.value = merged.draft.imageGeneration;
      setBaseline(JSON.stringify(clean.draft));
      remoteBase = latest;
      return true;
    },
    accepted: (value, next) => {
      applySettings(next);
      remoteBase = snapshot(next);
      setBaseline(JSON.stringify(value));
      flashSaved();
    },
    discard: () => {
      const next = snapshot();
      remoteBase = next;
      setDraft(next);
      if (imageFields) imageFields.value = next.imageGeneration;
      setBaseline(JSON.stringify(readDraft()));
    },
    onError: setError,
  });
  const { saving, save, discard } = submission;
  useSettingsGuard(submission);
  onMount(discard);
  const setRendering = (
    change: (current: Settings['mediaRendering']) => Settings['mediaRendering'],
  ) => setDraft((current) => ({ ...current, mediaRendering: change(current.mediaRendering) }));
  const setFavorites = (
    change: (current: Settings['mediaFavorites']) => Settings['mediaFavorites'],
  ) => setDraft((current) => ({ ...current, mediaFavorites: change(current.mediaFavorites) }));
  const Actions = () => (
    <>
      <Show when={error()}>
        <p class="notice notice-error" role="alert">
          {error()}
        </p>
      </Show>
      <SettingsActions save={save} discard={discard} saving={saving()} saved={saved()}>
        <SettingsTransferButtons
          type="page:mediaRendering"
          onError={setError}
          exportData={() => exportGenerationSettings({ ...state.settings, ...readDraft() })}
          importData={(data) => {
            const next = importGenerationSettings(data, { ...state.settings, ...readDraft() });
            writeDraft(next);
            setError('');
          }}
        />
      </SettingsActions>
    </>
  );
  return {
    readDraft,
    writeDraft,
    draft: rendering,
    setDraft: setRendering,
    favorites,
    setFavorites,
    setImageFields: (fields: ImageGenerationSettingsHandle) => {
      imageFields = fields;
    },
    setError,
    Actions,
  };
}
