import { exportEntityDraft } from '../settingsSchema.ts';
import EntityFolderField from '../EntityFolderField.tsx';
import SettingsSection from '../SettingsSection.tsx';
import type { Persona } from '@tinytavern/shared';
import SettingLabel, { createDefaultField } from '../../forms/SettingField.tsx';
import { Show, createSignal } from 'solid-js';
import { api } from '../../../state/api.ts';
import { selectSettingsEntity } from '../../../state/settingsSelection.ts';
import { state } from '../../../state/store.ts';
import { avatarGenerationAvailable } from '../../../images/imageGeneration.tsx';
import AvatarGenerateModal from '../../../images/AvatarGenerateModal.tsx';
import { createEntityEditor } from '../../../util.ts';
import Avatar from '../../ui/Avatar.tsx';
import AvatarRow from '../../forms/AvatarRow.tsx';
import EntityEditorPane from '../EntityEditorPane.tsx';
import MacroHelp from '../../forms/MacroHelp.tsx';
import MacroTextarea from '../../forms/MacroTextarea.tsx';
import { avatarEditorSnapshot } from '../../../state/editorSync.ts';

export default function PersonasTab() {
  const [avatarData, setAvatarData] = createSignal<string | null | undefined>();
  const [avatarGen, setAvatarGen] = createSignal(false);
  const nameEl = createDefaultField(() => '');
  const folderEl = createDefaultField(() => '');
  const descriptionEl = createDefaultField(() => '');

  const editor = createEntityEditor({
    ...api.personas,
    items: () => state.personas,
    snapshot: avatarEditorSnapshot,
    load: (persona: (Persona & { avatarData?: string | null }) | undefined) => {
      setAvatarData(persona?.avatarData);
      nameEl.value = persona?.name ?? '';
      folderEl.value = String(persona?.folderId ?? '');
      descriptionEl.value = persona?.description ?? '';
    },
    data: () => ({
      name: nameEl.value,
      folderId: folderEl.value ? Number(folderEl.value) : null,
      description: descriptionEl.value,
      ...(avatarData() === undefined ? {} : { avatarData: avatarData() }),
    }),
    create: (data) =>
      data.avatarData === undefined
        ? api.personas.create(data)
        : api.personas.import(exportEntityDraft('personas', data), null),
    patch: (id, data) =>
      data.avatarData === undefined
        ? api.personas.patch(id, data)
        : api.personas.import(
            exportEntityDraft('personas', {
              name: nameEl.value,
              description: descriptionEl.value,
              folderId: folderEl.value ? Number(folderEl.value) : null,
              ...data,
            }),
            id,
          ),
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
      <SettingsSection
        title="Basics"
        id="persona-basics"
        fields={['name', 'folderId', 'avatarData']}
      >
        <Show when={avatarData() !== undefined}>
          <div class="flex items-center gap-3 [&_.avatar]:size-14">
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
            upload={(file) => api.personas.uploadAvatar(editor.selectedId() as number, file)}
            remove={() => api.personas.deleteAvatar(editor.selectedId() as number)}
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
        <EntityFolderField type="personas" field={folderEl} />
      </SettingsSection>
      <SettingsSection
        title="Persona description"
        id="persona-description"
        fields={['description']}
      >
        <SettingLabel field={descriptionEl}>
          Description (injected into the prompt) <MacroHelp />
        </SettingLabel>
        <MacroTextarea
          ref={descriptionEl.ref}
          placeholder="A few sentences about {{user}} (optional)"
        />
      </SettingsSection>
    </EntityEditorPane>
  );
}
