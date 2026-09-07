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
  'autoExpandThinking' | 'backgroundSwipeGeneration' | 'parallelBackgroundSwipeGeneration';

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
  const value = (key: SettingKey) => overrides()[key] ?? state.settings[key];
  const change = (key: SettingKey, value: boolean) =>
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
      </section>
      <Show when={error()}>
        <p class="notice notice-error" role="alert">
          {error()}
        </p>
      </Show>

      <section class="danger-zone">
        <div>
          <span class="danger-zone-title">Chat history</span>
          <p class="hint">
            Permanently delete every conversation and its generated images. Characters and settings
            are kept.
          </p>
        </div>
        <button
          class="danger-btn"
          disabled={deletingChats() || state.conversations.length === 0}
          onClick={() => void deleteChats()}
        >
          {deletingChats() ? 'Deleting…' : 'Delete all chats'}
        </button>
      </section>

      <div class="form-actions">
        <button class="primary-btn" onClick={() => void save()}>
          Save
        </button>
        <button onClick={discard}>Discard</button>
        <Show when={saved()}>
          <span class="saved-flash">
            <FontAwesomeIcon icon={faCheck} size={12} /> Saved
          </span>
        </Show>
      </div>
    </div>
  );
}
