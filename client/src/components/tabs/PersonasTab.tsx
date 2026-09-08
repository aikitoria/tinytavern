import type { Persona } from '@tinytavern/shared';
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
  const [avatarData, setAvatarData] = createSignal<string | null | undefined>();
  const [avatarGen, setAvatarGen] = createSignal(false);
  const nameEl = createDefaultField(() => '');
  const descriptionEl = createDefaultField(() => '');

  const editor = createEntityEditor({
    items: () => state.personas,
    load: (persona: (Persona & { avatarData?: string | null }) | undefined) => {
      setAvatarData(persona?.avatarData);
      nameEl.value = persona?.name ?? '';
      descriptionEl.value = persona?.description ?? '';
    },
    data: () => ({
      name: nameEl.value,
      description: descriptionEl.value,
      ...(avatarData() === undefined ? {} : { avatarData: avatarData() }),
    }),
    create: (data) =>
      data.avatarData === undefined ? api.createPersona(data) : api.importPersona(data, null),
    patch: (id, data) =>
      data.avatarData === undefined
        ? api.patchPersona(id, data)
        : api.importPersona({ name: nameEl.value, description: descriptionEl.value, ...data }, id),
    remove: api.deletePersona,
    duplicate: api.duplicatePersona,
    deletePrompt: 'Delete this persona?',
    initialId: () => state.settings.defaultPersonaId,
    activate: (id) => selectSettingsEntity('defaultPersonaId', id),
  });

  return (
    <EntityEditorPane
      editor={editor}
      transferType="personas"
      items={state.personas}
      itemLabel={(persona) => (
        <>
          <Avatar src={persona.avatarThumbnail} name={persona.name} /> {persona.name}
        </>
      )}
      newLabel="New persona"
      activeId={state.settings.defaultPersonaId}
      defaultOption={{
        label: 'No default persona',
        description: 'New conversations will start without a persona selected.',
      }}
    >
      <section class="settings-section">
        <h3>Basics</h3>
        <Show when={avatarData() !== undefined}>
          <div class="avatar-row">
            <Avatar src={avatarData()} name={nameEl.value || '?'} />
            <span class="hint">
              {avatarData() === null
                ? 'Avatar will be removed on save.'
                : 'Imported avatar · save to apply.'}
            </span>
          </div>
        </Show>
        <Show when={typeof editor.selectedId() === 'number' && avatarData() === undefined}>
          <AvatarRow
            src={editor.selected()?.avatar}
            thumbnail={editor.selected()?.avatarThumbnail}
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
      </section>
      <section class="settings-section">
        <h3>Persona description</h3>
        <SettingLabel field={descriptionEl}>
          Description (injected into the prompt) <MacroHelp />
        </SettingLabel>
        <MacroTextarea
          ref={descriptionEl.ref}
          placeholder="A few sentences about {{user}} (optional)"
        />
      </section>
    </EntityEditorPane>
  );
}
