import { entityOptions, editReferencedEntity } from '../../state/entityReferences.ts';
import { useDialogNavigationGuard } from '../../state/dialogContext.ts';
import { createDefaultField } from '../forms/SettingField.tsx';
import FormField from '../forms/FormFields.tsx';
import SettingsActions from '../settings/SettingsActions.tsx';
import { Show, createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { characterChatName, type Conversation } from '@tinytavern/shared';
import { api } from '../../state/api.ts';
import {
  duplicateConversation,
  openCharacterSettings,
  openModal,
  selectedConversation,
  state,
  toast,
} from '../../state/store.ts';
import { createSavedFlash, download, errorMessage, numberOrNull } from '../../util.ts';
import { changedFields, mergeRemoteDraft, sameValue } from '../../state/editorSync.ts';
import Avatar from '../ui/Avatar.tsx';
import Modal from '../ui/Modal.tsx';
import MacroHelp from '../forms/MacroHelp.tsx';
import {
  createSettingsNavigation,
  SettingsNavigationPrompt,
  type SettingsSectionActions,
} from '../settings/SettingsGuard.tsx';

type Draft = Pick<
  Conversation,
  'title' | 'personaId' | 'endpointId' | 'speakerName' | 'scenarioOverride'
>;
const snapshot = (conv: Conversation): Draft => ({
  title: conv.title,
  personaId: conv.personaId,
  endpointId: conv.endpointId,
  speakerName: conv.speakerName,
  scenarioOverride: conv.scenarioOverride,
});

function Editor(props: {
  conv: Conversation;
  register: (actions: SettingsSectionActions) => () => void;
  navigate: (action: () => void) => void;
}) {
  const titleField = createDefaultField(() => 'New chat');
  const speakerField = createDefaultField(() => '');
  const personaField = createDefaultField(() => '');
  const endpointField = createDefaultField(() => '');
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
    const dirty = changedFields(base, draft);
    try {
      const updated = await api.patchConversation(
        props.conv.id,
        state.tree.conversationId === props.conv.id ? state.tree : props.conv,
        dirty,
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

  const duplicateChat = () => {
    const id = props.conv.id;
    props.navigate(() => {
      void duplicateConversation(id).catch((err) => toast(errorMessage(err)));
    });
  };

  return (
    <div class="form [&_label]:text-label [&_label]:text-foreground [&_label]:mt-2">
      <FormField
        label="Title"
        field={titleField}
        value={draft.title}
        inputEvent="change"
        onChange={(next) => setDraft('title', next)}
      />

      <label>Character</label>
      <div class="min-h-10 py-control-y px-3 text-foreground bg-canvas border border-solid border-line flex items-center gap-2 rounded-sm [&_.avatar]:text-xs [&_.avatar]:size-6">
        <Avatar src={character()?.avatarThumbnail} name={character()?.name ?? 'Assistant'} />
        <span class="truncate min-w-0">{character()?.name ?? 'Assistant'}</span>
        <Show when={character()}>
          {(current) => (
            <button
              type="button"
              class="conversation-character-edit flex-none p-0 ml-auto text-dim text-sm bg-clear border-clear [&:hover]:bg-clear [&:hover]:text-foreground"
              onClick={() => openCharacterSettings(current().id)}
            >
              Edit character
            </button>
          )}
        </Show>
      </div>

      <FormField
        field={speakerField}
        inputEvent="change"
        label="Speaker name (assistant replies; empty = character's name, also set via /char)"
        value={draft.speakerName ?? ''}
        placeholder={characterChatName(character())}
        onChange={(next) => setDraft('speakerName', next.trim() || null)}
      />
      <FormField
        label="Persona"
        field={personaField}
        value={draft.personaId?.toString() ?? ''}
        ariaLabel="Conversation persona"
        onChange={(next) => setDraft('personaId', numberOrNull(next))}
        options={[{ value: '', label: '— none —' }, ...entityOptions('personas', state.personas)]}
      />
      <FormField
        field={endpointField}
        value={draft.endpointId?.toString() ?? ''}
        label="Endpoint (overrides the global active endpoint for this conversation)"
        ariaLabel="Conversation endpoint"
        onChange={(next) => setDraft('endpointId', numberOrNull(next))}
        options={[
          {
            value: '',
            label: '— global default —',
            edit:
              state.settings.activeEndpointId != null
                ? () => editReferencedEntity('endpoints', state.settings.activeEndpointId!)
                : undefined,
          },
          ...entityOptions('endpoints', state.endpoints),
        ]}
      />
      <FormField
        kind="check"
        label={<span>Override the character scenario for this conversation</span>}
        value={draft.scenarioOverride !== null}
        defaultValue={false}
        onChange={(next) => setDraft('scenarioOverride', next ? inheritedScenario() : null)}
      />
      <Show when={draft.scenarioOverride !== null}>
        <FormField
          kind="macro"
          label={
            <>
              Conversation scenario <MacroHelp />
            </>
          }
          changed={draft.scenarioOverride !== null}
          onRevert={() => setDraft('scenarioOverride', null)}
          value={draft.scenarioOverride ?? ''}
          placeholder="Leave empty to omit the scenario from this conversation"
          onChange={(text: string) => setDraft('scenarioOverride', text)}
        />
      </Show>

      <Show when={error()}>
        <p class="notice notice-error" role="alert">
          {error()}
        </p>
      </Show>
      <SettingsActions inline save={save} discard={discard} saved={saved()}>
        <button onClick={duplicateChat}>Duplicate chat</button>
        <button
          title="Export messages and images; videos are omitted"
          onClick={() => download(`/api/conversations/${props.conv.id}/export`)}
        >
          Export JSON
        </button>
      </SettingsActions>
    </div>
  );
}

export default function ConversationSettings() {
  const navigation = createSettingsNavigation();
  useDialogNavigationGuard(navigation.navigate);

  return (
    <>
      <Show when={selectedConversation()}>
        {(conv) => (
          <Modal
            title="Conversation settings"
            onClose={() => navigation.navigate(() => openModal(null))}
          >
            <Editor conv={conv()} register={navigation.register} navigate={navigation.navigate} />
          </Modal>
        )}
      </Show>
      <SettingsNavigationPrompt navigation={navigation}>
        You have unsaved conversation settings.
      </SettingsNavigationPrompt>
    </>
  );
}
