import { ENTITY_FOLDERS, type FolderEntity } from '@tinytavern/shared';
import { stmt, toEntityFolder as toFolder } from '../db/db.ts';
import { invalidate } from '../realtime/events.ts';
import { route, HttpError } from '../http/router.ts';
import { objectBody, optionalString, positiveId, requiredString } from '../http/validation.ts';
import { rowById, rows } from './shared/entityUtils.ts';

for (const entity of Object.keys(ENTITY_FOLDERS) as FolderEntity[]) {
  const { table, path, state } = ENTITY_FOLDERS[entity];
  const validateName = (name: string, exceptId = 0) => {
    if (
      stmt(`SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE AND id <> ?`).get(name, exceptId)
    )
      throw new HttpError(409, 'a folder with this name already exists');
  };
  route.get(`/api/${path}`, () => rows(table).map(toFolder));
  route.post(`/api/${path}`, ({ body }) => {
    const name = requiredString(objectBody(body), 'name');
    validateName(name);
    const result = stmt(`INSERT INTO ${table} (name, created_at) VALUES (?, ?)`).run(
      name,
      Date.now(),
    );
    invalidate(state);
    return toFolder(rowById(table, Number(result.lastInsertRowid)));
  });
  route.patch(`/api/${path}/:id`, ({ params, body }) => {
    const id = positiveId(params.id);
    const current = toFolder(rowById(table, id));
    const name = optionalString(objectBody(body), 'name')?.trim() ?? current.name;
    if (!name) throw new HttpError(400, 'name is required');
    validateName(name, id);
    stmt(`UPDATE ${table} SET name = ? WHERE id = ?`).run(name, id);
    invalidate(state);
    return toFolder(rowById(table, id));
  });
  route.del(`/api/${path}/:id`, ({ params }) => {
    const id = positiveId(params.id);
    rowById(table, id);
    stmt(`DELETE FROM ${table} WHERE id = ?`).run(id);
    invalidate(state);
    invalidate(entity);
  });
}
