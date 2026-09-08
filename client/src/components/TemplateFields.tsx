import { Show } from 'solid-js';
import SettingLabel, { createDefaultField } from './SettingField.tsx';
import type { CustomTemplate } from '@tinytavern/shared';
import {
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_STEER_TEMPLATE,
  DEFAULT_SPEAKER_HANDOFF_TEMPLATE,
} from '@tinytavern/shared';
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
  readOnly?: boolean;
}) {
  const contentEl = createDefaultField(() => (props.inline ? '' : DEFAULT_PROMPT_TEMPLATE));
  const prologueEl = createDefaultField(() => '');
  const reasoningPrefillEl = createDefaultField(() => '');
  const messagePrefillEl = createDefaultField(() => '');
  const prefixEl = createDefaultField(() => false);
  const usesPersonasEl = createDefaultField(() => true);
  const speakerEl = createDefaultField(() => DEFAULT_SPEAKER_HANDOFF_TEMPLATE);
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
        speakerHandoffTemplate: speakerEl.value,
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
      speakerEl.value = template?.speakerHandoffTemplate ?? DEFAULT_SPEAKER_HANDOFF_TEMPLATE;
    },
  };
  if (typeof props.ref === 'function') props.ref(handle);
  return (
    <>
      <section class={props.inline ? 'form-stack' : 'settings-section'}>
        <Show when={!props.inline}>
          <h3>Prompt assembly</h3>
        </Show>
        <SettingLabel field={props.readOnly ? undefined : contentEl}>
          {props.inline ? 'Custom template — system prompt' : 'System prompt template'}{' '}
          <MacroHelp template />
        </SettingLabel>
        <MacroTextarea readOnly={props.readOnly} ref={contentEl.ref} template class="mono" />
        <SettingLabel field={props.readOnly ? undefined : prologueEl}>
          First user message (optional — sent as a fake user turn before the history){' '}
          <MacroHelp template />
        </SettingLabel>
        <MacroTextarea
          readOnly={props.readOnly}
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
        <SettingLabel field={props.readOnly ? undefined : reasoningPrefillEl}>
          {props.inline ? 'Custom template — reasoning prefill' : 'Reasoning prefill'} (optional){' '}
          <MacroHelp template />
        </SettingLabel>
        <MacroTextarea
          readOnly={props.readOnly}
          ref={reasoningPrefillEl.ref}
          template
          class="mono"
          placeholder="Leave empty to let the model start reasoning"
        />
        <SettingLabel field={props.readOnly ? undefined : messagePrefillEl}>
          {props.inline
            ? 'Custom template — assistant message prefill'
            : 'Assistant message prefill'}{' '}
          (optional) <MacroHelp template />
        </SettingLabel>
        <MacroTextarea
          readOnly={props.readOnly}
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
        <SettingLabel field={props.readOnly ? undefined : prefixEl} check>
          <input disabled={props.readOnly} ref={prefixEl.ref} type="checkbox" />
          Prefix speaker names into messages ("{'{{user}}'}: …", "{'{{char}}'}: …") and prefill the
          reply with the current speaker name (see /char)
        </SettingLabel>
        <div class="form-stack field-group" role="group" aria-label="Speaker handoff">
          <SettingLabel field={props.readOnly ? undefined : speakerEl}>
            Speaker handoff instruction
          </SettingLabel>
          <MacroTextarea
            readOnly={props.readOnly}
            ref={speakerEl.ref}
            keys={['speaker']}
            rows={2}
          />
          <p class="hint">
            Used when speaker names are enabled and the endpoint has prefills disabled.
            {' {{speaker}}'} is the requested speaker. Leave empty to send no handoff instruction.
          </p>
        </div>
        <SettingLabel field={props.readOnly ? undefined : usesPersonasEl} check>
          <input disabled={props.readOnly} ref={usesPersonasEl.ref} type="checkbox" />
          Uses personas — when off, chats with this {props.inline ? 'character' : 'template'} ignore
          the persona entirely ("
          {'{{user}}'}" becomes "User", the persona description is not sent)
        </SettingLabel>
        <SettingLabel field={props.readOnly ? undefined : steerEl}>
          {props.inline ? 'Custom template — steer template' : 'Steer template'} (regenerate with
          instruction)
        </SettingLabel>
        <MacroTextarea
          readOnly={props.readOnly}
          ref={steerEl.ref}
          keys={['instruction']}
          rows={2}
        />
        <p class="hint">
          {'{{instruction}}'} is replaced with your instruction and injected into that
          regeneration's prompt only. An empty template disables regeneration with an instruction.
        </p>
      </section>
    </>
  );
}
