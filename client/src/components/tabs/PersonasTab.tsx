import { Show, createSignal } from 'solid-js';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { avatarGenerationAvailable } from '../../plugins/imageGeneration.tsx';
import AvatarGenerateModal from '../../plugins/AvatarGenerateModal.tsx';
import { createEntityEditor } from '../../util.ts';
import Avatar from '../Avatar.tsx';
import AvatarRow from '../AvatarRow.tsx';
import EntityEditorPane from '../EntityEditorPane.tsx';
import MacroHelp from '../MacroHelp.tsx';
import MacroTextarea from '../MacroTextarea.tsx';

export default function PersonasTab() {
  const [avatarGen, setAvatarGen] = createSignal(false);
  let nameEl!: HTMLInputElement;
  let descriptionEl!: HTMLTextAreaElement;

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
      newLabel="+ New persona"
    >
      <Show when={editor.selectedId() !== 'new'}>
        <AvatarRow
          src={editor.selected()?.avatar}
          name={editor.selected()?.name ?? '?'}
          upload={(file) => api.uploadPersonaAvatar(editor.selectedId() as number, file)}
          remove={() => api.deletePersonaAvatar(editor.selectedId() as number)}
          generate={
            avatarGenerationAvailable()
              ? async () => {
                  setAvatarGen(true);
                }
              : undefined
          }
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
      <label>Name (used as {'{{user}}'})</label>
      <input ref={nameEl} placeholder="Your name" />
      <label>
        Description (injected into the prompt) <MacroHelp />
      </label>
      <MacroTextarea ref={descriptionEl} placeholder="A few sentences about {{user}} (optional)" />
    </EntityEditorPane>
  );
}
