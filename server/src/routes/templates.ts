import { ENTITY_FIELDS, type Template } from '@tinytavern/shared';
import { toTemplate } from '../db/db.ts';
import { defineEntityRoutes, entityFields, referenceValue } from './shared/entityRoutes.ts';

defineEntityRoutes<Template>({
  table: 'templates',
  toDto: toTemplate,
  readOnlyColumn: 'builtin',
  fields: entityFields(ENTITY_FIELDS.templates, {
    folderId: referenceValue('folderId', 'template_folders'),
  }),
  settingsRef: 'defaultTemplateId',
  invalidateOnDelete: ['characters'],
});
