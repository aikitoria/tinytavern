import { ENTITY_FIELDS, type Template } from '@tinytavern/shared';
import { toTemplate } from '../db.ts';
import { defineEntityRoutes, entityFields } from './entityRoutes.ts';

defineEntityRoutes<Template>({
  table: 'templates',
  toDto: toTemplate,
  readOnlyColumn: 'builtin',
  fields: entityFields(ENTITY_FIELDS.templates),
  settingsRef: 'defaultTemplateId',
  invalidateOnDelete: ['characters'],
});
