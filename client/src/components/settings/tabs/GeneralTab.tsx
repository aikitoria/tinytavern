import SettingsSection from '../SettingsSection.tsx';
import { SettingsDraftContext } from '../SettingsSection.tsx';
import { settingsFields } from '@tinytavern/shared';
import SettingsTransferButtons from '../SettingsTransferButtons.tsx';
import { GENERAL_TRANSFER_FIELDS, transferObject } from '@tinytavern/shared';
import FormField, { type FormFieldProps } from '../../forms/FormFields.tsx';
import MacroHelp from '../../forms/MacroHelp.tsx';
import SettingsActions from '../SettingsActions.tsx';
import { DEFAULT_SETTINGS } from '@tinytavern/shared';
import { Show, createSignal } from 'solid-js';
import type { Settings } from '@tinytavern/shared';
import { api } from '../../../state/api.ts';
import { applySettings, deleteAllConversations, state } from '../../../state/store.ts';
import { createSavedFlash, errorMessage } from '../../../util.ts';
import { useSettingsGuard } from '../SettingsGuard.tsx';
import { confirmAction } from '../../../state/confirm.ts';
import { createSettingsSubmission } from '../../../state/settingsSubmission.ts';
import { changedFields, sameValue } from '../../../state/editorSync.ts';

type SettingKey = (typeof GENERAL_TRANSFER_FIELDS)[number];

export default function GeneralTab() {
  const settingsValues = () =>
    Object.fromEntries(GENERAL_TRANSFER_FIELDS.map((key) => [key, state.settings[key]])) as Pick<Settings, SettingKey>;
  const [draft, setDraft] = createSignal(settingsValues());
  let baseline = draft();
  const [saved, flashSaved] = createSavedFlash();
  const [error, setError] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [removePassword, setRemovePassword] = createSignal(false);
  const [maintenance, setMaintenance] = createSignal<'chats' | 'characters' | 'settings' | null>(null);

  const value = <K extends SettingKey>(key: K): Settings[K] => draft()[key] as Settings[K];
  const change = <K extends SettingKey>(key: K, value: Settings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const Field = (
    props: Omit<FormFieldProps<Settings[SettingKey]>, 'value' | 'defaultValue' | 'onChange'> & {
      name: SettingKey;
    },
  ) => (
    <FormField
      {...props}
      value={value(props.name)}
      defaultValue={DEFAULT_SETTINGS[props.name]}
      onChange={(next) => change(props.name, next)}
    />
  );
  const submission = createSettingsSubmission({
    revision: () => state.settings.revision,
    isDirty: () => !sameValue(draft(), baseline) || password() !== '' || removePassword(),
    snapshot: () => ({ values: draft(), password: password(), removePassword: removePassword() }),
    submit: (snapshot, revision) =>
      api.putSettings(
        changedFields(baseline, snapshot.values),
        revision,
        snapshot.removePassword ? null : snapshot.password || undefined,
      ),
    accepted: (snapshot, next) => {
      applySettings(next);
      baseline = snapshot.values;
      // Fields remain editable while saving. Clear only the credentials that were submitted.
      if (password() === snapshot.password) setPassword('');
      if (removePassword() === snapshot.removePassword) setRemovePassword(false);
      flashSaved();
    },
    discard: () => {
      const next = settingsValues();
      baseline = next;
      setDraft(next);
      setPassword('');
      setRemovePassword(false);
    },
    onError: setError,
  });
  const { save, discard, saving } = submission;

  const actions = {
    chats: {
      title: 'Delete all chats',
      message:
        'Permanently delete every conversation and its attached media. Characters and settings are kept. This cannot be undone.',
    },
    characters: {
      title: 'Delete all characters',
      message:
        'Permanently delete every character and its avatar. Existing chats and gallery media are kept, with character associations removed. This cannot be undone.',
    },
    settings: {
      title: 'Reset settings',
      message:
        'Restore all global settings to their defaults, removing configured media workflows, prompt libraries, favorites and avatar prompt presets. Unsaved edits on this page will be discarded. Chats, characters, saved connections, personas, chat templates, system prompts and the access password are kept. This cannot be undone.',
    },
  };
  const runMaintenance = async (action: keyof typeof actions) => {
    if (maintenance() || saving()) return;
    const revision = state.settings.revision;
    setMaintenance(action);
    try {
      const { title, message } = actions[action];
      if (!(await confirmAction({ title: `${title}?`, message, confirmLabel: title, danger: true }))) return;
      if (action === 'chats') await deleteAllConversations();
      else if (action === 'characters') await api.deleteAllCharacters();
      else {
        applySettings(await api.resetSettings(revision));
        discard();
        flashSaved();
      }
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setMaintenance(null);
    }
  };

  useSettingsGuard({ ...submission, saving: () => saving() || maintenance() !== null });

  return (
    <SettingsDraftContext.Provider
      value={{
        schema: settingsFields(settingsValues()),
        read: draft,
        write: (next) => setDraft(next as ReturnType<typeof draft>),
        onError: setError,
      }}
    >
      <fieldset
        disabled={maintenance() !== null}
        class="form m-0 min-w-0 border-0 p-0 [&_label]:text-label [&_label]:text-foreground [&_label]:mt-2"
      >
        <SettingsSection title="Access" id="access" fields={[]}>
          <FormField
            label="Access password"
            id="settings-access-password"
            kind="password"
            autocomplete="new-password"
            changed={password() !== '' || (state.settings.hasPassword && !removePassword())}
            onRevert={() => {
              setPassword('');
              setRemovePassword(state.settings.hasPassword);
            }}
            placeholder={state.settings.hasPassword ? 'Enter a new password to replace it' : 'No password set'}
            value={password()}
            onChange={(next) => {
              setPassword(next);
              setRemovePassword(false);
            }}
            hint={
              removePassword()
                ? 'The access password will be removed when you save.'
                : state.settings.hasPassword
                  ? 'A password is set. Leave this blank to keep it unchanged.'
                  : 'Optional. When set, all API, media, and WebSocket access requires a login session.'
            }
          />
          <Show when={removePassword()}>
            <button type="button" onClick={() => setRemovePassword(false)}>
              Undo password removal
            </button>
          </Show>
        </SettingsSection>
        <SettingsSection
          title="Messages"
          id="messages"
          fields={['autoExpandThinking', 'backgroundSwipeGeneration', 'parallelBackgroundSwipeGeneration']}
        >
          <Field
            name="autoExpandThinking"
            kind="check"
            label="Auto-expand thinking while the model reasons (collapses once the reply starts)"
          />
          <div class="form-stack field-group" role="group" aria-label="Background swipe generation">
            <Field
              name="backgroundSwipeGeneration"
              kind="check"
              label="Background Swipe Generation (keep one unread assistant swipe prepared ahead)"
            />
            <Field
              name="parallelBackgroundSwipeGeneration"
              kind="check"
              disabled={!value('backgroundSwipeGeneration')}
              label="Generate the background swipe alongside the primary reply"
              hint="Allows two responses to generate at once. When off, the background swipe waits for the primary reply to finish."
            />
          </div>
        </SettingsSection>
        <SettingsSection title="Thumbnails" id="thumbnails" fields={['galleryThumbnailSize']}>
          <Field
            name="galleryThumbnailSize"
            label="Thumbnail size"
            id="gallery-thumbnail-size"
            kind="number"
            min="64"
            max="2048"
            step="1"
            hint="Maximum width or height in pixels for image and video thumbnails in gallery, chat and media tools. Saving a new size regenerates media thumbnails in the background. Avatar thumbnails are 128 pixels. Originals stay unchanged."
          />
        </SettingsSection>
        <SettingsSection
          title="Chat assistance prompts"
          id="chat-assistance"
          fields={['titlePrompt', 'draftCompletionPrompt']}
        >
          <div class="form-stack field-group" role="group" aria-label="Automatic chat titles">
            <Field
              name="titlePrompt"
              kind="macro"
              label={
                <>
                  Chat title prompt template
                  <MacroHelp />
                </>
              }
              hint="Appended after the full chat context once the assistant answers your first message, including in character chats with greetings. Uses the chat template’s reasoning prefill when prefills are enabled on the endpoint."
            />
          </div>
          <div class="form-stack field-group" role="group" aria-label="Draft completion">
            <Field
              name="draftCompletionPrompt"
              kind="macro"
              keys={['draft']}
              label={
                <>
                  Draft completion prompt template
                  <MacroHelp rows={[['{{draft}}', 'The unfinished message in the composer']]} />
                </>
              }
              hint="Appended to the current chat context for “Continue writing this message”. Include {{draft}} and ask for the full message, starting with an exact copy of the draft. Uses the chat template’s reasoning prefill when prefills are enabled on the endpoint."
            />
          </div>
        </SettingsSection>
        <Show when={error()}>
          <p class="notice notice-error" role="alert">
            {error()}
          </p>
        </Show>

        <SettingsSection title="Data management" id="data-management" fields={[]}>
          <p class="hint">These actions take effect immediately after confirmation and cannot be undone.</p>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="danger-btn"
              disabled={saving() || state.conversations.length === 0}
              onClick={() => void runMaintenance('chats')}
            >
              {maintenance() === 'chats' ? 'Deleting…' : 'Delete all chats'}
            </button>
            <button
              type="button"
              class="danger-btn"
              disabled={saving() || state.characters.length === 0}
              onClick={() => void runMaintenance('characters')}
            >
              {maintenance() === 'characters' ? 'Deleting…' : 'Delete all characters'}
            </button>
            <button
              type="button"
              class="danger-btn"
              disabled={saving()}
              onClick={() => void runMaintenance('settings')}
            >
              {maintenance() === 'settings' ? 'Resetting…' : 'Reset settings'}
            </button>
          </div>
        </SettingsSection>

        <SettingsActions save={save} discard={discard} saving={saving()} saved={saved()}>
          <SettingsTransferButtons
            type="page:general"
            onError={setError}
            exportData={() => Object.fromEntries(GENERAL_TRANSFER_FIELDS.map((key) => [key, value(key)]))}
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
        </SettingsActions>
      </fieldset>
    </SettingsDraftContext.Provider>
  );
}
