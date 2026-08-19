import type { Persona } from '@minitavern/shared';
import { stmt, toPersona } from '../db.ts';
import { invalidate } from '../events.ts';
import { route, HttpError } from '../router.ts';
import type { Ctx } from '../router.ts';
import { positiveId } from '../validation.ts';
import {
  copyAvatarFiles,
  deleteAvatarFiles,
  deleteObsoleteAvatarFiles,
  saveAvatar,
} from './avatarStore.ts';
import { defineEntityRoutes, nameField, textField } from './entityRoutes.ts';
import { rowById } from './entityUtils.ts';

defineEntityRoutes<Persona>({
  table: 'personas',
  toDto: toPersona,
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

route.put(
  '/api/personas/:id/avatar',
  ({ params, raw }: Ctx) => {
    const id = positiveId(params.id);
    rowById('personas', id);
    if (!raw?.length) throw new HttpError(400, 'image body is required');
    const avatar = saveAvatar('persona', id, raw);
    stmt('UPDATE personas SET avatar = ? WHERE id = ?').run(avatar, id);
    deleteObsoleteAvatarFiles('persona', id);
    invalidate('personas');
    return toPersona(rowById('personas', id));
  },
  { rawBody: true },
);

route.del('/api/personas/:id/avatar', ({ params }: Ctx) => {
  const id = positiveId(params.id);
  rowById('personas', id);
  deleteAvatarFiles('persona', id);
  stmt('UPDATE personas SET avatar = NULL WHERE id = ?').run(id);
  invalidate('personas');
  return toPersona(rowById('personas', id));
});
