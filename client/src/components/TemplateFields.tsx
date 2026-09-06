import type { CustomTemplate } from '@minitavern/shared';
import { DEFAULT_PROMPT_TEMPLATE, DEFAULT_STEER_TEMPLATE } from '@minitavern/shared';
import MacroHelp from './MacroHelp.tsx';
import MacroTextarea from './MacroTextarea.tsx';

export interface TemplateFieldsHandle {
  get value(): CustomTemplate;
  set value(template: CustomTemplate | null | undefined);
}

/** Kept mounted by both editors so loading and dirty checks use the same DOM-backed values. */
export default function TemplateFields(props: {
  ref: TemplateFieldsHandle | ((handle: TemplateFieldsHandle) => void);
  inline?: boolean;
}) {
  let contentEl!: HTMLTextAreaElement;
  let prologueEl!: HTMLTextAreaElement;
  let reasoningPrefillEl!: HTMLTextAreaElement;
  let messagePrefillEl!: HTMLTextAreaElement;
  let prefixEl!: HTMLInputElement;
  let usesPersonasEl!: HTMLInputElement;
  let steerEl!: HTMLTextAreaElement;
  const handle: TemplateFieldsHandle = {
    get value() {
      return {
        content: contentEl.value,
        userPrologue: prologueEl.value,
        reasoningPrefill: reasoningPrefillEl.value,
        messagePrefill: messagePrefillEl.value,
        prefixNames: prefixEl.checked,
        usesPersonas: usesPersonasEl.checked,
        steerTemplate: steerEl.value,
      };
    },
    set value(template) {
      contentEl.value = template?.content ?? (props.inline ? '' : DEFAULT_PROMPT_TEMPLATE);
      prologueEl.value = template?.userPrologue ?? '';
      reasoningPrefillEl.value = template?.reasoningPrefill ?? '';
      messagePrefillEl.value = template?.messagePrefill ?? '';
      prefixEl.checked = template?.prefixNames ?? false;
      usesPersonasEl.checked = template?.usesPersonas ?? true;
      steerEl.value = template?.steerTemplate ?? DEFAULT_STEER_TEMPLATE;
    },
  };
  if (typeof props.ref === 'function') props.ref(handle);
  return (
    <>
      <label>
        {props.inline ? 'Custom template — system prompt' : 'System prompt template'}{' '}
        <MacroHelp template />
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
        {props.inline ? 'Custom template — reasoning prefill' : 'Reasoning prefill'} (optional){' '}
        <MacroHelp template />
      </label>
      <MacroTextarea
        ref={reasoningPrefillEl}
        template
        class="mono"
        placeholder="Leave empty to let the model start reasoning"
      />
      <label>
        {props.inline ? 'Custom template — assistant message prefill' : 'Assistant message prefill'}{' '}
        (optional) <MacroHelp template />
      </label>
      <MacroTextarea
        ref={messagePrefillEl}
        template
        class="mono"
        placeholder="Leave empty to let the model start the visible reply"
      />
      <p class="hint">
        A reasoning prefill continues the model's reasoning. Adding a message prefill continues the
        visible reply from that text. Both become part of the saved response.
      </p>
      <label class="check-row">
        <input ref={prefixEl} type="checkbox" />
        Prefix speaker names into messages ("{'{{user}}'}: …", "{'{{char}}'}: …") and prefill the
        reply with the current speaker name (see /char)
      </label>
      <label class="check-row">
        <input ref={usesPersonasEl} type="checkbox" />
        Uses personas — when off, chats with this {props.inline ? 'character' : 'template'} ignore
        the persona entirely ("
        {'{{user}}'}" becomes "User", the persona description is not sent)
      </label>
      <label>
        {props.inline ? 'Custom template — steer template' : 'Steer template'} (regenerate with
        instruction)
      </label>
      <MacroTextarea ref={steerEl} keys={['instruction']} rows={2} />
      <p class="hint">
        {'{{instruction}}'} is replaced with your instruction and injected into that regeneration's
        prompt only. Leave empty to use the built-in default.
      </p>
    </>
  );
}
