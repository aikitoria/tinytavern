import EntityFolderField from '../EntityFolderField.tsx';
import SettingsSection from '../SettingsSection.tsx';
import SettingLabel, { createDefaultField } from '../../forms/SettingField.tsx';
import { api } from '../../../state/api.ts';
import { selectSettingsEntity } from '../../../state/settingsSelection.ts';
import { state } from '../../../state/store.ts';
import { createEntityEditor } from '../../../util.ts';
import EntityEditorPane from '../EntityEditorPane.tsx';
import TemplateFields, { type TemplateFieldsHandle } from '../../forms/TemplateFields.tsx';

export default function TemplatesTab() {
  const nameEl = createDefaultField(() => '');
  const folderEl = createDefaultField(() => '');
  let fields!: TemplateFieldsHandle;

  const editor = createEntityEditor({
    ...api.templates,
    items: () => state.templates,
    load: (template) => {
      nameEl.value = template?.name ?? '';
      folderEl.value = String(template?.folderId ?? '');
      fields.value = template;
    },
    data: () => ({
      name: nameEl.value,
      folderId: folderEl.value ? Number(folderEl.value) : null,
      ...fields.value,
    }),
    deletePrompt: 'Delete this template?',
    initialId: () => state.settings.defaultTemplateId,
    emptySelection: 'new',
    activate: (id) => selectSettingsEntity('defaultTemplateId', id),
  });

  const readOnly = () => editor.selected()?.readOnly === true;

  return (
    <EntityEditorPane
      editor={editor}
      transferType="templates"
      readOnly={readOnly()}
      items={state.templates}
      itemLabel={(template) => template.name}
      newLabel="New template"
      activeId={state.settings.defaultTemplateId}
    >
      <SettingsSection title="Basics" id="template-basics" fields={['name', 'folderId']}>
        <SettingLabel for={nameEl.id()} field={readOnly() ? undefined : nameEl}>
          Name
        </SettingLabel>
        <input readOnly={readOnly()} ref={nameEl.ref} placeholder="Roleplay" />
        <EntityFolderField type="templates" field={folderEl} readOnly={readOnly()} />
      </SettingsSection>
      <TemplateFields readOnly={readOnly()} ref={fields} />
    </EntityEditorPane>
  );
}
