/** Legacy attachment columns remain the canonical path list during DTO migration.
 * Triggers cover every SQL writer, including imports/copies and cascading deletes. */
export const MEDIA_SCHEMA_SQL = `
CREATE TABLE media_recipes (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  inputs_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE TABLE media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'image' CHECK(kind IN ('image', 'video')),
  mime TEXT NOT NULL DEFAULT 'image/png',
  byte_size INTEGER,
  width INTEGER,
  height INTEGER,
  duration REAL,
  poster TEXT,
  recipe_id TEXT REFERENCES media_recipes(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX media_assets_recipe ON media_assets(recipe_id);
CREATE TABLE media_owners (
  asset_id INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('message', 'gallery', 'job', 'recipe')),
  owner_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  PRIMARY KEY(owner_type, owner_id, slot)
);
CREATE INDEX media_owners_asset ON media_owners(asset_id);
CREATE TABLE media_jobs (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  operation TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  workflow_id TEXT,
  preset_id TEXT,
  instruction TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  inputs_json TEXT NOT NULL DEFAULT '[]',
  configuration_json TEXT,
  context_json TEXT,
  endpoint_json TEXT,
  context_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  destination TEXT NOT NULL DEFAULT 'gallery',
  source_job_id TEXT,
  seed INTEGER,
  comfy_prompt_id TEXT,
  submission_id TEXT UNIQUE,
  request_key TEXT UNIQUE,
  outputs_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  auto_render INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  deadline INTEGER,
  retention_deadline INTEGER
);
CREATE INDEX media_jobs_active ON media_jobs(state, updated_at);
CREATE INDEX media_jobs_message ON media_jobs(message_id);
CREATE TABLE media_remote_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  filename TEXT NOT NULL,
  subfolder TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  purpose TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'owned',
  retries INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  UNIQUE(job_id, endpoint, filename, subfolder, type)
);
CREATE INDEX media_remote_pending ON media_remote_files(state, retry_at);
CREATE INDEX media_remote_identity ON media_remote_files(endpoint, filename, subfolder, type, state);

INSERT OR IGNORE INTO media_assets(path, created_at)
SELECT j.value, m.created_at FROM messages m, json_each(m.images_json) j;
INSERT OR IGNORE INTO media_assets(path, width, height, created_at)
SELECT image, image_width, image_height, created_at FROM gallery_items WHERE image IS NOT NULL;
UPDATE media_assets SET mime = CASE
  WHEN lower(path) LIKE '%.jpg' OR lower(path) LIKE '%.jpeg' THEN 'image/jpeg'
  WHEN lower(path) LIKE '%.webp' THEN 'image/webp' ELSE 'image/png' END;
INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
SELECT a.id, 'message', CAST(m.id AS TEXT), CAST(j.key AS TEXT)
FROM messages m, json_each(m.images_json) j JOIN media_assets a ON a.path = j.value;
INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
SELECT a.id, 'gallery', CAST(g.id AS TEXT), '0' FROM gallery_items g JOIN media_assets a ON a.path = g.image;

${['INSERT', 'UPDATE OF images_json']
  .map(
    (event, index) => `
CREATE TRIGGER media_message_${index ? 'update' : 'insert'} AFTER ${event} ON messages BEGIN
  DELETE FROM media_owners WHERE owner_type = 'message' AND owner_id = CAST(new.id AS TEXT);
  INSERT OR IGNORE INTO media_assets(path, created_at)
    SELECT value, new.created_at FROM json_each(new.images_json);
  INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
    SELECT a.id, 'message', CAST(new.id AS TEXT), CAST(j.key AS TEXT)
    FROM json_each(new.images_json) j JOIN media_assets a ON a.path = j.value;
END;`,
  )
  .join('\n')}
CREATE TRIGGER media_message_delete BEFORE DELETE ON messages BEGIN
  UPDATE media_jobs SET state = 'cancelling', revision = revision + 1,
    updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE message_id = old.id AND destination = 'chat'
    AND state NOT IN ('succeeded', 'failed', 'cancelled', 'draft', 'ready');
  DELETE FROM media_owners WHERE owner_type = 'message' AND owner_id = CAST(old.id AS TEXT);
END;
${['INSERT', 'UPDATE OF image']
  .map(
    (event, index) => `
CREATE TRIGGER media_gallery_${index ? 'update' : 'insert'} AFTER ${event} ON gallery_items BEGIN
  DELETE FROM media_owners WHERE owner_type = 'gallery' AND owner_id = CAST(new.id AS TEXT);
  INSERT OR IGNORE INTO media_assets(path, width, height, created_at)
    SELECT new.image, new.image_width, new.image_height, new.created_at WHERE new.image IS NOT NULL;
  INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
    SELECT id, 'gallery', CAST(new.id AS TEXT), '0' FROM media_assets WHERE path = new.image;
END;`,
  )
  .join('\n')}
CREATE TRIGGER media_gallery_delete AFTER DELETE ON gallery_items BEGIN
  DELETE FROM media_owners WHERE owner_type = 'gallery' AND owner_id = CAST(old.id AS TEXT);
END;
CREATE TRIGGER media_job_delete AFTER DELETE ON media_jobs BEGIN
  DELETE FROM media_owners WHERE owner_type = 'job' AND owner_id = old.id;
END;
CREATE TRIGGER media_recipe_delete AFTER DELETE ON media_recipes BEGIN
  DELETE FROM media_owners WHERE owner_type = 'recipe' AND owner_id = old.id;
END;
`;
