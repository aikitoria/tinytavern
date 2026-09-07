import SettingLabel, { createDefaultField } from '../SettingField.tsx';
import { Show, createSignal } from 'solid-js';
import { api } from '../../state/api.ts';
import { selectSettingsEntity } from '../../state/settingsSelection.ts';
import { state } from '../../state/store.ts';
import { avatarGenerationAvailable } from '../../images/imageGeneration.tsx';
import AvatarGenerateModal from '../../images/AvatarGenerateModal.tsx';
import { createEntityEditor } from '../../util.ts';
import Avatar from '../Avatar.tsx';
import AvatarRow from '../AvatarRow.tsx';
import EntityEditorPane from '../EntityEditorPane.tsx';
import MacroHelp from '../MacroHelp.tsx';
import MacroTextarea from '../MacroTextarea.tsx';

export default function PersonasTab() {
  const [avatarGen, setAvatarGen] = createSignal(false);
  const nameEl = createDefaultField(() => '');
  const descriptionEl = createDefaultField(() => '');

  const editor = createEntityEditor({
    items: () => state.personas,
    load: (persona) => {
      nameEl.value = persona?.name ?? '';
      descriptionEl.value = persona?.description ?? '';
    },
    data: () => ({ name: nameEl.value, description: descriptionEl.value }),
    create: api.createPersona,
    patch: api.patchPersona,
    remove: api.deletePersona,
    duplicate: api.duplicatePersona,
    deletePrompt: 'Delete this persona?',
    initialId: () => state.settings.defaultPersonaId,
    activate: (id) => selectSettingsEntity('defaultPersonaId', id),
  });

  return (
    <EntityEditorPane
      editor={editor}
      items={state.personas}
      itemLabel={(persona) => (
        <>
          <Avatar src={persona.avatar} name={persona.name} /> {persona.name}
        </>
      )}
      newLabel="New persona"
      activeId={state.settings.defaultPersonaId}
      defaultOption={{
        label: 'No default persona',
        description: 'New conversations will start without a persona selected.',
      }}
    >
      <Show when={typeof editor.selectedId() === 'number'}>
        <AvatarRow
          src={editor.selected()?.avatar}
          name={editor.selected()?.name ?? '?'}
          upload={(file) => api.uploadPersonaAvatar(editor.selectedId() as number, file)}
          remove={() => api.deletePersonaAvatar(editor.selectedId() as number)}
          generate={avatarGenerationAvailable() ? () => setAvatarGen(true) : undefined}
          onDone={editor.flashSaved}
          onError={editor.setStatus}
        />
        <Show when={avatarGen()}>
          <AvatarGenerateModal
            kind="persona"
            id={editor.selectedId() as number}
            onClose={() => setAvatarGen(false)}
          />
        </Show>
      </Show>
      <SettingLabel field={nameEl}>Name (used as {'{{user}}'})</SettingLabel>
      <input ref={nameEl.ref} placeholder="Your name" />
      <SettingLabel field={descriptionEl}>
        Description (injected into the prompt) <MacroHelp />
      </SettingLabel>
      <MacroTextarea
        ref={descriptionEl.ref}
        placeholder="A few sentences about {{user}} (optional)"
      />
    </EntityEditorPane>
  );
}
