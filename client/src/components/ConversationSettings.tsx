import { Show, createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { Conversation } from '@minitavern/shared';
import { api } from '../state/api.ts';
import { openModal, selectedConversation, state } from '../state/store.ts';
import { createSavedFlash, download, errorMessage, numberOrNull } from '../util.ts';
import { mergeRemoteDraft, sameValue } from '../state/editorSync.ts';
import Modal from './Modal.tsx';
import MacroHelp from './MacroHelp.tsx';
import MacroTextarea from './MacroTextarea.tsx';
import Select from './Select.tsx';
import type { SettingsSectionActions } from './SettingsGuard.tsx';

interface Draft {
  title: string;
  characterId: number | null;
  personaId: number | null;
  endpointId: number | null;
  speakerName: string | null;
  scenarioOverride: string | null;
}

function snapshot(conv: Conversation): Draft {
  return {
    title: conv.title,
    characterId: conv.characterId,
    personaId: conv.personaId,
    endpointId: conv.endpointId,
    speakerName: conv.speakerName,
    scenarioOverride: conv.scenarioOverride,
  };
}

function Editor(props: {
  conv: Conversation;
  register: (actions: SettingsSectionActions) => () => void;
}) {
  let scenarioEl: HTMLTextAreaElement | undefined;
  let base = snapshot(props.conv);
  const [draft, setDraft] = createStore<Draft>({ ...base });
  const [saved, flashSaved] = createSavedFlash();
  const [error, setError] = createSignal('');
  const [conflicts, setConflicts] = createSignal<(keyof Draft)[]>([]);

  const isDirty = () => !sameValue(draft, base);

  const inheritedScenario = () =>
    state.characters.find((character) => character.id === draft.characterId)?.scenario ?? '';

  createEffect(() => {
    const value = draft.scenarioOverride;
    if (value != null && scenarioEl && scenarioEl.value !== value) scenarioEl.value = value;
  });

  createEffect(() => {
    const latest = snapshot(props.conv);
    if (sameValue(latest, base)) return;
    untrack(() => {
      const merged = mergeRemoteDraft(base, { ...draft }, latest);
      base = merged.base;
      setDraft(reconcile(merged.draft));
      setConflicts(merged.conflicts);
      if (merged.conflicts.length > 0) {
        setError(
          `Changed on another device: ${merged.conflicts.join(', ')}. Discard or resolve before saving.`,
        );
      }
    });
  });

  const save = async () => {
    if (conflicts().length > 0) {
      setError(`Resolve or discard the conflicting fields: ${conflicts().join(', ')}.`);
      return false;
    }
    // Only send fields the user changed here — a full-draft PATCH would
    // clobber concurrent updates (auto-titling, /char on another device).
    const dirty = Object.fromEntries(
      (Object.keys(base) as (keyof Draft)[])
        .filter((key) => draft[key] !== base[key])
        .map((key) => [key, draft[key]]),
    );
    try {
      const updated = await api.patchConversation(
        props.conv.id,
        dirty,
        state.tree.conversationId === props.conv.id
          ? state.tree.activeLeafId
          : props.conv.activeLeafId,
        state.tree.conversationId === props.conv.id
          ? state.tree.mutationRevision
          : props.conv.mutationRevision,
      );
      base = snapshot(updated);
      setDraft(reconcile({ ...base }));
      setConflicts([]);
      setError('');
      flashSaved();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  };

  const discard = () => {
    const current = selectedConversation();
    if (current) {
      base = snapshot(current);
      setDraft(reconcile({ ...base }));
    }
    setConflicts([]);
    setError('');
  };

  const unregister = props.register({ isDirty, save, discard });
  onCleanup(unregister);

  return (
    <div class="form">
      <label>Title</label>
      <input value={draft.title} onChange={(e) => setDraft('title', e.currentTarget.value)} />

      <label>Character</label>
      <Select
        value={draft.characterId?.toString() ?? ''}
        onChange={(v) => setDraft('characterId', numberOrNull(v))}
        options={[
          { value: '', label: 'Assistant (none)' },
          ...state.characters.map((ch) => ({ value: String(ch.id), label: ch.name })),
        ]}
      />

      <label>Speaker name (assistant replies; empty = character's name, also set via /char)</label>
      <input
        value={draft.speakerName ?? ''}
        onChange={(e) => setDraft('speakerName', e.currentTarget.value.trim() || null)}
        placeholder={
          state.characters.find((ch) => ch.id === draft.characterId)?.name ?? 'Assistant'
        }
      />

      <label>Persona</label>
      <Select
        value={draft.personaId?.toString() ?? ''}
        onChange={(v) => setDraft('personaId', numberOrNull(v))}
        options={[
          { value: '', label: '— none —' },
          ...state.personas.map((p) => ({ value: String(p.id), label: p.name })),
        ]}
      />

      <label>Endpoint (overrides the global active endpoint for this conversation)</label>
      <Select
        value={draft.endpointId?.toString() ?? ''}
        onChange={(v) => setDraft('endpointId', numberOrNull(v))}
        options={[
          { value: '', label: '— global default —' },
          ...state.endpoints.map((ep) => ({ value: String(ep.id), label: ep.name })),
        ]}
      />

      <label class="check-row">
        <input
          type="checkbox"
          checked={draft.scenarioOverride !== null}
          onChange={(e) =>
            setDraft('scenarioOverride', e.currentTarget.checked ? inheritedScenario() : null)
          }
        />
        <span>Override the character scenario for this conversation</span>
      </label>

      <Show when={draft.scenarioOverride !== null}>
        <label>
          Conversation scenario <MacroHelp />
        </label>
        <MacroTextarea
          ref={(el) => {
            scenarioEl = el;
            el.value = draft.scenarioOverride ?? '';
          }}
          placeholder="Leave empty to omit the scenario from this conversation"
          onText={(text) => setDraft('scenarioOverride', text)}
        />
      </Show>

      <div class="form-actions">
        <button class="primary-btn" onClick={() => void save()}>
          Save
        </button>
        <button onClick={discard}>Discard</button>
        <button onClick={() => download(`/api/conversations/${props.conv.id}/export`)}>
          Export JSON
        </button>
        <Show when={saved()}>
          <span class="saved-flash">✓ Saved</span>
        </Show>
      </div>
      <Show when={error()}>
        <p class="hint">{error()}</p>
      </Show>
    </div>
  );
}

export default function ConversationSettings() {
  const [promptOpen, setPromptOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  let actions: SettingsSectionActions | undefined;

  const register = (next: SettingsSectionActions) => {
    actions = next;
    return () => {
      if (actions === next) actions = undefined;
    };
  };
  const close = () => openModal(null);
  const requestClose = () => {
    if (!actions?.isDirty()) close();
    else setPromptOpen(true);
  };
  const saveAndClose = async () => {
    if (!actions || saving()) return;
    setSaving(true);
    const ok = await actions.save();
    setSaving(false);
    if (ok) close();
    else setPromptOpen(false);
  };
  const discardAndClose = () => {
    actions?.discard();
    close();
  };

  return (
    <>
      <Show when={selectedConversation()}>
        {(conv) => (
          <Modal title="Conversation settings" onClose={requestClose}>
            <Editor conv={conv()} register={register} />
          </Modal>
        )}
      </Show>
      <Show when={promptOpen()}>
        <div class="modal-backdrop settings-prompt-backdrop">
          <div
            class="settings-prompt"
            role="dialog"
            aria-modal="true"
            aria-labelledby="conversation-save-prompt-title"
          >
            <span class="modal-title" id="conversation-save-prompt-title">
              Save changes?
            </span>
            <p>You have unsaved conversation settings.</p>
            <div class="form-actions">
              <button class="primary-btn" disabled={saving()} onClick={() => void saveAndClose()}>
                {saving() ? 'Saving…' : 'Save'}
              </button>
              <button disabled={saving()} onClick={discardAndClose}>
                Discard
              </button>
              <button disabled={saving()} onClick={() => setPromptOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
