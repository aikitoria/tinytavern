import type { MediaWorkflow } from '@tinytavern/shared';
import { stmt } from '../db/db.ts';
import { HttpError } from '../http/router.ts';
import { mediaEntityDto } from '../settings/mediaEntities.ts';

export function requireMediaWorkflow(id: string, includeDeleted = false): MediaWorkflow {
  const row = stmt('SELECT * FROM media_workflows WHERE id = ?').get(id);
  if (!row || (!includeDeleted && row.deleted_at != null)) {
    throw new HttpError(404, 'The selected workflow no longer exists');
  }
  return mediaEntityDto('media_workflows', row) as unknown as MediaWorkflow;
}
