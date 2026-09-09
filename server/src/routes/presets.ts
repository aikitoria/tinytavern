import { ENTITY_FIELDS } from '@tinytavern/shared';
import type { Preset } from '@tinytavern/shared';
import { toPreset } from '../db/db.ts';
import { defineEntityRoutes, entityFields } from './shared/entityRoutes.ts';

defineEntityRoutes<Preset>({
  table: 'presets',
  toDto: toPreset,
  readOnlyColumn: 'builtin',
  fields: entityFields(ENTITY_FIELDS.presets),
  settingsRef: 'defaultPresetId',
  invalidateOnDelete: ['characters'],
});
