import SettingsSection from '../SettingsSection.tsx';
import SettingLabel, { createDefaultField } from '../../forms/SettingField.tsx';
import { api } from '../../../state/api.ts';
import { selectSettingsEntity } from '../../../state/settingsSelection.ts';
import { state } from '../../../state/store.ts';
import { createEntityEditor } from '../../../util.ts';
import EntityEditorPane from '../EntityEditorPane.tsx';
import MacroHelp from '../../forms/MacroHelp.tsx';
import MacroTextarea from '../../forms/MacroTextarea.tsx';

export default function PresetsTab() {
  const nameEl = createDefaultField(() => '');
  const contentEl = createDefaultField(() => '');
  const editor = createEntityEditor({
    ...api.presets,
    items: () => state.presets,
    load: (preset) => {
      nameEl.value = preset?.name ?? '';
      contentEl.value = preset?.content ?? '';
    },
    data: () => ({ name: nameEl.value, content: contentEl.value }),
    deletePrompt: 'Delete this preset?',
    initialId: () => state.settings.defaultPresetId,
    emptySelection: 'new',
    activate: (id) => selectSettingsEntity('defaultPresetId', id),
  });

  const readOnly = () => editor.selected()?.readOnly === true;

  return (
    <EntityEditorPane
      editor={editor}
      transferType="presets"
      readOnly={readOnly()}
      items={state.presets}
      itemLabel={(preset) => preset.name}
      newLabel="New preset"
      activeId={state.settings.defaultPresetId}
    >
      <SettingsSection title="Basics" id="preset-basics" fields={['name']}>
        <SettingLabel for={nameEl.id()} field={readOnly() ? undefined : nameEl}>
          Name
        </SettingLabel>
        <input readOnly={readOnly()} ref={nameEl.ref} placeholder="Creative writer" />
      </SettingsSection>
      <SettingsSection title="System prompt" id="system-prompt" fields={['content']}>
        <SettingLabel for={contentEl.id()} field={readOnly() ? undefined : contentEl}>
          System instructions <MacroHelp />
        </SettingLabel>
        <MacroTextarea
          readOnly={readOnly()}
          ref={contentEl.ref}
          placeholder="You are {{char}}, …"
        />
      </SettingsSection>
    </EntityEditorPane>
  );
}
