import { api } from '../../state/api.ts';
import { selectSettingsEntity } from '../../state/settingsSelection.ts';
import { state } from '../../state/store.ts';
import { createEntityEditor } from '../../util.ts';
import EntityEditorPane from '../EntityEditorPane.tsx';
import TemplateFields, { type TemplateFieldsHandle } from '../TemplateFields.tsx';

export default function TemplatesTab() {
  let nameEl!: HTMLInputElement;
  let fields!: TemplateFieldsHandle;

  const editor = createEntityEditor({
    items: () => state.templates,
    load: (template) => {
      nameEl.value = template?.name ?? '';
      fields.value = template;
    },
    data: () => ({
      name: nameEl.value,
      ...fields.value,
    }),
    create: api.createTemplate,
    patch: api.patchTemplate,
    remove: api.deleteTemplate,
    duplicate: api.duplicateTemplate,
    deletePrompt: 'Delete this template?',
    initialId: () => state.settings.defaultTemplateId,
    activate: (id) => selectSettingsEntity('defaultTemplateId', id),
  });

  return (
    <EntityEditorPane
      editor={editor}
      items={state.templates}
      itemLabel={(template) => template.name}
      newLabel="New template"
      activeId={state.settings.defaultTemplateId}
      defaultOption={{
        label: 'Built-in template',
        description:
          'The built-in prompt template is active. Select a saved template to make it the default.',
      }}
    >
      <label>Name</label>
      <input ref={nameEl} placeholder="Roleplay" />
      <TemplateFields ref={fields} />
    </EntityEditorPane>
  );
}
