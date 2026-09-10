import { For, Show, createSignal } from 'solid-js';
import SettingsSection from '../settings/SettingsSection.tsx';
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
  const [prefills, setPrefills] = createSignal({ key: 0, hasContent: false });
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
      setPrefills((previous) => ({
        key: previous.key + 1,
        hasContent: Boolean(value?.reasoningPrefill || value?.messagePrefill),
      }));
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
        text('content', custom('System prompt template'), ''),
        text(
          'userPrologue',
          'Initial user message template (optional)',
          'Sent before the chat history; leave empty to omit it',
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
      "A reasoning prefill starts the model's reasoning with this text. An assistant message prefill starts the visible reply with this text. Both become part of the saved response.",
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
          label: 'Speaker handoff prompt template',
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
          label: custom('Regeneration prompt template'),
          keys: ['instruction'],
          rows: 2,
          hint: 'Used when regenerating a reply with an instruction. {{instruction}} is replaced with the requested change for that regeneration only. Leave empty to disable regeneration with an instruction.',
        },
      ],
    ],
  ];
  const Fields = (section: { fields: Field[]; hint?: string }) => (
    <>
      <For each={section.fields}>
        {(field) => (
          <FormField
            kind="macro"
            {...field}
            field={form.fields[field.key]}
            readOnly={props.readOnly}
          />
        )}
      </For>
      <Show when={section.hint}>
        <p class="hint">{section.hint}</p>
      </Show>
    </>
  );
  return (
    <For each={sections}>
      {([title, fields, hint]) => (
        <SettingsSection
          title={title === 'Prefills' ? 'Advanced prefills' : title}
          disclosure={title === 'Prefills' ? prefills() : undefined}
          id={`template-${title.toLowerCase().replaceAll(' ', '-')}`}
          fields={fields.map((field) => `${props.inline ? 'customTemplate.' : ''}${field.key}`)}
        >
          <Fields fields={fields} hint={hint} />
        </SettingsSection>
      )}
    </For>
  );
}
