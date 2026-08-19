import { Show, createEffect, createSignal, untrack } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { Settings } from '@minitavern/shared';
import { api, ApiError } from '../../state/api.ts';
import { applySettings, deleteAllConversations, setState, state } from '../../state/store.ts';
import { createSavedFlash, errorMessage } from '../../util.ts';
import { useSettingsGuard } from '../SettingsGuard.tsx';

function snapshot(): Settings {
  return { ...state.settings };
}

type SettingKey = Exclude<keyof Settings, 'revision' | 'hasPassword' | 'pluginSettings'>;
const SETTING_KEYS: SettingKey[] = ['autoExpandThinking', 'backgroundSwipeGeneration'];

export default function GeneralTab() {
  const [draft, setDraft] = createStore<Settings>(snapshot());
  const [dirty, setDirty] = createStore<Record<SettingKey, boolean>>(
    Object.fromEntries(SETTING_KEYS.map((key) => [key, false])) as Record<SettingKey, boolean>,
  );
  const [baseRevision, setBaseRevision] = createSignal(state.settings.revision);
  const [saved, flashSaved] = createSavedFlash();
  const [error, setError] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [removePassword, setRemovePassword] = createSignal(false);
  const [deletingChats, setDeletingChats] = createSignal(false);

  const passwordDirty = () => password() !== '' || removePassword();
  const isDirty = () => SETTING_KEYS.some((key) => dirty[key]) || passwordDirty();
  const change = <K extends SettingKey>(key: K, value: Settings[K]) => {
    setDraft(key, value);
    setDirty(key, true);
  };

  createEffect(() => {
    const latest = snapshot();
    if (latest.revision === draft.revision) return;
    const preserved = untrack(() =>
      Object.fromEntries(SETTING_KEYS.filter((key) => dirty[key]).map((key) => [key, draft[key]])),
    );
    setDraft(reconcile({ ...latest, ...preserved }));
    if (!untrack(isDirty)) setBaseRevision(latest.revision);
  });

  const save = async () => {
    try {
      const patch = Object.fromEntries(
        SETTING_KEYS.filter((key) => dirty[key]).map((key) => [key, draft[key]]),
      ) as Partial<Settings>;
      if (!isDirty()) return true;
      const accessPassword = removePassword() ? null : password() || undefined;
      const next = await api.putSettings(patch, baseRevision(), accessPassword);
      applySettings(next);
      setDraft(reconcile(next));
      for (const key of SETTING_KEYS) setDirty(key, false);
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
          const preserved = Object.fromEntries(
            SETTING_KEYS.filter((key) => dirty[key]).map((key) => [key, draft[key]]),
          );
          setState('settings', latest);
          setDraft(reconcile({ ...latest, ...preserved }));
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
    setDraft(reconcile(snapshot()));
    for (const key of SETTING_KEYS) setDirty(key, false);
    setBaseRevision(state.settings.revision);
    setPassword('');
    setRemovePassword(false);
    setError('');
  };

  const deleteChats = async () => {
    if (
      state.conversations.length === 0 ||
      !confirm(
        'Delete all chats? This permanently deletes every conversation and its generated images. This cannot be undone.',
      )
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
      <label for="settings-access-password">Access password</label>
      <input
        id="settings-access-password"
        type="password"
        autocomplete="new-password"
        placeholder={draft.hasPassword ? 'Enter a new password to replace it' : 'No password set'}
        value={password()}
        disabled={removePassword()}
        onInput={(event) => {
          setPassword(event.currentTarget.value);
          setRemovePassword(false);
        }}
      />
      <p class="hint">
        {draft.hasPassword
          ? 'A password is set. Leave this blank to keep it unchanged.'
          : 'Optional. When set, all API, media, and WebSocket access requires a login session.'}
      </p>
      <Show when={draft.hasPassword}>
        <label class="check-row">
          <input
            type="checkbox"
            checked={removePassword()}
            onChange={(event) => {
              setRemovePassword(event.currentTarget.checked);
              if (event.currentTarget.checked) setPassword('');
            }}
          />
          Remove the access password
        </label>
      </Show>

      <label class="check-row">
        <input
          type="checkbox"
          checked={draft.autoExpandThinking}
          onChange={(e) => change('autoExpandThinking', e.currentTarget.checked)}
        />
        Auto-expand thinking while the model reasons (collapses once the reply starts)
      </label>

      <label class="check-row">
        <input
          type="checkbox"
          checked={draft.backgroundSwipeGeneration}
          onChange={(e) => change('backgroundSwipeGeneration', e.currentTarget.checked)}
        />
        Background Swipe Generation (keep one unread assistant swipe prepared ahead)
      </label>

      <Show when={error()}>
        <p class="hint">{error()}</p>
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
          <span class="saved-flash">✓ Saved</span>
        </Show>
      </div>
    </div>
  );
}
