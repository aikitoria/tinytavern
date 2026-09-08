import {
  DEFAULT_STEER_TEMPLATE,
  DEFAULT_SPEAKER_HANDOFF_TEMPLATE,
  type Template,
} from '@tinytavern/shared';
import { toTemplate } from '../db.ts';
import { optionalBoolean, optionalString } from '../validation.ts';
import { defineEntityRoutes, nameField, textField } from './entityRoutes.ts';

defineEntityRoutes<Template>({
  table: 'templates',
  toDto: toTemplate,
  readOnlyColumn: 'builtin',
  fields: [
    nameField((cur) => cur.name),
    textField('content', 'content', (cur) => cur.content),
    textField('userPrologue', 'user_prologue', (cur) => cur.userPrologue),
    textField('reasoningPrefill', 'reasoning_prefill', (cur) => cur.reasoningPrefill),
    textField('messagePrefill', 'message_prefill', (cur) => cur.messagePrefill),
    {
      column: 'prefix_names',
      value: (b, cur) => ((optionalBoolean(b, 'prefixNames') ?? cur?.prefixNames ?? false) ? 1 : 0),
    },
    {
      column: 'uses_personas',
      value: (b, cur) =>
        (optionalBoolean(b, 'usesPersonas') ?? cur?.usesPersonas ?? true) ? 1 : 0,
    },
    {
      column: 'steer_template',
      value: (b, cur) =>
        optionalString(b, 'steerTemplate') ?? cur?.steerTemplate ?? DEFAULT_STEER_TEMPLATE,
    },
    {
      column: 'speaker_handoff_template',
      value: (b, cur) =>
        optionalString(b, 'speakerHandoffTemplate') ??
        cur?.speakerHandoffTemplate ??
        DEFAULT_SPEAKER_HANDOFF_TEMPLATE,
    },
  ],
  settingsRef: 'defaultTemplateId',
  invalidateOnDelete: ['characters'],
});
