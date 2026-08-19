import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { createEntityEditor } from '../../util.ts';
import EntityEditorPane from '../EntityEditorPane.tsx';
import MacroHelp from '../MacroHelp.tsx';
import MacroTextarea from '../MacroTextarea.tsx';

export default function PresetsTab() {
  let nameEl!: HTMLInputElement;
  let contentEl!: HTMLTextAreaElement;
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
  });

  return (
    <EntityEditorPane
      editor={editor}
      items={state.presets}
      itemLabel={(preset) => preset.name}
      newLabel="+ New preset"
    >
      <label>Name</label>
      <input ref={nameEl} placeholder="Creative writer" />
      <label>
        System prompt <MacroHelp />
      </label>
      <MacroTextarea ref={contentEl} placeholder="You are {{char}}, …" />
    </EntityEditorPane>
  );
}
