import { DEFAULT_PROMPT_TEMPLATE, DEFAULT_STEER_TEMPLATE } from '@minitavern/shared';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { createEntityEditor } from '../../util.ts';
import EntityEditorPane from '../EntityEditorPane.tsx';
import MacroHelp from '../MacroHelp.tsx';
import MacroTextarea from '../MacroTextarea.tsx';

export default function TemplatesTab() {
  let nameEl!: HTMLInputElement;
  let contentEl!: HTMLTextAreaElement;
  let prologueEl!: HTMLTextAreaElement;
  let reasoningPrefillEl!: HTMLTextAreaElement;
  let messagePrefillEl!: HTMLTextAreaElement;
  let prefixEl!: HTMLInputElement;
  let usesPersonasEl!: HTMLInputElement;
  let steerEl!: HTMLTextAreaElement;

  const editor = createEntityEditor({
    items: () => state.templates,
    load: (template) => {
      nameEl.value = template?.name ?? '';
      contentEl.value = template?.content ?? DEFAULT_PROMPT_TEMPLATE;
      prologueEl.value = template?.userPrologue ?? '';
      reasoningPrefillEl.value = template?.reasoningPrefill ?? '';
      messagePrefillEl.value = template?.messagePrefill ?? '';
      prefixEl.checked = template?.prefixNames ?? false;
      usesPersonasEl.checked = template?.usesPersonas ?? true;
      steerEl.value = template?.steerTemplate ?? DEFAULT_STEER_TEMPLATE;
    },
    data: () => ({
      name: nameEl.value,
      content: contentEl.value,
      userPrologue: prologueEl.value,
      reasoningPrefill: reasoningPrefillEl.value,
      messagePrefill: messagePrefillEl.value,
      prefixNames: prefixEl.checked,
      usesPersonas: usesPersonasEl.checked,
      steerTemplate: steerEl.value,
    }),
    create: api.createTemplate,
    patch: api.patchTemplate,
    remove: api.deleteTemplate,
    deletePrompt: 'Delete this template?',
  });

  return (
    <EntityEditorPane
      editor={editor}
      items={state.templates}
      itemLabel={(template) => template.name}
      newLabel="+ New template"
    >
      <label>Name</label>
      <input ref={nameEl} placeholder="Roleplay" />
      <label>
        System prompt template <MacroHelp template />
      </label>
      <MacroTextarea ref={contentEl} template class="mono" />
      <label>
        First user message (optional — sent as a fake user turn before the history){' '}
        <MacroHelp template />
      </label>
      <MacroTextarea
        ref={prologueEl}
        template
        class="mono"
        placeholder="Leave empty to send no fake user message"
      />
      <label>
        Reasoning prefill (optional) <MacroHelp template />
      </label>
      <MacroTextarea
        ref={reasoningPrefillEl}
        template
        class="mono"
        placeholder="Leave empty to let the model start reasoning"
      />
      <label>
        Assistant message prefill (optional) <MacroHelp template />
      </label>
      <MacroTextarea
        ref={messagePrefillEl}
        template
        class="mono"
        placeholder="Leave empty to let the model start the visible reply"
      />
      <p class="hint">
        A reasoning prefill continues the model's reasoning. Adding a message prefill continues
        the visible reply from that text. Both become part of the saved response.
      </p>
      <label class="check-row">
        <input ref={prefixEl} type="checkbox" />
        Prefix speaker names into messages ("{'{{user}}'}: …", "{'{{char}}'}: …") and prefill the
        reply with the current speaker name (see /char)
      </label>
      <label class="check-row">
        <input ref={usesPersonasEl} type="checkbox" />
        Uses personas — when off, chats with this template ignore the persona entirely ("
        {'{{user}}'}" becomes "User", the persona description is not sent)
      </label>
      <label>Steer template (regenerate with instruction)</label>
      <MacroTextarea ref={steerEl} keys={['instruction']} rows={2} />
      <p class="hint">
        {'{{instruction}}'} is replaced with your instruction and injected into that regeneration's
        prompt only. Leave empty to use the built-in default.
      </p>
    </EntityEditorPane>
  );
}
