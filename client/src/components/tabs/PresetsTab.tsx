import SettingLabel, { createDefaultField } from '../SettingField.tsx';
import { api } from '../../state/api.ts';
import { selectSettingsEntity } from '../../state/settingsSelection.ts';
import { state } from '../../state/store.ts';
import { createEntityEditor } from '../../util.ts';
import EntityEditorPane from '../EntityEditorPane.tsx';
import MacroHelp from '../MacroHelp.tsx';
import MacroTextarea from '../MacroTextarea.tsx';

export default function PresetsTab() {
  const nameEl = createDefaultField(() => '');
  const contentEl = createDefaultField(() => '');
  const editor = createEntityEditor({
    items: () => state.presets,
    load: (preset) => {
      nameEl.value = preset?.name ?? '';
      contentEl.value = preset?.content ?? '';
    },
    data: () => ({ name: nameEl.value, content: contentEl.value }),
    create: api.createPreset,
    patch: api.patchPreset,
    remove: api.deletePreset,
    duplicate: api.duplicatePreset,
    deletePrompt: 'Delete this preset?',
    initialId: () => state.settings.defaultPresetId,
    activate: (id) => selectSettingsEntity('defaultPresetId', id),
  });

  return (
    <EntityEditorPane
      editor={editor}
      items={state.presets}
      itemLabel={(preset) => preset.name}
      newLabel="New preset"
      activeId={state.settings.defaultPresetId}
      defaultOption={{
        label: 'No default prompt',
        description: 'Characters without their own prompt will leave the system-prompt slot empty.',
      }}
    >
      <section class="settings-section">
        <h3>Basics</h3>
        <SettingLabel field={nameEl}>Name</SettingLabel>
        <input ref={nameEl.ref} placeholder="Creative writer" />
      </section>
      <section class="settings-section">
        <h3>System prompt</h3>
        <SettingLabel field={contentEl}>
          Instructions <MacroHelp />
        </SettingLabel>
        <MacroTextarea ref={contentEl.ref} placeholder="You are {{char}}, …" />
      </section>
    </EntityEditorPane>
  );
}
