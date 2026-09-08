import SettingsTransferButtons from '../SettingsTransferButtons.tsx';
import { GENERAL_TRANSFER_FIELDS, transferObject } from '@tinytavern/shared';
import MacroTextarea from '../MacroTextarea.tsx';
import MacroHelp from '../MacroHelp.tsx';
import SettingsActions from '../SettingsActions.tsx';
import { DEFAULT_SETTINGS } from '@tinytavern/shared';
import SettingLabel from '../SettingField.tsx';
import { faCheck } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../FontAwesomeIcon.tsx';
import { Show, createEffect, createSignal, untrack } from 'solid-js';
import type { Settings } from '@tinytavern/shared';
import { api, ApiError } from '../../state/api.ts';
import { applySettings, deleteAllConversations, setState, state } from '../../state/store.ts';
import { createSavedFlash, errorMessage } from '../../util.ts';
import { useSettingsGuard } from '../SettingsGuard.tsx';
import { confirmAction } from '../../state/confirm.ts';

type SettingKey =
  | 'autoExpandThinking'
  | 'galleryThumbnailSize'
  | 'backgroundSwipeGeneration'
  | 'parallelBackgroundSwipeGeneration'
  | 'titlePrompt'
  | 'draftCompletionPrompt';

export default function GeneralTab() {
  const [overrides, setOverrides] = createSignal<Partial<Pick<Settings, SettingKey>>>({});
  const [baseRevision, setBaseRevision] = createSignal(state.settings.revision);
  const [saved, flashSaved] = createSavedFlash();
  const [error, setError] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [removePassword, setRemovePassword] = createSignal(false);
  const [deletingChats, setDeletingChats] = createSignal(false);

  const passwordDirty = () => password() !== '' || removePassword();
  const isDirty = () => Object.keys(overrides()).length > 0 || passwordDirty();
  const value = <K extends SettingKey>(key: K): Settings[K] =>
    (overrides()[key] ?? state.settings[key]) as Settings[K];
  const change = <K extends SettingKey>(key: K, value: Settings[K]) =>
    setOverrides((current) => {
      const next = { ...current };
      if (value === state.settings[key]) delete next[key];
      else next[key] = value;
      return next;
    });

  createEffect(() => {
    const revision = state.settings.revision;
    if (!untrack(isDirty)) setBaseRevision(revision);
  });

  const save = async () => {
    try {
      if (!isDirty()) return true;
      const accessPassword = removePassword() ? null : password() || undefined;
      const next = await api.putSettings(overrides(), baseRevision(), accessPassword);
      applySettings(next);
      setOverrides({});
      setBaseRevision(next.revision);
      setPassword('');
      setRemovePassword(false);
      setError('');
      flashSaved();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        try {
          const latest = await api.settings();
          setState('settings', latest);
          setBaseRevision(latest.revision);
        } catch {
          /* Keep the original conflict visible if the refresh also fails. */
        }
      }
      setError(errorMessage(err));
      return false;
    }
  };

  const discard = () => {
    setOverrides({});
    setBaseRevision(state.settings.revision);
    setPassword('');
    setRemovePassword(false);
    setError('');
  };

  const deleteChats = async () => {
    if (
      state.conversations.length === 0 ||
      !(await confirmAction({
        title: 'Delete all chats?',
        message:
          'This permanently deletes every conversation and its generated images. Characters and settings are kept. This cannot be undone.',
        confirmLabel: 'Delete all chats',
        danger: true,
      }))
    )
      return;
    setDeletingChats(true);
    try {
      await deleteAllConversations();
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDeletingChats(false);
    }
  };

  useSettingsGuard({ isDirty, save, discard });

  return (
    <div class="form">
      <section class="settings-section">
        <h3>Access</h3>
        <SettingLabel
          for="settings-access-password"
          changed={password() !== '' || (state.settings.hasPassword && !removePassword())}
          onRevert={() => {
            setPassword('');
            setRemovePassword(state.settings.hasPassword);
          }}
        >
          Access password
        </SettingLabel>
        <input
          id="settings-access-password"
          type="password"
          autocomplete="new-password"
          placeholder={
            state.settings.hasPassword ? 'Enter a new password to replace it' : 'No password set'
          }
          value={password()}
          disabled={removePassword()}
          onInput={(event) => {
            setPassword(event.currentTarget.value);
            setRemovePassword(false);
          }}
        />
        <p class="hint">
          {removePassword()
            ? 'The access password will be removed when you save.'
            : state.settings.hasPassword
              ? 'A password is set. Leave this blank to keep it unchanged.'
              : 'Optional. When set, all API, media, and WebSocket access requires a login session.'}
        </p>
      </section>
      <section class="settings-section">
        <h3>Messages</h3>
        <SettingLabel
          check
          changed={value('autoExpandThinking') !== DEFAULT_SETTINGS.autoExpandThinking}
          onRevert={() => change('autoExpandThinking', DEFAULT_SETTINGS.autoExpandThinking)}
        >
          <input
            type="checkbox"
            checked={value('autoExpandThinking')}
            onChange={(e) => change('autoExpandThinking', e.currentTarget.checked)}
          />
          Auto-expand thinking while the model reasons (collapses once the reply starts)
        </SettingLabel>

        <div class="form-stack field-group" role="group" aria-label="Background swipe generation">
          <SettingLabel
            check
            changed={
              value('backgroundSwipeGeneration') !== DEFAULT_SETTINGS.backgroundSwipeGeneration
            }
            onRevert={() =>
              change('backgroundSwipeGeneration', DEFAULT_SETTINGS.backgroundSwipeGeneration)
            }
          >
            <input
              type="checkbox"
              checked={value('backgroundSwipeGeneration')}
              onChange={(e) => change('backgroundSwipeGeneration', e.currentTarget.checked)}
            />
            Background Swipe Generation (keep one unread assistant swipe prepared ahead)
          </SettingLabel>

          <SettingLabel
            check
            changed={
              value('parallelBackgroundSwipeGeneration') !==
              DEFAULT_SETTINGS.parallelBackgroundSwipeGeneration
            }
            onRevert={() =>
              change(
                'parallelBackgroundSwipeGeneration',
                DEFAULT_SETTINGS.parallelBackgroundSwipeGeneration,
              )
            }
          >
            <input
              type="checkbox"
              checked={value('parallelBackgroundSwipeGeneration')}
              disabled={!value('backgroundSwipeGeneration')}
              onChange={(e) => change('parallelBackgroundSwipeGeneration', e.currentTarget.checked)}
            />
            Generate the background swipe alongside the primary reply
          </SettingLabel>
          <p class="hint">
            Allows two responses to generate at once. When off, the background swipe waits for the
            primary reply to finish.
          </p>
        </div>
      </section>
      <section class="settings-section">
        <h3>Thumbnails</h3>
        <SettingLabel
          for="gallery-thumbnail-size"
          changed={value('galleryThumbnailSize') !== DEFAULT_SETTINGS.galleryThumbnailSize}
          onRevert={() => change('galleryThumbnailSize', DEFAULT_SETTINGS.galleryThumbnailSize)}
        >
          Thumbnail size
        </SettingLabel>
        <input
          id="gallery-thumbnail-size"
          type="number"
          min="64"
          max="2048"
          step="1"
          value={value('galleryThumbnailSize')}
          onInput={(event) => change('galleryThumbnailSize', event.currentTarget.valueAsNumber)}
        />
        <p class="hint">
          Maximum width or height in pixels for image and video thumbnails in gallery, chat and
          media tools. Saving a new size regenerates media thumbnails in the background. Avatar
          thumbnails are 128 pixels. Originals stay unchanged.
        </p>
      </section>
      <section class="settings-section">
        <h3>Chat assistance prompts</h3>
        <div class="form-stack field-group" role="group" aria-label="Automatic chat titles">
          <SettingLabel
            changed={value('titlePrompt') !== DEFAULT_SETTINGS.titlePrompt}
            onRevert={() => change('titlePrompt', DEFAULT_SETTINGS.titlePrompt)}
          >
            Automatic chat title
            <MacroHelp />
          </SettingLabel>
          <MacroTextarea
            value={value('titlePrompt')}
            onText={(text) => change('titlePrompt', text)}
            rows={5}
          />
          <p class="hint">
            Appended after the full chat context once the assistant answers your first message,
            including in character chats with greetings. Uses the chat template’s reasoning prefill
            when prefills are enabled on the endpoint.
          </p>
        </div>
        <div class="form-stack field-group" role="group" aria-label="Draft completion">
          <SettingLabel
            changed={value('draftCompletionPrompt') !== DEFAULT_SETTINGS.draftCompletionPrompt}
            onRevert={() => change('draftCompletionPrompt', DEFAULT_SETTINGS.draftCompletionPrompt)}
          >
            Draft completion
            <MacroHelp rows={[['{{draft}}', 'The unfinished message in the composer']]} />
          </SettingLabel>
          <MacroTextarea
            value={value('draftCompletionPrompt')}
            onText={(text) => change('draftCompletionPrompt', text)}
            keys={['draft']}
            rows={7}
          />
          <p class="hint">
            Appended to the current chat context for “Continue writing this message”. Include{' '}
            {'{{draft}}'} and ask for the full message, starting with an exact copy of the draft.
            Uses the chat template’s reasoning prefill when prefills are enabled on the endpoint.
          </p>
        </div>
      </section>
      <Show when={error()}>
        <p class="notice notice-error" role="alert">
          {error()}
        </p>
      </Show>

      <section class="settings-section">
        <h3>Chat history</h3>
        <p class="hint">
          Permanently delete every conversation and its generated images. Characters and settings
          are kept.
        </p>
        <button
          class="danger-btn"
          disabled={deletingChats() || state.conversations.length === 0}
          onClick={() => void deleteChats()}
        >
          {deletingChats() ? 'Deleting…' : 'Delete all chats'}
        </button>
      </section>

      <SettingsActions>
        <button class="primary-btn" onClick={() => void save()}>
          Save
        </button>
        <SettingsTransferButtons
          type="page:general"
          onError={setError}
          exportData={() =>
            Object.fromEntries(GENERAL_TRANSFER_FIELDS.map((key) => [key, value(key)]))
          }
          importData={(data) => {
            const source = transferObject(data);
            for (const key of GENERAL_TRANSFER_FIELDS) {
              if (Object.hasOwn(source, key) && typeof source[key] !== typeof DEFAULT_SETTINGS[key])
                throw new Error(`Invalid ${key}`);
            }
            for (const key of GENERAL_TRANSFER_FIELDS) {
              if (Object.hasOwn(source, key)) change(key, source[key] as Settings[SettingKey]);
            }
          }}
        />
        <button onClick={discard}>Discard</button>
        <Show when={saved()}>
          <span class="saved-flash">
            <FontAwesomeIcon icon={faCheck} size={12} /> Saved
          </span>
        </Show>
      </SettingsActions>
    </div>
  );
}
