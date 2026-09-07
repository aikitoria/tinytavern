import { For, Show, createEffect, createSignal, onMount, untrack } from 'solid-js';
import {
  DEFAULT_GALLERY_REVISION_TEMPLATE,
  galleryRevisionTemplateError,
} from '@tinytavern/shared';
import type { StandalonePromptTemplate } from '@tinytavern/shared';
import { faCheck } from '@fortawesome/free-solid-svg-icons';
import { api, ApiError } from '../../state/api.ts';
import { applySettings, state } from '../../state/store.ts';
import { createSavedFlash, errorMessage } from '../../util.ts';
import FontAwesomeIcon from '../FontAwesomeIcon.tsx';
import MacroTextarea from '../MacroTextarea.tsx';
import MacroHelp from '../MacroHelp.tsx';
import SettingLabel, { createDefaultField } from '../SettingField.tsx';
import { useSettingsGuard } from '../SettingsGuard.tsx';

const FIELDS: { key: keyof StandalonePromptTemplate; label: string; rows: number }[] = [
  { key: 'systemPrompt', label: 'System prompt', rows: 5 },
  { key: 'userMessage', label: 'User message', rows: 8 },
  { key: 'reasoningPrefill', label: 'Reasoning prefill (optional)', rows: 3 },
  { key: 'messagePrefill', label: 'Assistant message prefill (optional)', rows: 3 },
];

export default function GalleryTab() {
  const inputs = {
    systemPrompt: createDefaultField(() => DEFAULT_GALLERY_REVISION_TEMPLATE.systemPrompt),
    userMessage: createDefaultField(() => DEFAULT_GALLERY_REVISION_TEMPLATE.userMessage),
    reasoningPrefill: createDefaultField(() => DEFAULT_GALLERY_REVISION_TEMPLATE.reasoningPrefill),
    messagePrefill: createDefaultField(() => DEFAULT_GALLERY_REVISION_TEMPLATE.messagePrefill),
  };
  const [draft, setDraft] = createSignal({ ...DEFAULT_GALLERY_REVISION_TEMPLATE });
  const encodedDraft = () => JSON.stringify(draft());
  const showTemplate = (template: StandalonePromptTemplate) => {
    for (const { key } of FIELDS) inputs[key].value = template[key];
  };
  const [baseline, setBaseline] = createSignal('');
  const [error, setError] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [saved, flashSaved] = createSavedFlash();
  let baseRevision = state.settings.revision;
  const isDirty = () => encodedDraft() !== baseline();
  const load = () => {
    const template = state.settings.gallery.promptRevision;
    showTemplate(template);
    setBaseline(JSON.stringify(template));
    baseRevision = state.settings.revision;
    setError('');
  };
  onMount(load);
  createEffect(() => {
    void state.settings.revision;
    if (inputs.userMessage.element() && !untrack(isDirty) && !untrack(saving)) untrack(load);
  });

  const save = async () => {
    if (saving()) return false;
    const template = { ...draft() };
    const submitted = JSON.stringify(template);
    const invalid = galleryRevisionTemplateError(template);
    if (invalid) {
      setError(invalid);
      return false;
    }
    setSaving(true);
    try {
      const next = await api.putSettings({ gallery: { promptRevision: template } }, baseRevision);
      applySettings(next);
      // Keep edits made during the request as a new unsaved draft.
      if (encodedDraft() === submitted) showTemplate(template);
      setBaseline(JSON.stringify(template));
      baseRevision = next.revision;
      setError('');
      flashSaved();
      return !isDirty();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? 'Settings changed elsewhere. Discard to load the latest version, then review your changes.'
          : errorMessage(err),
      );
      return false;
    } finally {
      setSaving(false);
    }
  };
  useSettingsGuard({ isDirty, save, discard: load });

  return (
    <div class="form">
      <section class="settings-section">
        <h3>Prompt revision</h3>
        <p class="hint">
          A standalone request using the active endpoint's sampling settings and prefill mode. No
          chat history, character, or persona is included. These fields define the entire request.
        </p>
        <For each={FIELDS}>
          {(field) => (
            <>
              <SettingLabel field={inputs[field.key]} for={`gallery-revision-${field.key}`}>
                {field.label}{' '}
                <MacroHelp
                  rows={[
                    ['{{instruction}}', 'The edit instruction entered in the gallery'],
                    ['{{prompt}}', 'The current image prompt, including unsaved edits'],
                  ]}
                />
              </SettingLabel>
              <MacroTextarea
                ref={(el) => {
                  inputs[field.key].ref(el);
                  el.id = `gallery-revision-${field.key}`;
                }}
                keys={['instruction', 'prompt']}
                rows={field.rows}
                onText={(value) => setDraft((current) => ({ ...current, [field.key]: value }))}
              />
            </>
          )}
        </For>
        <p class="hint">
          Reasoning prefill seeds hidden reasoning. Assistant message prefill becomes the start of
          the revised prompt. Both are ignored when prefills are disabled on the endpoint.
        </p>
      </section>
      <Show when={error()}>
        <p class="notice notice-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="form-actions">
        <button class="primary-btn" disabled={saving()} onClick={() => void save()}>
          {saving() ? 'Saving…' : 'Save'}
        </button>
        <button disabled={saving()} onClick={load}>
          Discard
        </button>
        <Show when={saved()}>
          <span class="saved-flash">
            <FontAwesomeIcon icon={faCheck} size={12} /> Saved
          </span>
        </Show>
      </div>
    </div>
  );
}
