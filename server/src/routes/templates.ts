import type { Template } from '@tinytavern/shared';
import { toTemplate } from '../db.ts';
import { optionalBoolean } from '../validation.ts';
import { defineEntityRoutes, nameField, textField } from './entityRoutes.ts';

defineEntityRoutes<Template>({
  table: 'templates',
  toDto: toTemplate,
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
    textField('steerTemplate', 'steer_template', (cur) => cur.steerTemplate),
  ],
  settingsRef: 'defaultTemplateId',
  invalidateOnDelete: ['characters'],
});
