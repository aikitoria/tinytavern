import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { IMAGES_DIR, stmt } from '../../db/db.ts';
import { invalidate } from '../../realtime/events.ts';
import { HttpError, route } from '../../http/router.ts';
import { objectBody, positiveId } from '../../http/validation.ts';
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
  const save = (id: number, data: Buffer) => {
    rowById(table, id);
    const avatar = saveAvatar(kind, id, data);
    stmt(`UPDATE ${table} SET avatar = ? WHERE id = ?`).run(avatar, id);
    deleteObsoleteAvatarFiles(kind, id);
    invalidate(table);
    return toDto(rowById(table, id));
  };
  // Generated results are already durable. Copy directly while their owner keeps them alive.
  route.post(`/api/${table}/:id/avatar`, ({ params, body }) => {
    const assetId = positiveId(String(objectBody(body).assetId), 'asset ID');
    const asset = stmt(`SELECT path FROM media_assets a WHERE id = ? AND kind = 'image'
      AND EXISTS (SELECT 1 FROM media_owners o WHERE o.asset_id = a.id)`).get(assetId);
    if (!asset) throw new HttpError(409, 'The avatar image is no longer available');
    return save(
      positiveId(params.id),
      readFileSync(join(IMAGES_DIR, basename(String(asset.path)))),
    );
  });
  route.put(
    `/api/${table}/:id/avatar`,
    ({ params, raw }) => {
      if (!raw?.length) throw new HttpError(400, 'image body is required');
      return save(positiveId(params.id), raw);
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
