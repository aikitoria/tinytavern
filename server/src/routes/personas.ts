import { publicAvatar } from '../mediaUrls.ts';
import { defineAvatarRoutes } from './avatarRoutes.ts';
import type { Persona } from '@tinytavern/shared';
import { stmt, toPersona } from '../db.ts';
import { copyAvatarFiles, deleteAvatarFiles } from './avatarStore.ts';
import { defineEntityRoutes, nameField, textField } from './entityRoutes.ts';

defineEntityRoutes<Persona>({
  table: 'personas',
  toDto: toPersona,
  toPublic: publicAvatar,
  fields: [
    nameField((cur) => cur.name),
    textField('description', 'description', (cur) => cur.description),
  ],
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
