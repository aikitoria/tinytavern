/** Fresh databases are created directly at this version. Keep it aligned with db.ts migrations. */
export const SCHEMA_VERSION = 69;

/** Current schema only; SQLite creates the FTS shadow tables itself. */
export const SCHEMA_SQL = `
-- Tables

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  avatar TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  models_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  gen_params_json TEXT NOT NULL DEFAULT '{}',
  model TEXT,
  system_prompt_prefix TEXT NOT NULL DEFAULT '',
  system_prompt_suffix TEXT NOT NULL DEFAULT '',
  reasoning_prefill_prefix TEXT NOT NULL DEFAULT '',
  prefill_mode TEXT NOT NULL DEFAULT 'none'
);

CREATE TABLE characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  avatar TEXT,
  personality TEXT NOT NULL DEFAULT '',
  scenario TEXT NOT NULL DEFAULT '',
  first_message TEXT NOT NULL DEFAULT '',
  preset_id INTEGER REFERENCES presets(id) ON DELETE SET NULL,
  custom_prompt TEXT,
  card_json TEXT,
  created_at INTEGER NOT NULL,
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  custom_template TEXT,
  examples TEXT NOT NULL DEFAULT '',
  folder_id INTEGER REFERENCES character_folders(id) ON DELETE SET NULL,
  disable_background_swipe_generation INTEGER NOT NULL DEFAULT 0,
  chat_name TEXT
);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  endpoint_id INTEGER REFERENCES endpoints(id) ON DELETE SET NULL,
  active_leaf_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  speaker_name TEXT,
  mutation_revision INTEGER NOT NULL DEFAULT 0,
  scenario_override TEXT,
  auto_title_pending INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  reasoning TEXT,
  status TEXT NOT NULL DEFAULT 'done',
  active_child_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  model TEXT,
  gen_meta_json TEXT,
  created_at INTEGER NOT NULL,
  name TEXT,
  generation_kind TEXT NOT NULL DEFAULT 'normal',
  images_json TEXT NOT NULL DEFAULT '[]',
  active_image INTEGER NOT NULL DEFAULT 0,
  image_pending INTEGER NOT NULL DEFAULT 0,
  generation_token INTEGER,
  render_recipe_id INTEGER REFERENCES media_recipes(id) ON DELETE SET NULL
);

CREATE TABLE templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  user_prologue TEXT NOT NULL DEFAULT '',
  prefix_names INTEGER NOT NULL DEFAULT 0,
  uses_personas INTEGER NOT NULL DEFAULT 1,
  steer_template TEXT NOT NULL DEFAULT '',
  reasoning_prefill TEXT NOT NULL DEFAULT '',
  message_prefill TEXT NOT NULL DEFAULT '',
  builtin INTEGER NOT NULL DEFAULT 0,
  speaker_handoff_template TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id');

CREATE TABLE character_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE gallery_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_name TEXT NOT NULL,
  source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  source_image TEXT UNIQUE,
  prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  image TEXT,
  image_width INTEGER,
  image_height INTEGER
);

CREATE TABLE media_recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  inputs_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  instruction TEXT NOT NULL DEFAULT ''
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
  recipe_id INTEGER REFERENCES media_recipes(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  reference_deleted INTEGER NOT NULL DEFAULT 0,
  thumbnail TEXT,
  thumbnail_size INTEGER,
  thumbnail_retry_at INTEGER NOT NULL DEFAULT 0,
  thumbnail_revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE media_owners (
  asset_id INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('message', 'gallery', 'job', 'recipe')),
  owner_id INTEGER NOT NULL,
  slot TEXT NOT NULL,
  PRIMARY KEY(owner_type, owner_id, slot)
);

CREATE TABLE media_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  source_job_id INTEGER,
  recipe_id INTEGER REFERENCES media_recipes(id) ON DELETE SET NULL,
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
  retention_deadline INTEGER,
  draft_id INTEGER REFERENCES media_drafts(id)
);

CREATE TABLE media_remote_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
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

CREATE TABLE media_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open', 'accepted', 'discarding')),
  selected_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL
);

CREATE TABLE avatar_thumbnails (
  source TEXT PRIMARY KEY,
  thumbnail TEXT,
  thumbnail_size INTEGER,
  thumbnail_retry_at INTEGER NOT NULL DEFAULT 0,
  thumbnail_revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE media_characters (
  asset_id INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  PRIMARY KEY(asset_id, character_id)
);

-- Indexes

CREATE INDEX idx_messages_conversation ON messages(conversation_id);

CREATE INDEX idx_messages_parent ON messages(parent_id, conversation_id);
CREATE INDEX idx_messages_active_child ON messages(active_child_id) WHERE active_child_id IS NOT NULL;
CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);
CREATE INDEX idx_conversations_character ON conversations(character_id) WHERE character_id IS NOT NULL;
CREATE INDEX idx_conversations_persona ON conversations(persona_id) WHERE persona_id IS NOT NULL;
CREATE INDEX idx_conversations_endpoint ON conversations(endpoint_id) WHERE endpoint_id IS NOT NULL;
CREATE INDEX idx_characters_preset ON characters(preset_id) WHERE preset_id IS NOT NULL;
CREATE INDEX idx_characters_template ON characters(template_id) WHERE template_id IS NOT NULL;
CREATE INDEX idx_characters_folder ON characters(folder_id) WHERE folder_id IS NOT NULL;
CREATE INDEX idx_gallery_image ON gallery_items(image);
CREATE INDEX idx_gallery_updated ON gallery_items(updated_at DESC, id DESC);
CREATE INDEX idx_gallery_source_message ON gallery_items(source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX idx_gallery_source_conversation ON gallery_items(source_conversation_id) WHERE source_conversation_id IS NOT NULL;

CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);

CREATE INDEX media_assets_recipe ON media_assets(recipe_id);

CREATE INDEX media_owners_asset ON media_owners(asset_id);

CREATE INDEX media_jobs_active ON media_jobs(updated_at, id)
  WHERE state NOT IN ('draft', 'ready', 'succeeded', 'failed', 'cancelled');
CREATE INDEX media_jobs_history ON media_jobs(created_at DESC, id DESC);
CREATE INDEX media_jobs_state_deadline ON media_jobs(state, retention_deadline);
CREATE INDEX media_jobs_conversation ON media_jobs(context_conversation_id) WHERE context_conversation_id IS NOT NULL;
CREATE INDEX media_drafts_asset ON media_drafts(selected_asset_id) WHERE selected_asset_id IS NOT NULL;

CREATE INDEX media_jobs_message ON media_jobs(message_id);

CREATE INDEX media_remote_pending ON media_remote_files(state, retry_at);

CREATE INDEX media_remote_identity ON media_remote_files(endpoint, filename, subfolder, type, state);

CREATE INDEX messages_render_recipe ON messages(render_recipe_id);

CREATE INDEX media_jobs_draft ON media_jobs(draft_id);
CREATE INDEX media_jobs_recipe ON media_jobs(recipe_id);

CREATE INDEX media_thumbnail_pending ON media_assets(thumbnail_retry_at, id)
  WHERE thumbnail_size IS NULL;

CREATE INDEX media_thumbnail_path ON media_assets(thumbnail) WHERE thumbnail IS NOT NULL;

CREATE INDEX media_characters_character ON media_characters(character_id, asset_id);

-- Views

CREATE VIEW message_media_files AS
  SELECT m.id AS message_id, j.value AS image FROM messages m, json_each(m.images_json) j
  UNION ALL
  SELECT m.id, a.path FROM messages m
  JOIN media_owners o ON o.owner_type = 'recipe' AND o.owner_id = m.render_recipe_id
  JOIN media_assets a ON a.id = o.asset_id;

-- Triggers

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages
WHEN old.content IS NOT new.content BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

-- Asset associations record new attachments; owner maintenance must preserve later edits.
CREATE TRIGGER media_message_insert AFTER INSERT ON messages BEGIN
  INSERT OR IGNORE INTO media_assets(path, created_at)
    SELECT j.value, new.created_at FROM json_each(new.images_json) j
    WHERE NOT EXISTS (SELECT 1 FROM media_assets WHERE path = j.value);
  INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
    SELECT a.id, 'message', new.id, CAST(j.key AS TEXT)
    FROM json_each(new.images_json) j JOIN media_assets a ON a.path = j.value;
  INSERT OR IGNORE INTO media_characters(asset_id, character_id)
    SELECT a.id, c.character_id FROM json_each(new.images_json) j
    JOIN media_assets a ON a.path = j.value
    JOIN conversations c ON c.id = new.conversation_id
    WHERE c.character_id IS NOT NULL;
END;

CREATE TRIGGER media_message_update AFTER UPDATE OF images_json ON messages
WHEN old.images_json IS NOT new.images_json BEGIN
  INSERT OR IGNORE INTO media_assets(path, created_at)
    SELECT j.value, new.created_at FROM json_each(new.images_json) j
    WHERE NOT EXISTS (SELECT 1 FROM media_assets WHERE path = j.value);
  DELETE FROM media_owners
    WHERE owner_type = 'message' AND owner_id = new.id
      AND NOT EXISTS (
        SELECT 1 FROM json_each(new.images_json) j JOIN media_assets a ON a.path = j.value
        WHERE CAST(j.key AS TEXT) = media_owners.slot AND a.id = media_owners.asset_id
      );
  INSERT OR IGNORE INTO media_owners(asset_id, owner_type, owner_id, slot)
    SELECT a.id, 'message', new.id, CAST(j.key AS TEXT)
    FROM json_each(new.images_json) j JOIN media_assets a ON a.path = j.value;
  INSERT OR IGNORE INTO media_characters(asset_id, character_id)
    SELECT a.id, c.character_id FROM json_each(new.images_json) j
    JOIN media_assets a ON a.path = j.value
    JOIN conversations c ON c.id = new.conversation_id
    WHERE c.character_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM json_each(old.images_json) previous WHERE previous.value = j.value);
END;

CREATE TRIGGER media_message_delete BEFORE DELETE ON messages BEGIN
  UPDATE media_jobs SET state = 'cancelling', revision = revision + 1,
    updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE message_id = old.id AND destination = 'chat'
    AND state NOT IN ('succeeded', 'failed', 'cancelled', 'draft', 'ready');
  DELETE FROM media_owners WHERE owner_type = 'message' AND owner_id = old.id;
END;

CREATE TRIGGER media_gallery_insert AFTER INSERT ON gallery_items BEGIN
  DELETE FROM media_owners WHERE owner_type = 'gallery' AND owner_id = new.id;
  INSERT OR IGNORE INTO media_assets(path, width, height, created_at)
    SELECT new.image, new.image_width, new.image_height, new.created_at WHERE new.image IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM media_assets WHERE path = new.image);
  INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
    SELECT id, 'gallery', new.id, '0' FROM media_assets WHERE path = new.image;
END;

CREATE TRIGGER media_gallery_update AFTER UPDATE OF image ON gallery_items
WHEN old.image IS NOT new.image BEGIN
  DELETE FROM media_owners WHERE owner_type = 'gallery' AND owner_id = new.id;
  INSERT OR IGNORE INTO media_assets(path, width, height, created_at)
    SELECT new.image, new.image_width, new.image_height, new.created_at WHERE new.image IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM media_assets WHERE path = new.image);
  INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
    SELECT id, 'gallery', new.id, '0' FROM media_assets WHERE path = new.image;
END;

CREATE TRIGGER media_gallery_delete AFTER DELETE ON gallery_items BEGIN
  DELETE FROM media_owners WHERE owner_type = 'gallery' AND owner_id = old.id;
END;

CREATE TRIGGER media_job_delete AFTER DELETE ON media_jobs BEGIN
  DELETE FROM media_owners WHERE owner_type = 'job' AND owner_id = old.id;
END;

CREATE TRIGGER media_recipe_delete AFTER DELETE ON media_recipes BEGIN
  DELETE FROM media_owners WHERE owner_type = 'recipe' AND owner_id = old.id;
END;

CREATE TRIGGER media_message_recipe_delete AFTER DELETE ON messages BEGIN
  DELETE FROM media_recipes WHERE id = old.render_recipe_id
    AND NOT EXISTS (SELECT 1 FROM media_assets WHERE recipe_id = old.render_recipe_id)
    AND NOT EXISTS (SELECT 1 FROM messages WHERE render_recipe_id = old.render_recipe_id);
END;

CREATE TRIGGER media_message_recipe_update AFTER UPDATE OF render_recipe_id ON messages
  WHEN old.render_recipe_id IS NOT new.render_recipe_id BEGIN
  DELETE FROM media_recipes WHERE id = old.render_recipe_id
    AND NOT EXISTS (SELECT 1 FROM media_assets WHERE recipe_id = old.render_recipe_id)
    AND NOT EXISTS (SELECT 1 FROM messages WHERE render_recipe_id = old.render_recipe_id);
END;

CREATE TRIGGER media_draft_delete AFTER DELETE ON media_jobs BEGIN
  DELETE FROM media_drafts WHERE id = old.draft_id
    AND NOT EXISTS (SELECT 1 FROM media_jobs WHERE draft_id = old.draft_id);
END;

CREATE TRIGGER media_gallery_input_delete AFTER DELETE ON gallery_items BEGIN
  UPDATE media_assets SET reference_deleted = 1 WHERE path = old.image
    AND NOT EXISTS (SELECT 1 FROM gallery_items WHERE image = old.image);
  UPDATE media_recipes SET inputs_json = (
    SELECT json_group_array(json_set(input.value, '$.assetId',
      CASE WHEN json_extract(input.value, '$.assetId') =
        (SELECT id FROM media_assets WHERE path = old.image AND reference_deleted = 1)
      THEN NULL ELSE json_extract(input.value, '$.assetId') END))
    FROM json_each(media_recipes.inputs_json) input
  ) WHERE id IN (
    SELECT owner_id FROM media_owners WHERE owner_type = 'recipe' AND asset_id IN
      (SELECT id FROM media_assets WHERE path = old.image AND reference_deleted = 1)
  );
  DELETE FROM media_owners WHERE asset_id IN
    (SELECT id FROM media_assets WHERE path = old.image AND reference_deleted = 1)
    AND (owner_type = 'recipe' OR (owner_type = 'job' AND slot LIKE 'input:%'
      AND EXISTS (SELECT 1 FROM media_jobs WHERE id = media_owners.owner_id
        AND state IN ('draft', 'ready', 'succeeded', 'failed', 'cancelled'))));
END;


`;
