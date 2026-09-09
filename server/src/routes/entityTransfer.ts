import { createHash } from 'node:crypto';
import {
  ENTITY_TRANSFER_FIELDS,
  entityTransferData,
  namedItem,
  transferArray,
  transferData,
  transferDocument,
  transferObject,
  type TransferEntity,
} from '@tinytavern/shared';
import { stmt, transaction } from '../db.ts';
import { getSettings, putSettings } from '../settingsStore.ts';
import { route, HttpError } from '../router.ts';
import { objectBody, positiveId } from '../validation.ts';
import { rowById, rows } from './entityUtils.ts';
import type { EntityConfig } from './entityRoutes.ts';
import type { EntityWriter } from './entityWriter.ts';
import {
  readAvatarFile,
  saveAvatar,
  deleteAvatarFiles,
  deleteObsoleteAvatarFiles,
} from './avatarStore.ts';
import { isPng } from '../pngCard.ts';
import { invalidate, subscribedConversationIds } from '../events.ts';
import { discardSpeculativeSwipes } from '../speculation.ts';
import { bumpAllConversationRevisions } from '../conversationRevision.ts';
import { broadcastTree } from '../sync.ts';

/** Reuse the entity's normal field validators; bulk imports commit as one database change. */
export function defineEntityTransfer<T extends { id: number }>(
  cfg: EntityConfig<T>,
  writer: EntityWriter,
): void {
  if (!Object.hasOwn(ENTITY_TRANSFER_FIELDS, cfg.table)) return;
  const type = cfg.table as TransferEntity;
  const snapshot = () =>
    createHash('sha256')
      .update(JSON.stringify({ rows: rows(cfg.table), revision: getSettings().revision }))
      .digest('hex');
  const exportItem = (row: Record<string, unknown>) => {
    const entity = cfg.toDto(row);
    const item = entityTransferData(type, entity);
    if (type === 'personas') {
      const avatar = readAvatarFile('persona', entity.id);
      item.avatarData = avatar ? `data:image/png;base64,${avatar.toString('base64')}` : null;
    }
    return item;
  };
  route.get(`/api/${type}/settings-export`, () => {
    const entities = rows(cfg.table);
    const activeId = cfg.settingsRef ? getSettings()[cfg.settingsRef] : null;
    return {
      snapshot: snapshot(),
      document: transferDocument(`page:${type}`, {
        items: entities.map(exportItem),
        ...(cfg.settingsRef
          ? { active: entities.find((row) => row.id === activeId)?.name ?? null }
          : {}),
      }),
    };
  });
  route.get(`/api/${type}/:id/settings-export`, ({ params }) =>
    exportItem(rowById(cfg.table, positiveId(params.id))),
  );
  route.post(`/api/${type}/settings-import`, ({ body }) => {
    const input = objectBody(body);
    const single = Object.hasOwn(input, 'targetId');
    if (!single && input.expectedSnapshot !== snapshot())
      throw new HttpError(409, 'Settings changed elsewhere; reopen the import to review them');
    try {
      const data = transferData(input.document, `${single ? 'entity' : 'page'}:${type}`);
      const source = single ? { items: [data] } : transferObject(data);
      const incoming = transferArray(source.items);
      const all = rows(cfg.table);
      const candidates: (Record<string, unknown> & { name: string })[] = all.map((row) => ({
        ...row,
        name: String(row.name),
      }));
      const names = new Set(all.map((row) => String(row.name)));
      const seen = new Set<string>();
      const plan = incoming.map((entry) => {
        const item = entityTransferData(type, entry);
        const name = String(item.name);
        if (seen.has(name.toLowerCase())) throw new HttpError(400, 'Duplicate names in the import');
        seen.add(name.toLowerCase());
        const matching = single
          ? input.targetId === null
            ? undefined
            : rowById(cfg.table, positiveId(String(input.targetId)))
          : namedItem(candidates, name);
        const protectedRow = matching && cfg.readOnlyColumn && matching[cfg.readOnlyColumn] === 1;
        const current = protectedRow ? undefined : matching;
        if (protectedRow) {
          let copyName = `${name} (imported)`;
          for (let index = 2; names.has(copyName); index++)
            copyName = `${name} (imported ${index})`;
          item.name = copyName;
        }
        names.add(String(item.name));
        let avatar: Buffer | null | undefined;
        if (type === 'personas' && Object.hasOwn(item, 'avatarData')) {
          if (item.avatarData === null) avatar = null;
          else {
            const encoded = String(item.avatarData);
            if (!/^data:image\/png;base64,[A-Za-z0-9+/]*={0,2}$/.test(encoded))
              throw new HttpError(400, 'Persona avatar must be a PNG data URL');
            avatar = Buffer.from(encoded.slice(encoded.indexOf(',') + 1), 'base64');
            if (!isPng(avatar)) throw new HttpError(400, 'Invalid PNG avatar');
          }
        }
        // Imported sampling settings replace the exported parameter object in full.
        if (type === 'endpoints') item.replaceGenParams = true;
        const values = writer.values(item, current);
        return { name, values, id: current ? Number(current.id) : null, avatar };
      });
      const backups: { id: number; data: Buffer | null }[] = [];
      const imported: { name: string; id: number }[] = [];
      try {
        transaction(() => {
          for (const item of plan) {
            const id = item.id ?? writer.insert(item.values);
            if (item.id !== null) writer.update(id, item.values);
            if (item.avatar !== undefined) {
              backups.push({ id, data: readAvatarFile('persona', id) });
              const avatar = item.avatar === null ? null : saveAvatar('persona', id, item.avatar);
              stmt('UPDATE personas SET avatar = ? WHERE id = ?').run(avatar, id);
            }
            imported.push({ name: item.name, id });
          }
          if (!single && cfg.settingsRef && Object.hasOwn(source, 'active')) {
            const settings = getSettings();
            const active =
              source.active === null
                ? null
                : (namedItem(imported, source.active)?.id ??
                  namedItem(
                    rows(cfg.table).map((row) => ({ id: Number(row.id), name: String(row.name) })),
                    source.active,
                  )?.id);
            if (active !== undefined)
              putSettings({
                ...settings,
                [cfg.settingsRef]: active,
                revision: settings.revision + 1,
              });
          }
        });
      } catch (error) {
        for (const backup of backups) {
          if (backup.data) saveAvatar('persona', backup.id, backup.data);
          else deleteAvatarFiles('persona', backup.id);
        }
        throw error;
      }
      for (const [index, item] of plan.entries()) {
        const id = imported[index]!.id;
        if (item.avatar === null) deleteAvatarFiles('persona', id);
        else if (item.avatar !== undefined) deleteObsoleteAvatarFiles('persona', id);
      }
      invalidate(cfg.table);
      invalidate('settings');
      discardSpeculativeSwipes();
      bumpAllConversationRevisions();
      for (const id of subscribedConversationIds()) broadcastTree(id);
      return imported.map(({ id }) => {
        const entity = cfg.toDto(rowById(cfg.table, id));
        return cfg.toPublic ? cfg.toPublic(entity) : entity;
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, error instanceof Error ? error.message : 'Invalid settings import');
    }
  });
}
