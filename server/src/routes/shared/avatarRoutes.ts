import { stmt } from '../../db/db.ts';
import { invalidate } from '../../realtime/events.ts';
import { HttpError, route } from '../../http/router.ts';
import { positiveId } from '../../http/validation.ts';
import {
  deleteAvatarFiles,
  deleteObsoleteAvatarFiles,
  saveAvatar,
} from '../../characters/avatarStore.ts';
import type { AvatarKind } from '../../characters/avatarStore.ts';
import { rowById } from './entityUtils.ts';

export function defineAvatarRoutes<T>(
  kind: AvatarKind,
  toDto: (row: Record<string, unknown>) => T,
): void {
  const table = kind === 'character' ? 'characters' : 'personas';
  route.put(
    `/api/${table}/:id/avatar`,
    ({ params, raw }) => {
      const id = positiveId(params.id);
      rowById(table, id);
      if (!raw?.length) throw new HttpError(400, 'image body is required');
      const avatar = saveAvatar(kind, id, raw);
      stmt(`UPDATE ${table} SET avatar = ? WHERE id = ?`).run(avatar, id);
      deleteObsoleteAvatarFiles(kind, id);
      invalidate(table);
      return toDto(rowById(table, id));
    },
    { rawBody: true },
  );
  route.del(`/api/${table}/:id/avatar`, ({ params }) => {
    const id = positiveId(params.id);
    rowById(table, id);
    deleteAvatarFiles(kind, id);
    stmt(`UPDATE ${table} SET avatar = NULL WHERE id = ?`).run(id);
    invalidate(table);
    return toDto(rowById(table, id));
  });
}
