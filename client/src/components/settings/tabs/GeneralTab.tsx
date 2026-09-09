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
    Object.fromEntries(GENERAL_TRANSFER_FIELDS.map((key) => [key, state.settings[key]])) as Pick<
      Settings,
      SettingKey
    >;
  const [draft, setDraft] = createSignal(settingsValues());
  let baseline = draft();
  const [saved, flashSaved] = createSavedFlash();
  const [error, setError] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [removePassword, setRemovePassword] = createSignal(false);
  const [deletingChats, setDeletingChats] = createSignal(false);

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

  useSettingsGuard(submission);

  return (
    <div class="form [&_label]:text-label [&_label]:text-foreground [&_label]:mt-2">
      <section class="settings-section">
        <h3>Access</h3>
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
          placeholder={
            state.settings.hasPassword ? 'Enter a new password to replace it' : 'No password set'
          }
          value={password()}
          disabled={removePassword()}
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
      </section>
      <section class="settings-section">
        <h3>Messages</h3>
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
      </section>
      <section class="settings-section">
        <h3>Thumbnails</h3>
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
      </section>
      <section class="settings-section">
        <h3>Chat assistance prompts</h3>
        <div class="form-stack field-group" role="group" aria-label="Automatic chat titles">
          <Field
            name="titlePrompt"
            kind="macro"
            rows={5}
            label={
              <>
                Automatic chat title
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
            rows={7}
            keys={['draft']}
            label={
              <>
                Draft completion
                <MacroHelp rows={[['{{draft}}', 'The unfinished message in the composer']]} />
              </>
            }
            hint="Appended to the current chat context for “Continue writing this message”. Include {{draft}} and ask for the full message, starting with an exact copy of the draft. Uses the chat template’s reasoning prefill when prefills are enabled on the endpoint."
          />
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

      <SettingsActions save={save} discard={discard} saving={saving()} saved={saved()}>
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
      </SettingsActions>
    </div>
  );
}
