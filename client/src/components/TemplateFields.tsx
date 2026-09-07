import { Show } from 'solid-js';
import SettingLabel, { createDefaultField } from './SettingField.tsx';
import type { CustomTemplate } from '@tinytavern/shared';
import { DEFAULT_PROMPT_TEMPLATE, DEFAULT_STEER_TEMPLATE } from '@tinytavern/shared';
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
  const contentEl = createDefaultField(() => (props.inline ? '' : DEFAULT_PROMPT_TEMPLATE));
  const prologueEl = createDefaultField(() => '');
  const reasoningPrefillEl = createDefaultField(() => '');
  const messagePrefillEl = createDefaultField(() => '');
  const prefixEl = createDefaultField(() => false);
  const usesPersonasEl = createDefaultField(() => true);
  const steerEl = createDefaultField(() => DEFAULT_STEER_TEMPLATE);
  const handle: TemplateFieldsHandle = {
    get value() {
      return {
        content: contentEl.value,
        userPrologue: prologueEl.value,
        reasoningPrefill: reasoningPrefillEl.value,
        messagePrefill: messagePrefillEl.value,
        prefixNames: prefixEl.value,
        usesPersonas: usesPersonasEl.value,
        steerTemplate: steerEl.value,
      };
    },
    set value(template) {
      contentEl.value = template?.content ?? (props.inline ? '' : DEFAULT_PROMPT_TEMPLATE);
      prologueEl.value = template?.userPrologue ?? '';
      reasoningPrefillEl.value = template?.reasoningPrefill ?? '';
      messagePrefillEl.value = template?.messagePrefill ?? '';
      prefixEl.value = template?.prefixNames ?? false;
      usesPersonasEl.value = template?.usesPersonas ?? true;
      steerEl.value = template?.steerTemplate ?? DEFAULT_STEER_TEMPLATE;
    },
  };
  if (typeof props.ref === 'function') props.ref(handle);
  return (
    <>
      <section class={props.inline ? 'form-stack' : 'settings-section'}>
        <Show when={!props.inline}>
          <h3>Prompt assembly</h3>
        </Show>
        <SettingLabel field={contentEl}>
          {props.inline ? 'Custom template — system prompt' : 'System prompt template'}{' '}
          <MacroHelp template />
        </SettingLabel>
        <MacroTextarea ref={contentEl.ref} template class="mono" />
        <SettingLabel field={prologueEl}>
          First user message (optional — sent as a fake user turn before the history){' '}
          <MacroHelp template />
        </SettingLabel>
        <MacroTextarea
          ref={prologueEl.ref}
          template
          class="mono"
          placeholder="Leave empty to send no fake user message"
        />
      </section>
      <section class={props.inline ? 'form-stack' : 'settings-section'}>
        <Show when={!props.inline}>
          <h3>Prefills</h3>
        </Show>
        <SettingLabel field={reasoningPrefillEl}>
          {props.inline ? 'Custom template — reasoning prefill' : 'Reasoning prefill'} (optional){' '}
          <MacroHelp template />
        </SettingLabel>
        <MacroTextarea
          ref={reasoningPrefillEl.ref}
          template
          class="mono"
          placeholder="Leave empty to let the model start reasoning"
        />
        <SettingLabel field={messagePrefillEl}>
          {props.inline
            ? 'Custom template — assistant message prefill'
            : 'Assistant message prefill'}{' '}
          (optional) <MacroHelp template />
        </SettingLabel>
        <MacroTextarea
          ref={messagePrefillEl.ref}
          template
          class="mono"
          placeholder="Leave empty to let the model start the visible reply"
        />
        <p class="hint">
          A reasoning prefill continues the model's reasoning. Adding a message prefill continues
          the visible reply from that text. Both become part of the saved response.
        </p>
      </section>
      <section class={props.inline ? 'form-stack' : 'settings-section'}>
        <Show when={!props.inline}>
          <h3>Advanced</h3>
        </Show>
        <SettingLabel field={prefixEl} check>
          <input ref={prefixEl.ref} type="checkbox" />
          Prefix speaker names into messages ("{'{{user}}'}: …", "{'{{char}}'}: …") and prefill the
          reply with the current speaker name (see /char)
        </SettingLabel>
        <SettingLabel field={usesPersonasEl} check>
          <input ref={usesPersonasEl.ref} type="checkbox" />
          Uses personas — when off, chats with this {props.inline ? 'character' : 'template'} ignore
          the persona entirely ("
          {'{{user}}'}" becomes "User", the persona description is not sent)
        </SettingLabel>
        <SettingLabel field={steerEl}>
          {props.inline ? 'Custom template — steer template' : 'Steer template'} (regenerate with
          instruction)
        </SettingLabel>
        <MacroTextarea ref={steerEl.ref} keys={['instruction']} rows={2} />
        <p class="hint">
          {'{{instruction}}'} is replaced with your instruction and injected into that
          regeneration's prompt only. Leave empty to use the built-in default.
        </p>
      </section>
    </>
  );
}
