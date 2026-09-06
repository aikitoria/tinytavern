import { Show, createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { Conversation } from '@tinytavern/shared';
import { api } from '../state/api.ts';
import { openModal, selectedConversation, state } from '../state/store.ts';
import { createSavedFlash, download, errorMessage, numberOrNull } from '../util.ts';
import { mergeRemoteDraft, sameValue } from '../state/editorSync.ts';
import Avatar from './Avatar.tsx';
import Modal from './Modal.tsx';
import MacroHelp from './MacroHelp.tsx';
import MacroTextarea from './MacroTextarea.tsx';
import Select from './Select.tsx';
import {
  createSettingsNavigation,
  SettingsNavigationPrompt,
  type SettingsSectionActions,
} from './SettingsGuard.tsx';

interface Draft {
  title: string;
  personaId: number | null;
  endpointId: number | null;
  speakerName: string | null;
  scenarioOverride: string | null;
}

function snapshot(conv: Conversation): Draft {
  return {
    title: conv.title,
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

  const character = () =>
    props.conv.characterId != null
      ? state.characters.find((candidate) => candidate.id === props.conv.characterId)
      : undefined;

  const inheritedScenario = () => character()?.scenario ?? '';

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
    // Patch only changed fields to preserve concurrent auto-titles and remote edits.
    const dirty = Object.fromEntries(
      (Object.keys(base) as (keyof Draft)[])
        .filter((key) => draft[key] !== base[key])
        .map((key) => [key, draft[key]]),
    );
    try {
      const updated = await api.patchConversation(
        props.conv.id,
        dirty,
        state.tree.conversationId === props.conv.id ? state.tree : props.conv,
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
      <div class="conversation-character-value">
        <Avatar src={character()?.avatar} name={character()?.name ?? 'Assistant'} />
        <span>{character()?.name ?? 'Assistant'}</span>
      </div>

      <label>Speaker name (assistant replies; empty = character's name, also set via /char)</label>
      <input
        value={draft.speakerName ?? ''}
        onChange={(e) => setDraft('speakerName', e.currentTarget.value.trim() || null)}
        placeholder={character()?.name ?? 'Assistant'}
      />

      <label>Persona</label>
      <Select
        value={draft.personaId?.toString() ?? ''}
        ariaLabel="Conversation persona"
        onChange={(v) => setDraft('personaId', numberOrNull(v))}
        options={[
          { value: '', label: '— none —' },
          ...state.personas.map((p) => ({ value: String(p.id), label: p.name })),
        ]}
      />

      <label>Endpoint (overrides the global active endpoint for this conversation)</label>
      <Select
        value={draft.endpointId?.toString() ?? ''}
        ariaLabel="Conversation endpoint"
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

      <Show when={error()}>
        <p class="notice notice-error" role="alert">
          {error()}
        </p>
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
    </div>
  );
}

export default function ConversationSettings() {
  const navigation = createSettingsNavigation();

  return (
    <>
      <Show when={selectedConversation()}>
        {(conv) => (
          <Modal
            title="Conversation settings"
            onClose={() => navigation.navigate(() => openModal(null))}
          >
            <Editor conv={conv()} register={navigation.register} />
          </Modal>
        )}
      </Show>
      <SettingsNavigationPrompt navigation={navigation}>
        You have unsaved conversation settings.
      </SettingsNavigationPrompt>
    </>
  );
}
