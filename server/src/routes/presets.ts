import { ENTITY_FIELDS } from '@tinytavern/shared';
import type { Preset } from '@tinytavern/shared';
import { toPreset } from '../db/db.ts';
import { defineEntityRoutes, entityFields, referenceValue } from './shared/entityRoutes.ts';

defineEntityRoutes<Preset>({
  table: 'presets',
  toDto: toPreset,
  readOnlyColumn: 'builtin',
  fields: entityFields(ENTITY_FIELDS.presets, {
    folderId: referenceValue('folderId', 'preset_folders'),
  }),
  settingsRef: 'defaultPresetId',
  invalidateOnDelete: ['characters'],
});
