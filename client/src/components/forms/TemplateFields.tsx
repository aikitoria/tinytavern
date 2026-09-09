import { For, Show } from 'solid-js';
import type { CustomTemplate } from '@tinytavern/shared';
import {
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_STEER_TEMPLATE,
  DEFAULT_SPEAKER_HANDOFF_TEMPLATE,
} from '@tinytavern/shared';
import FormField, { createFormFields, type FormFieldProps } from './FormFields.tsx';

export interface TemplateFieldsHandle {
  get value(): CustomTemplate;
  set value(template: CustomTemplate | null | undefined);
}

/** Keep every field mounted so hidden custom templates retain their DOM-backed drafts. */
export default function TemplateFields(props: {
  ref: TemplateFieldsHandle | ((handle: TemplateFieldsHandle) => void);
  inline?: boolean;
  readOnly?: boolean;
}) {
  const form = createFormFields({
    content: props.inline ? '' : DEFAULT_PROMPT_TEMPLATE,
    userPrologue: '',
    reasoningPrefill: '',
    messagePrefill: '',
    prefixNames: false,
    usesPersonas: true,
    steerTemplate: DEFAULT_STEER_TEMPLATE,
    speakerHandoffTemplate: DEFAULT_SPEAKER_HANDOFF_TEMPLATE,
  });
  const handle: TemplateFieldsHandle = {
    get value() {
      return form.value();
    },
    set value(value) {
      form.load(value);
    },
  };
  if (typeof props.ref === 'function') props.ref(handle);
  type Field = { key: keyof CustomTemplate } & FormFieldProps<string | boolean>;
  const custom = (label: string) =>
    props.inline ? `Custom template — ${label.toLowerCase()}` : label;
  const text = (key: keyof CustomTemplate, label: string, placeholder: string): Field => ({
    key,
    label,
    placeholder,
    template: true,
    mono: true,
    help: 'template',
  });
  const sections: [string, Field[], string?][] = [
    [
      'Prompt assembly',
      [
        text(
          'content',
          props.inline ? 'Custom template — system prompt' : 'System prompt template',
          '',
        ),
        text(
          'userPrologue',
          'First user message (optional — sent as a fake user turn before the history)',
          'Leave empty to send no fake user message',
        ),
      ],
    ],
    [
      'Prefills',
      [
        text(
          'reasoningPrefill',
          `${custom('Reasoning prefill')} (optional)`,
          'Leave empty to let the model start reasoning',
        ),
        text(
          'messagePrefill',
          `${custom('Assistant message prefill')} (optional)`,
          'Leave empty to let the model start the visible reply',
        ),
      ],
      "A reasoning prefill continues the model's reasoning. Adding a message prefill continues the visible reply from that text. Both become part of the saved response.",
    ],
    [
      'Advanced',
      [
        {
          key: 'prefixNames',
          kind: 'check',
          label:
            'Prefix speaker names into messages ("{{user}}: …", "{{char}}: …") and prefill the reply with the current speaker name (see /char)',
        },
        {
          key: 'speakerHandoffTemplate',
          label: 'Speaker handoff instruction',
          keys: ['speaker'],
          rows: 2,
          hint: 'Used when speaker names are enabled and the endpoint has prefills disabled. {{speaker}} is the requested speaker. Leave empty to send no handoff instruction.',
        },
        {
          key: 'usesPersonas',
          kind: 'check',
          label: `Uses personas — when off, chats with this ${props.inline ? 'character' : 'template'} ignore the persona entirely ("{{user}}" becomes "User", the persona description is not sent)`,
        },
        {
          key: 'steerTemplate',
          label: `${custom('Steer template')} (regenerate with instruction)`,
          keys: ['instruction'],
          rows: 2,
          hint: "{{instruction}} is replaced with your instruction and injected into that regeneration's prompt only. An empty template disables regeneration with an instruction.",
        },
      ],
    ],
  ];
  return (
    <For each={sections}>
      {([title, fields, hint]) => (
        <section class={props.inline ? 'form-stack' : 'settings-section'}>
          <Show when={!props.inline}>
            <h3>{title}</h3>
          </Show>
          <For each={fields}>
            {(field) => (
              <FormField
                kind="macro"
                {...field}
                field={form.fields[field.key]}
                readOnly={props.readOnly}
              />
            )}
          </For>
          <Show when={hint}>
            <p class="hint">{hint}</p>
          </Show>
        </section>
      )}
    </For>
  );
}
