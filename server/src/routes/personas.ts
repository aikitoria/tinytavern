import { ENTITY_FIELDS } from '@tinytavern/shared';
import { publicAvatar } from '../media/mediaUrls.ts';
import { defineAvatarRoutes } from './shared/avatarRoutes.ts';
import type { Persona } from '@tinytavern/shared';
import { stmt, toPersona } from '../db/db.ts';
import { copyAvatarFiles, deleteAvatarFiles } from '../characters/avatarStore.ts';
import { defineEntityRoutes, entityFields } from './shared/entityRoutes.ts';

defineEntityRoutes<Persona>({
  table: 'personas',
  toDto: toPersona,
  toPublic: publicAvatar,
  fields: entityFields(ENTITY_FIELDS.personas),
  settingsRef: 'defaultPersonaId',
  invalidateOnDelete: ['conversations'],
  onDelete: (id) => deleteAvatarFiles('persona', id),
  onDuplicate: (sourceId, newId) => {
    // Also clears a stale avatar URL when the source's file is missing.
    const avatar = copyAvatarFiles('persona', sourceId, newId);
    stmt('UPDATE personas SET avatar = ? WHERE id = ?').run(avatar, newId);
  },
});

defineAvatarRoutes('persona', (row) => publicAvatar(toPersona(row)));
