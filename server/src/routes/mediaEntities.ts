import { MEDIA_ENTITIES, type MediaEntityTable } from '../settings/mediaEntities.ts';
import { mediaEntityConfig, mediaFolderConfig } from '../settings/mediaEntityWrites.ts';
import { defineEntityRoutes } from './shared/entityRoutes.ts';

for (const table of Object.keys(MEDIA_ENTITIES) as MediaEntityTable[]) {
  defineEntityRoutes(mediaEntityConfig(table));
  if (MEDIA_ENTITIES[table].folder) defineEntityRoutes(mediaFolderConfig(table));
}
