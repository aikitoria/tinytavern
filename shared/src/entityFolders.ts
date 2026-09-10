/** Folder collections for entities stored in their own database tables. */
export const ENTITY_FOLDERS = {
  characters: { table: 'character_folders', path: 'character-folders', state: 'characterFolders' },
  presets: { table: 'preset_folders', path: 'preset-folders', state: 'presetFolders' },
  templates: { table: 'template_folders', path: 'template-folders', state: 'templateFolders' },
  personas: { table: 'persona_folders', path: 'persona-folders', state: 'personaFolders' },
  endpoints: { table: 'endpoint_folders', path: 'endpoint-folders', state: 'endpointFolders' },
  gallery: { table: 'gallery_folders', path: 'gallery-folders', state: 'galleryFolders' },
} as const;
export type FolderEntity = keyof typeof ENTITY_FOLDERS;
export type EntityFolderTopic = (typeof ENTITY_FOLDERS)[FolderEntity]['state'];
export interface EntityFolder {
  id: number;
  name: string;
  createdAt: number;
}
