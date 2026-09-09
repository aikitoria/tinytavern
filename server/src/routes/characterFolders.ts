import { stmt, toCharacterFolder } from '../db/db.ts';
import { invalidate } from '../realtime/events.ts';
import { route, HttpError } from '../http/router.ts';
import type { Ctx } from '../http/router.ts';
import { objectBody, optionalString, positiveId, requiredString } from '../http/validation.ts';
import { rowById, rows } from './shared/entityUtils.ts';

function duplicateName(name: string, exceptId?: number): boolean {
  const row =
    exceptId == null
      ? stmt('SELECT id FROM character_folders WHERE name = ? COLLATE NOCASE').get(name)
      : stmt('SELECT id FROM character_folders WHERE name = ? COLLATE NOCASE AND id <> ?').get(
          name,
          exceptId,
        );
  return row != null;
}

route.get('/api/character-folders', () => rows('character_folders').map(toCharacterFolder));

route.post('/api/character-folders', ({ body }: Ctx) => {
  const name = requiredString(objectBody(body), 'name');
  if (duplicateName(name)) throw new HttpError(409, 'a folder with this name already exists');
  const result = stmt('INSERT INTO character_folders (name, created_at) VALUES (?, ?)').run(
    name,
    Date.now(),
  );
  invalidate('characterFolders');
  return toCharacterFolder(rowById('character_folders', Number(result.lastInsertRowid)));
});

route.patch('/api/character-folders/:id', ({ params, body }: Ctx) => {
  const id = positiveId(params.id);
  const current = toCharacterFolder(rowById('character_folders', id));
  const requested = optionalString(objectBody(body), 'name');
  const name = requested === undefined ? current.name : requested.trim();
  if (!name) throw new HttpError(400, 'name is required');
  if (duplicateName(name, id)) throw new HttpError(409, 'a folder with this name already exists');
  stmt('UPDATE character_folders SET name = ? WHERE id = ?').run(name, id);
  invalidate('characterFolders');
  return toCharacterFolder(rowById('character_folders', id));
});

route.del('/api/character-folders/:id', ({ params }: Ctx) => {
  const id = positiveId(params.id);
  rowById('character_folders', id);
  stmt('DELETE FROM character_folders WHERE id = ?').run(id);
  invalidate('characterFolders');
  invalidate('characters');
});
