import { createHash } from 'node:crypto';
import {
  ENTITY_TRANSFER_FIELDS,
  ENTITY_FOLDERS,
  transferString,
  entityTransferData,
  namedItem,
  takeNamedCollectionItem,
  transferArray,
  transferData,
  transferDocument,
  transferObject,
  type TransferEntity,
} from '@tinytavern/shared';
import { stmt, transaction } from '../../db/db.ts';
import { getSettingsPreferences, putSettings } from '../../settings/settingsStore.ts';
import { route, HttpError } from '../../http/router.ts';
import { objectBody, positiveId } from '../../http/validation.ts';
import { rowById, rows } from './entityUtils.ts';
import type { EntityConfig } from './entityRoutes.ts';
import type { EntityWriter } from './entityWriter.ts';
import {
  readAvatarFile,
  saveAvatar,
  deleteAvatarFiles,
  deleteObsoleteAvatarFiles,
} from '../../characters/avatarStore.ts';
import { isPng } from '../../characters/pngCard.ts';
import { invalidate, subscribedConversationIds } from '../../realtime/events.ts';
import { discardSpeculativeSwipes } from '../../generation/speculation.ts';
import { bumpAllConversationRevisions } from '../../conversations/conversationRevision.ts';
import { broadcastTree } from '../../realtime/sync.ts';

/** Reuse the entity's normal field validators; bulk imports commit as one database change. */
export function defineEntityTransfer<T extends { id: number }>(cfg: EntityConfig<T>, writer: EntityWriter): void {
  if (!Object.hasOwn(ENTITY_TRANSFER_FIELDS, cfg.table)) return;
  const type = cfg.table as TransferEntity;
  const folderConfig = ENTITY_FOLDERS[type];
  const folderRows = () => rows(folderConfig.table).map((row) => ({ id: Number(row.id), name: String(row.name) }));
  const folderColumn = cfg.fields.findIndex((field) => field.column === 'folder_id');
  const snapshot = () =>
    createHash('sha256')
      .update(
        JSON.stringify({
          rows: rows(cfg.table),
          folders: folderRows(),
          revision: getSettingsPreferences().revision,
        }),
      )
      .digest('hex');
  const exportItem = (row: Record<string, unknown>) => {
    const entity = cfg.toDto(row);
    const item = entityTransferData(type, {
      ...entity,
      folderId: row.folder_id == null ? null : rowById(folderConfig.table, Number(row.folder_id)).name,
    });
    if (type === 'personas') {
      const avatar = readAvatarFile('persona', entity.id);
      item.avatarData = avatar ? `data:image/png;base64,${avatar.toString('base64')}` : null;
    }
    return item;
  };
  route.get(`/api/${type}/settings-export`, () => {
    const entities = rows(cfg.table);
    const activeId = cfg.settingsRef ? getSettingsPreferences()[cfg.settingsRef] : null;
    return {
      snapshot: snapshot(),
      document: transferDocument(`page:${type}`, {
        items: entities.map(exportItem),
        folders: folderRows().map(({ name }) => ({ name })),
        ...(cfg.settingsRef ? { active: entities.find((row) => row.id === activeId)?.name ?? null } : {}),
      }),
    };
  });
  route.get(`/api/${type}/:id/settings-export`, ({ params }) => exportItem(rowById(cfg.table, positiveId(params.id))));
  route.post(`/api/${type}/settings-import`, ({ body }) => {
    const input = objectBody(body);
    const single = Object.hasOwn(input, 'targetId');
    if (!single && input.expectedSnapshot !== snapshot())
      throw new HttpError(409, 'Settings changed elsewhere; reopen the import to review them');
    try {
      const data = transferData(input.document, `${single ? 'entity' : 'page'}:${type}`);
      const source = single ? { items: [data] } : transferObject(data);
      const incoming = transferArray(source.items).map((entry) => entityTransferData(type, entry));
      const folders = folderRows();
      const folderNames = new Map<string, string>();
      const folderName = (value: unknown) => {
        const name = transferString(value, 'Folder name').trim();
        if (!name) throw new HttpError(400, 'Folder name is required');
        return name;
      };
      if (!single && source.folders !== undefined) {
        for (const folder of transferArray(source.folders)) {
          const name = folderName(folder.name);
          const key = name.toLowerCase();
          if (folderNames.has(key)) throw new HttpError(400, 'Folder names must be unique');
          folderNames.set(key, name);
        }
      }
      for (const item of incoming) {
        if (item.folderId != null) {
          const name = folderName(item.folderId);
          item.folderId = name;
          folderNames.set(name.toLowerCase(), name);
        }
      }
      const all = rows(cfg.table);
      const candidates: (Record<string, unknown> & { name: string })[] = all.map((row) => ({
        ...row,
        name: String(row.name),
      }));
      const names = new Set([...all, ...incoming].map((row) => String(row.name)));
      const remaining = new Set(candidates);
      const plan = incoming.map((item) => {
        const name = String(item.name);
        const matching = single
          ? input.targetId === null
            ? undefined
            : rowById(cfg.table, positiveId(String(input.targetId)))
          : takeNamedCollectionItem(candidates, remaining, name);
        const protectedRow = matching && cfg.readOnlyColumn && matching[cfg.readOnlyColumn] === 1;
        const current = protectedRow ? undefined : matching;
        if (protectedRow) {
          let copyName = `${name} (imported)`;
          for (let index = 2; names.has(copyName); index++) copyName = `${name} (imported ${index})`;
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
        const folderName = typeof item.folderId === 'string' ? item.folderId : undefined;
        const values = writer.values(
          {
            ...item,
            ...(folderName === undefined ? {} : { folderId: namedItem(folders, folderName)?.id ?? null }),
          },
          current,
        );
        return { name, values, id: current ? Number(current.id) : null, avatar, folderName };
      });
      const backups: { id: number; data: Buffer | null }[] = [];
      const imported: { name: string; id: number }[] = [];
      try {
        transaction(() => {
          for (const name of folderNames.values()) {
            if (namedItem(folders, name)) continue;
            const result = stmt(`INSERT INTO ${folderConfig.table} (name, created_at) VALUES (?, ?)`).run(
              name,
              Date.now(),
            );
            folders.push({ id: Number(result.lastInsertRowid), name });
          }
          for (const item of plan) {
            if (item.folderName !== undefined) item.values[folderColumn] = namedItem(folders, item.folderName)!.id;
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
            const settings = getSettingsPreferences();
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
      invalidate(type);
      invalidate(folderConfig.state);
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
