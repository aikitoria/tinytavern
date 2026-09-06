import type { Preset } from '@tinytavern/shared';
import { toPreset } from '../db.ts';
import { defineEntityRoutes, nameField, textField } from './entityRoutes.ts';

defineEntityRoutes<Preset>({
  table: 'presets',
  toDto: toPreset,
  fields: [nameField((cur) => cur.name), textField('content', 'content', (cur) => cur.content)],
  settingsRef: 'defaultPresetId',
  invalidateOnDelete: ['characters'],
});
