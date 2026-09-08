import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { imageFileDimensions } from './imageDimensions.ts';
import { MEDIA_SCHEMA_SQL } from './mediaSchema.ts';
import { migrateMediaFileNames, migrateNumericMediaFileNames } from './mediaFileMigration.ts';
import { migrateAvatarFileNames, migrateAvatarThumbnailPrefix } from './avatarFileMigration.ts';
import type {
  Character,
  CharacterFolder,
  Conversation,
  CustomTemplate,
  Endpoint,
  GalleryItem,
  Message,
  MediaAsset,
  MediaWorkflow,
  MediaPromptSettings,
  Persona,
  Preset,
  Template,
} from '@tinytavern/shared';
import {
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_STEER_TEMPLATE,
  DEFAULT_SPEAKER_HANDOFF_TEMPLATE,
  DEFAULT_AVATAR_CONTEXT,
  DEFAULT_SETTINGS,
  DEFAULT_CHAT_IMAGE_REVISION_TEMPLATE,
  DEFAULT_IMAGE_PROMPT_REVISION,
  migrateMediaRendering,
  systemNote,
} from '@tinytavern/shared';

export const DATA_DIR = process.env.DATA_DIR ?? '/data';
export const AVATAR_DIR = join(DATA_DIR, 'avatars');
export const IMAGES_DIR = join(DATA_DIR, 'images');
const DB_PATH = process.env.DB_PATH ?? join(DATA_DIR, 'tinytavern.db');

// SQLite holds plaintext chats and credentials; transient journals must stay private too.
process.umask(0o077);
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
privateDirectory(DATA_DIR);
if (dirname(DB_PATH) !== DATA_DIR) privateDirectory(dirname(DB_PATH));
privateDirectory(AVATAR_DIR);
privateDirectory(IMAGES_DIR);

export const db = new DatabaseSync(DB_PATH);
chmodSync(DB_PATH, 0o600);
db.exec('PRAGMA foreign_keys = ON');
// The online backup opens a separate connection; allow its short read locks to finish.
db.exec('PRAGMA busy_timeout = 5000');
// Streams stay in memory until they end. SQLite handles conversion of existing WAL databases;
// EXTRA also syncs the directory after deleting the rollback journal at commit.
db.exec('PRAGMA journal_mode = DELETE');
db.exec('PRAGMA synchronous = EXTRA');

// Query strings form a bounded set, so this cache needs no eviction.
const stmtCache = new Map<string, StatementSync>();
export function stmt(sql: string): StatementSync {
  let prepared = stmtCache.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    stmtCache.set(sql, prepared);
  }
  return prepared;
}

// Migrations cover DDL and seeds; settings moved between scopes reset to defaults.
const { user_version: version } = stmt('PRAGMA user_version').get() as {
  user_version: number;
};

function migrate(target: number, apply: () => void): void {
  if (version >= target) return;
  transaction(() => {
    apply();
    db.exec(`PRAGMA user_version = ${target}`);
  });
}

migrate(1, () => {
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
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
      created_at INTEGER NOT NULL
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
      created_at INTEGER NOT NULL
    );
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
      persona_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
      endpoint_id INTEGER REFERENCES endpoints(id) ON DELETE SET NULL,
      model TEXT,
      gen_params_json TEXT NOT NULL DEFAULT '{}',
      active_leaf_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX idx_messages_parent ON messages(parent_id);
  `);
  stmt('INSERT INTO presets (name, content, created_at) VALUES (?, ?, ?)').run(
    'Default assistant',
    'You are {{char}}, a helpful assistant talking to {{user}}. Answer accurately and concisely.',
    Date.now(),
  );
  stmt('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    'app',
    JSON.stringify({ ...DEFAULT_SETTINGS, defaultPresetId: 1, defaultTemplateId: 1 }),
  );
});

migrate(2, () => {
  db.exec(`
    CREATE TABLE templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);
  stmt('INSERT INTO templates (name, content, created_at) VALUES (?, ?, ?)').run(
    'Default',
    DEFAULT_PROMPT_TEMPLATE,
    Date.now(),
  );
});

migrate(3, () => {
  db.exec(`
    ALTER TABLE templates ADD COLUMN user_prologue TEXT NOT NULL DEFAULT '';
    ALTER TABLE characters ADD COLUMN template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL;
  `);
});

migrate(4, () => {
  db.exec(`
    ALTER TABLE conversations ADD COLUMN speaker_name TEXT;
    ALTER TABLE messages ADD COLUMN name TEXT;
    ALTER TABLE templates ADD COLUMN prefix_names INTEGER NOT NULL DEFAULT 0;
  `);
});

migrate(5, () => {
  db.exec(`
    ALTER TABLE endpoints ADD COLUMN gen_params_json TEXT NOT NULL DEFAULT '{}';
  `);
});

migrate(6, () => {
  db.exec(`
    ALTER TABLE endpoints ADD COLUMN model TEXT;
  `);
});

migrate(7, () => {
  db.exec(`
    ALTER TABLE endpoints ADD COLUMN prefill_mode TEXT NOT NULL DEFAULT 'none';
  `);
});

migrate(8, () => {
  db.exec(`
    ALTER TABLE messages ADD COLUMN generation_kind TEXT NOT NULL DEFAULT 'normal';
  `);
});

// model/gen_params_json were superseded by endpoint-owned settings and never read.
// endpoint_id stays: it becomes the per-conversation endpoint override.
migrate(9, () => {
  db.exec(`
    ALTER TABLE conversations DROP COLUMN model;
    ALTER TABLE conversations DROP COLUMN gen_params_json;
  `);
});

// External-content FTS5 avoids storing message bodies twice.
migrate(10, () => {
  db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id');
    CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
    CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    INSERT INTO messages_fts(rowid, content) SELECT id, content FROM messages;
  `);
});

// Represent the default assistant as an ordinary editable character.
migrate(11, () => {
  stmt(
    `INSERT INTO characters (name, personality, scenario, first_message, created_at)
     VALUES ('Assistant', '', '', '', ?)`,
  ).run(Date.now());
});

migrate(12, () => {
  db.exec(`
    ALTER TABLE characters ADD COLUMN custom_template TEXT;
  `);
});

migrate(13, () => {
  db.exec(`
    ALTER TABLE templates ADD COLUMN uses_personas INTEGER NOT NULL DEFAULT 1;
  `);
});

// Legacy image values: NULL, 'pending', or an /images/ path.
migrate(14, () => {
  db.exec(`
    ALTER TABLE messages ADD COLUMN image TEXT;
  `);
});

migrate(15, () => {
  db.exec(`
    ALTER TABLE messages ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE messages ADD COLUMN active_image INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN image_pending INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN image_render_json TEXT;
    UPDATE messages SET images_json = json_array(image) WHERE image IS NOT NULL AND image <> 'pending';
    ALTER TABLE messages DROP COLUMN image;
  `);
});

// Steer format now follows template resolution; empty retains DEFAULT_STEER_TEMPLATE.
migrate(16, () => {
  db.exec(`
    ALTER TABLE templates ADD COLUMN steer_template TEXT NOT NULL DEFAULT '';
  `);
});

// SillyTavern mes_example partials expand through {{examples}}.
migrate(17, () => {
  db.exec(`
    ALTER TABLE characters ADD COLUMN examples TEXT NOT NULL DEFAULT '';
  `);
});

// Optimistic conversation concurrency and generation ABA protection.
migrate(18, () => {
  db.exec(`
    ALTER TABLE conversations ADD COLUMN mutation_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN generation_token INTEGER;
  `);
});

// Deleting a folder returns its characters to the picker root.
migrate(19, () => {
  db.exec(`
    CREATE TABLE character_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at INTEGER NOT NULL
    );
    ALTER TABLE characters ADD COLUMN folder_id INTEGER
      REFERENCES character_folders(id) ON DELETE SET NULL;
  `);
});

// Persist SHA-256 token digests across restarts; auth.ts clears sessions on password changes.
migrate(20, () => {
  db.exec(`
    CREATE TABLE auth_sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
  `);
});

// Separate prefills map to OpenAI-compatible content/reasoning_content.
migrate(21, () => {
  db.exec(`
    ALTER TABLE templates ADD COLUMN reasoning_prefill TEXT NOT NULL DEFAULT '';
    ALTER TABLE templates ADD COLUMN message_prefill TEXT NOT NULL DEFAULT '';
  `);
});

// NULL inherits the character scenario; an empty string suppresses it.
migrate(22, () => {
  db.exec(`
    ALTER TABLE conversations ADD COLUMN scenario_override TEXT;
  `);
});

// Gallery items own file copies and prompt/render snapshots; source links never own them.
migrate(23, () => {
  db.exec(`
    CREATE TABLE gallery_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
      character_name TEXT NOT NULL,
      source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
      source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      source_image TEXT UNIQUE,
      prompt TEXT NOT NULL,
      images_json TEXT NOT NULL DEFAULT '[]',
      active_image INTEGER NOT NULL DEFAULT 0,
      image_render_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_gallery_character ON gallery_items(character_id, updated_at DESC);
  `);
});

// Preserve early dev-build image alternatives as separate rows before dropping swipe storage.
migrate(24, () => {
  db.exec(`
    ALTER TABLE gallery_items ADD COLUMN image TEXT;
    UPDATE gallery_items SET image = json_extract(images_json, '$[0]');
    INSERT INTO gallery_items
      (character_id, character_name, source_conversation_id, source_message_id,
       source_image, prompt, images_json, active_image, image_render_json,
       created_at, updated_at, image)
    SELECT g.character_id, g.character_name, NULL, NULL,
           NULL, g.prompt, json_array(j.value), 0, g.image_render_json,
           g.created_at, g.updated_at + CAST(j.key AS INTEGER), j.value
    FROM gallery_items g, json_each(g.images_json) j
    WHERE CAST(j.key AS INTEGER) > 0;
    ALTER TABLE gallery_items DROP COLUMN images_json;
    ALTER TABLE gallery_items DROP COLUMN active_image;
  `);
});

// Characters inherit the global speculation setting unless explicitly disabled.
migrate(25, () => {
  db.exec(`
    ALTER TABLE characters ADD COLUMN disable_background_swipe_generation INTEGER NOT NULL DEFAULT 0;
  `);
});

// Persist gallery geometry once so clients can lay out rows before loading images.
migrate(26, () => {
  db.exec(`
    ALTER TABLE gallery_items ADD COLUMN image_width INTEGER;
    ALTER TABLE gallery_items ADD COLUMN image_height INTEGER;
  `);
  const rows = stmt('SELECT id, image FROM gallery_items WHERE image IS NOT NULL').all() as {
    id: number;
    image: string;
  }[];
  for (const row of rows) {
    if (!row.image.startsWith('/images/')) continue;
    const size = imageFileDimensions(join(IMAGES_DIR, basename(row.image)));
    if (size)
      stmt('UPDATE gallery_items SET image_width = ?, image_height = ? WHERE id = ?').run(
        size.width,
        size.height,
        row.id,
      );
  }
});

// Promote the shipped image feature without reinterpreting or losing saved overrides.
migrate(27, () => {
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get() as
    { value: string } | undefined;
  if (!row) return;
  const settings = JSON.parse(row.value) as Record<string, unknown>;
  if (!Object.hasOwn(settings, 'pluginSettings')) return;
  const legacy = settings.pluginSettings as { imageGeneration?: unknown } | null;
  if (!Object.hasOwn(settings, 'imageGeneration')) {
    settings.imageGeneration = legacy?.imageGeneration ?? {};
  }
  delete settings.pluginSettings;
  const revision = Number.isSafeInteger(settings.revision) ? (settings.revision as number) : 0;
  settings.revision = revision + 1;
  stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
});

// Gallery revisions now define their complete standalone request.
migrate(28, () => {
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get() as
    { value: string } | undefined;
  if (!row) return;
  const settings = JSON.parse(row.value) as Record<string, unknown>;
  const gallery = settings.gallery as Record<string, unknown> | undefined;
  if (!gallery || !Object.hasOwn(gallery, 'promptRevisionTemplate')) return;
  if (!Object.hasOwn(gallery, 'promptRevision')) {
    const previous = gallery.promptRevisionTemplate;
    const template = { ...DEFAULT_IMAGE_PROMPT_REVISION };
    if (typeof previous === 'string' && previous !== DEFAULT_CHAT_IMAGE_REVISION_TEMPLATE) {
      // Retain custom instructions verbatim and explicitly supply the original prompt.
      template.systemPrompt = '';
      template.userMessage =
        '<original_image_prompt>\n{{prompt}}\n</original_image_prompt>\n\n' + previous;
    }
    gallery.promptRevision = template;
  }
  delete gallery.promptRevisionTemplate;
  const revision = Number.isSafeInteger(settings.revision) ? (settings.revision as number) : 0;
  settings.revision = revision + 1;
  stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
});

migrate(29, () => {
  db.exec('ALTER TABLE characters ADD COLUMN chat_name TEXT');
});

migrate(30, () => {
  db.exec(MEDIA_SCHEMA_SQL);
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get() as
    { value: string } | undefined;
  if (!row) return;
  const settings = JSON.parse(row.value) as Record<string, unknown>;
  if (!settings.mediaRendering) {
    settings.mediaRendering = migrateMediaRendering(
      (settings.imageGeneration ?? {}) as Record<string, unknown>,
    );
    settings.revision = Number(settings.revision ?? 0) + 1;
    stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
  }
});

migrate(31, () => {
  db.exec(`
    ALTER TABLE messages ADD COLUMN render_recipe_id TEXT REFERENCES media_recipes(id) ON DELETE SET NULL;
    CREATE INDEX messages_render_recipe ON messages(render_recipe_id);
  `);
  const settingsRow = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  const settings = settingsRow ? JSON.parse(String(settingsRow.value)) : {};
  const rendering = settings.mediaRendering ?? DEFAULT_SETTINGS.mediaRendering;
  const save = (prompt: string, config: string, inputs = '[]') => {
    const id = randomUUID();
    stmt(
      'INSERT INTO media_recipes(id, prompt, configuration_json, inputs_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, prompt, config, inputs, Date.now());
    stmt(`INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
      SELECT json_extract(value, '$.assetId'), 'recipe', ?, json_extract(value, '$.slot') FROM json_each(?)`).run(
      id,
      inputs,
    );
    return id;
  };
  const convert = (prompt: string, encoded: string) => {
    const image = JSON.parse(encoded);
    const workflow = rendering.workflows.find(
      (item: { operation: string; json: string }) =>
        item.operation === 'image' && item.json === image.workflow,
    );
    return save(
      prompt,
      JSON.stringify({
        comfyUrl: image.comfyUrl,
        timeoutSeconds: rendering.jobTimeoutSeconds,
        workflow: workflow ?? {
          id: randomUUID(),
          name: 'Image rendering',
          operation: 'image',
          referenceCount: 0,
          json: image.workflow,
          galleryPromptPresetId: null,
          chatPromptPresetId: null,
        },
      }),
    );
  };
  for (const row of stmt('SELECT * FROM messages').all()) {
    const paths = JSON.parse(String(row.images_json)) as string[];
    const selected = paths[Math.min(Number(row.active_image), paths.length - 1)];
    let recipeId = selected
      ? (stmt('SELECT recipe_id FROM media_assets WHERE path = ?').get(selected)?.recipe_id as
          string | null)
      : null;
    if (!recipeId && row.image_render_json) {
      recipeId = convert(String(row.content), String(row.image_render_json));
      for (const path of paths) {
        stmt('UPDATE media_assets SET recipe_id = ? WHERE path = ? AND recipe_id IS NULL').run(
          recipeId,
          path,
        );
      }
    }
    if (!recipeId) {
      const job = stmt(
        'SELECT configuration_json, inputs_json FROM media_jobs WHERE message_id = ? AND configuration_json IS NOT NULL ORDER BY created_at DESC LIMIT 1',
      ).get(row.id!);
      if (job)
        recipeId = save(
          String(row.content),
          String(job.configuration_json),
          String(job.inputs_json),
        );
    }
    if (recipeId)
      stmt('UPDATE messages SET render_recipe_id = ? WHERE id = ?').run(recipeId, row.id!);
  }
  for (const row of stmt(`SELECT g.prompt, g.image, g.image_render_json FROM gallery_items g
    JOIN media_assets a ON a.path = g.image WHERE g.image_render_json IS NOT NULL AND a.recipe_id IS NULL`).all()) {
    const recipeId = convert(String(row.prompt), String(row.image_render_json));
    stmt('UPDATE media_assets SET recipe_id = ? WHERE path = ?').run(recipeId, row.image!);
  }
  db.exec(`
    CREATE VIEW message_media_files AS
      SELECT m.id AS message_id, j.value AS image FROM messages m, json_each(m.images_json) j
      UNION ALL
      SELECT m.id, a.path FROM messages m
      JOIN media_owners o ON o.owner_type = 'recipe' AND o.owner_id = m.render_recipe_id
      JOIN media_assets a ON a.id = o.asset_id;
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
  `);
});

migrate(32, () => {
  db.exec(`
    CREATE VIEW IF NOT EXISTS message_media_files AS
      SELECT m.id AS message_id, j.value AS image FROM messages m, json_each(m.images_json) j
      UNION ALL
      SELECT m.id, a.path FROM messages m
      JOIN media_owners o ON o.owner_type = 'recipe' AND o.owner_id = m.render_recipe_id
      JOIN media_assets a ON a.id = o.asset_id;
    ALTER TABLE messages DROP COLUMN image_render_json;
    ALTER TABLE gallery_items DROP COLUMN image_render_json;
  `);
});

// Rendering settings belong exclusively to mediaRendering; prompts use named presets.
migrate(33, () => {
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  if (!row) return;
  const settings = JSON.parse(String(row.value));
  const image = settings.imageGeneration;
  if (!image) return;
  let changed = false;
  for (const [key, kind] of [
    ['describePrompt', 'describe'],
    ['instructionPrompt', 'instruction'],
    ['avatarPrompt', 'avatar'],
  ] as const) {
    if (!Object.hasOwn(image, key)) continue;
    if (typeof image[key] === 'string' && !image.promptPresets?.[kind]) {
      image.promptPresets ??= {};
      image.promptPresets[kind] = {
        presets: [{ name: 'Custom', prompt: image[key] }],
        active: 'Custom',
      };
    }
    delete image[key];
    changed = true;
  }
  for (const key of ['comfyUrl', 'workflows', 'activeWorkflow', 'avatarWorkflow', 'workflowJson']) {
    if (!Object.hasOwn(image, key)) continue;
    delete image[key];
    changed = true;
  }
  if (changed) {
    settings.revision = Number(settings.revision ?? 0) + 1;
    stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
  }
});

migrate(34, () => {
  db.exec(`
    CREATE TABLE media_drafts (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open', 'accepted', 'discarding')),
      selected_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL
    );
    ALTER TABLE media_jobs ADD COLUMN draft_id TEXT REFERENCES media_drafts(id);
    CREATE INDEX media_jobs_draft ON media_jobs(draft_id);
    CREATE TRIGGER media_draft_delete AFTER DELETE ON media_jobs BEGIN
      DELETE FROM media_drafts WHERE id = old.draft_id
        AND NOT EXISTS (SELECT 1 FROM media_jobs WHERE draft_id = old.draft_id);
    END;
  `);
});

// Chat image creation selects from the chat image presets, never gallery/workflow presets.
migrate(35, () => {
  stmt(`UPDATE media_jobs SET preset_id = NULL, revision = revision + 1
    WHERE operation = 'image' AND context_conversation_id IS NOT NULL
      AND preset_id IS NOT NULL AND preset_id NOT LIKE 'chat-image/%'`).run();
});

// Preserve the former implicit layout as an ordinary, editable saved template.
migrate(36, () => {
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  if (!row) return;
  const settings = JSON.parse(String(row.value));
  if (
    settings.defaultTemplateId != null &&
    stmt('SELECT id FROM templates WHERE id = ?').get(settings.defaultTemplateId)
  ) {
    return;
  }
  const existing = stmt(`SELECT id FROM templates WHERE content = ?
    AND user_prologue = '' AND reasoning_prefill = '' AND message_prefill = ''
    AND prefix_names = 0 AND uses_personas = 1 AND steer_template = ''
    ORDER BY id LIMIT 1`).get(DEFAULT_PROMPT_TEMPLATE);
  const templateId =
    existing?.id ??
    stmt('INSERT INTO templates (name, content, created_at) VALUES (?, ?, ?)').run(
      'Default layout',
      DEFAULT_PROMPT_TEMPLATE,
      Date.now(),
    ).lastInsertRowid;
  settings.defaultTemplateId = Number(templateId);
  settings.revision = Number(settings.revision ?? 0) + 1;
  stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
});

// Defaults are saved, selectable rows; only their editable copies may be changed.
migrate(37, () => {
  db.exec(`ALTER TABLE presets ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE templates ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0;`);
  const originalPrompt =
    'You are {{char}}, a helpful assistant talking to {{user}}. Answer accurately and concisely.';
  const seededPrompt = stmt('SELECT id, name, content FROM presets WHERE id = 1').get();
  if (
    seededPrompt &&
    (seededPrompt.content === originalPrompt || seededPrompt.content === DEFAULT_SYSTEM_PROMPT)
  ) {
    stmt('UPDATE presets SET content = ?, builtin = 1 WHERE id = 1').run(DEFAULT_SYSTEM_PROMPT);
  } else {
    if (seededPrompt?.name === 'Default assistant') {
      stmt("UPDATE presets SET name = 'Default assistant (custom)' WHERE id = 1").run();
    }
    stmt('INSERT INTO presets (name, content, builtin, created_at) VALUES (?, ?, 1, ?)').run(
      'Default assistant',
      DEFAULT_SYSTEM_PROMPT,
      Date.now(),
    );
  }
  const template = stmt(`SELECT id FROM templates WHERE (id = 1 OR name = 'Default layout')
    AND content = ? AND user_prologue = '' AND reasoning_prefill = '' AND message_prefill = ''
    AND prefix_names = 0 AND uses_personas = 1 AND steer_template = '' ORDER BY id LIMIT 1`).get(
    DEFAULT_PROMPT_TEMPLATE,
  );
  if (template) {
    stmt('UPDATE templates SET builtin = 1 WHERE id = ?').run(Number(template.id));
  } else {
    stmt("UPDATE templates SET name = 'Default (custom)' WHERE id = 1 AND name = 'Default'").run();
    stmt('INSERT INTO templates (name, content, builtin, created_at) VALUES (?, ?, 1, ?)').run(
      'Default',
      DEFAULT_PROMPT_TEMPLATE,
      Date.now(),
    );
  }
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  if (row) {
    const settings = JSON.parse(String(row.value));
    settings.revision = Number(settings.revision ?? 0) + 1;
    stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
  }
});

// Materialize previously implicit instructions once; generation only reads saved values.
migrate(38, () => {
  db.exec("ALTER TABLE templates ADD COLUMN speaker_handoff_template TEXT NOT NULL DEFAULT ''");
  stmt('UPDATE templates SET speaker_handoff_template = ?').run(DEFAULT_SPEAKER_HANDOFF_TEMPLATE);
  for (const row of stmt('SELECT id, steer_template FROM templates').all()) {
    if (!String(row.steer_template).trim()) {
      stmt('UPDATE templates SET steer_template = ? WHERE id = ?').run(
        DEFAULT_STEER_TEMPLATE,
        Number(row.id),
      );
    }
  }
  for (const row of stmt(
    'SELECT id, custom_template FROM characters WHERE custom_template IS NOT NULL',
  ).all()) {
    let template;
    try {
      template = JSON.parse(String(row.custom_template));
    } catch {
      template = { content: String(row.custom_template) };
    }
    const normalized: CustomTemplate = {
      content: template.content ?? '',
      userPrologue: template.userPrologue ?? '',
      reasoningPrefill: template.reasoningPrefill ?? '',
      messagePrefill: template.messagePrefill ?? '',
      prefixNames: template.prefixNames ?? false,
      usesPersonas: template.usesPersonas ?? true,
      steerTemplate: template.steerTemplate?.trim()
        ? template.steerTemplate
        : DEFAULT_STEER_TEMPLATE,
      speakerHandoffTemplate: DEFAULT_SPEAKER_HANDOFF_TEMPLATE,
    };
    stmt('UPDATE characters SET custom_template = ? WHERE id = ?').run(
      JSON.stringify(normalized),
      Number(row.id),
    );
  }
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  const settings = row ? JSON.parse(String(row.value)) : { ...DEFAULT_SETTINGS };
  settings.titlePrompt = DEFAULT_SETTINGS.titlePrompt;
  settings.draftCompletionPrompt = DEFAULT_SETTINGS.draftCompletionPrompt;
  settings.imageGeneration = { ...DEFAULT_SETTINGS.imageGeneration, ...settings.imageGeneration };
  for (const preset of settings.imageGeneration.promptPresets?.avatar?.presets ?? []) {
    if (preset.context === undefined) preset.context = DEFAULT_AVATAR_CONTEXT;
  }
  settings.revision = Number(settings.revision ?? 0) + 1;
  stmt(
    "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify(settings));
});

// Update the former standard instruction without replacing customized draft prompts.
migrate(39, () => {
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  if (!row) return;
  const settings = JSON.parse(String(row.value));
  const previousPrompt =
    'Complete the unfinished user input below at its exact cursor position.\n' +
    'Return only the missing continuation. Do not repeat any of the existing input. Do not add a speaker name, quotation marks, commentary, or an answer to the input.\n\n' +
    '<unfinished_user_input>\n{{draft}}\n</unfinished_user_input>';
  if (settings.draftCompletionPrompt !== previousPrompt) return;
  settings.draftCompletionPrompt = DEFAULT_SETTINGS.draftCompletionPrompt;
  settings.revision = Number(settings.revision ?? 0) + 1;
  stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
});

// Clarify interjected assistance tasks while preserving custom prompt text.
migrate(40, () => {
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  if (!row) return;
  const settings = JSON.parse(String(row.value));
  const previousTitlePrompt =
    'Summarize this conversation in 3-6 words for a sidebar title. Reply with only the title, no quotes.\n\nUser: {{userMessage}}\n\nAssistant: {{assistantMessage}}';
  const previousDraftPrompt =
    'Continue the unfinished user message below in the same voice and style.\n' +
    'Return the complete message: first reproduce the existing draft exactly, character for character, then continue directly from its end. ' +
    'Preserve every space, tab, line break, punctuation mark, and Markdown character, including leading and trailing whitespace. Do not correct, reformat, or repeat any part of the draft twice.\n' +
    'Write as the user, not as an assistant answering them. Return only the message itself, without commentary, speaker labels, surrounding quotation marks, or added code fences. Do not include the delimiter tags.\n\n' +
    '<unfinished_user_input>\n{{draft}}\n</unfinished_user_input>';
  let changed = false;
  if (settings.titlePrompt === previousTitlePrompt) {
    settings.titlePrompt = DEFAULT_SETTINGS.titlePrompt;
    changed = true;
  }
  if (settings.draftCompletionPrompt === previousDraftPrompt) {
    settings.draftCompletionPrompt = DEFAULT_SETTINGS.draftCompletionPrompt;
    changed = true;
  }
  if (!changed) return;
  settings.revision = Number(settings.revision ?? 0) + 1;
  stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
});

// Title generation now steers the full chat; track manual titles independently of their text.
migrate(41, () => {
  db.exec('ALTER TABLE conversations ADD COLUMN auto_title_pending INTEGER NOT NULL DEFAULT 0');
  stmt(`UPDATE conversations SET auto_title_pending = 1
    WHERE (title = 'New chat' OR title = (SELECT name FROM characters WHERE id = character_id))
      AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = conversations.id AND role = 'user')`).run();
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  if (!row) return;
  const settings = JSON.parse(String(row.value));
  // Standalone message slots no longer exist; other custom steering instructions remain valid.
  if (
    typeof settings.titlePrompt !== 'string' ||
    !/\{\{(?:userMessage|assistantMessage)\}\}/i.test(settings.titlePrompt)
  )
    return;
  settings.titlePrompt = DEFAULT_SETTINGS.titlePrompt;
  settings.revision = Number(settings.revision ?? 0) + 1;
  stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
});

// Reference images are Comfy workflow inputs; their saved prompts are not LLM context.
migrate(42, () => {
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  if (row) {
    const settings = JSON.parse(String(row.value));
    let changed = false;
    for (const preset of settings.mediaPrompts?.presets ?? []) {
      for (const key of [
        'systemPrompt',
        'userMessage',
        'reasoningPrefill',
        'messagePrefill',
        'chatPrompt',
      ]) {
        if (typeof preset[key] !== 'string') continue;
        let text = preset[key]
          .replace(
            /<reference_descriptions>\s*\{\{references\}\}\s*<\/reference_descriptions>\s*/gi,
            '',
          )
          .replace(/\{\{references\}\}/gi, '');
        if (preset[key] === '{{references}}\n\n{{instruction}}') text = '{{instruction}}';
        const kind = preset.operation.startsWith('video') ? 'video' : 'image';
        const previousSystem = `Write a detailed ${kind}-generation prompt from the supplied instruction and reference context. Return only the complete final prompt, without analysis or commentary.`;
        if (text === previousSystem) {
          text = `Write a detailed ${kind}-generation prompt from the supplied instruction. Return only the complete final prompt, without analysis or commentary.`;
        }
        if (text !== preset[key]) {
          preset[key] = text;
          changed = true;
        }
      }
    }
    if (changed) {
      settings.revision = Number(settings.revision ?? 0) + 1;
      stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
    }
  }
  for (const table of ['media_jobs', 'media_recipes']) {
    for (const row of stmt(
      `SELECT id, inputs_json FROM ${table} WHERE inputs_json LIKE '%"description"%'`,
    ).all()) {
      const inputs = JSON.parse(String(row.inputs_json)).map(
        ({ description, ...input }: { description?: string; slot: string; assetId: number }) =>
          input,
      );
      stmt(`UPDATE ${table} SET inputs_json = ? WHERE id = ?`).run(
        JSON.stringify(inputs),
        String(row.id),
      );
    }
  }
});

// Make the steering marker visible in existing settings, including custom instructions.
function markSteeringPrompts() {
  const mark = (record: Record<string, unknown>, key: string) => {
    if (typeof record[key] === 'string') record[key] = systemNote(record[key]);
  };
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  if (row) {
    const settings = JSON.parse(String(row.value));
    const previous = JSON.stringify(settings);
    mark(settings, 'titlePrompt');
    mark(settings, 'draftCompletionPrompt');
    const images = settings.imageGeneration;
    if (images) {
      mark(images, 'promptRevisionTemplate');
      mark(images, 'promptRevisionContext');
      for (const [kind, set] of Object.entries(images.promptPresets ?? {})) {
        if (kind === 'avatar') continue;
        for (const preset of (set as { presets: Record<string, unknown>[] }).presets) {
          mark(preset, 'prompt');
        }
      }
    }
    for (const preset of settings.mediaPrompts?.presets ?? []) mark(preset, 'chatPrompt');
    if (JSON.stringify(settings) !== previous) {
      settings.revision = Number(settings.revision ?? 0) + 1;
      stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
    }
  }
  for (const row of stmt(
    'SELECT id, steer_template, speaker_handoff_template FROM templates',
  ).all()) {
    stmt('UPDATE templates SET steer_template = ?, speaker_handoff_template = ? WHERE id = ?').run(
      systemNote(String(row.steer_template)),
      systemNote(String(row.speaker_handoff_template)),
      Number(row.id),
    );
  }
  for (const row of stmt(
    'SELECT id, custom_template FROM characters WHERE custom_template IS NOT NULL',
  ).all()) {
    const template = JSON.parse(String(row.custom_template));
    mark(template, 'steerTemplate');
    mark(template, 'speakerHandoffTemplate');
    stmt('UPDATE characters SET custom_template = ? WHERE id = ?').run(
      JSON.stringify(template),
      Number(row.id),
    );
  }
}
migrate(43, markSteeringPrompts);
// Hot-reload installations may already have received the marker beside an older task heading.
migrate(44, markSteeringPrompts);

// Separate prompt entities/defaults and workflow references for each settings page.
migrate(45, () => {
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  const splitWorkflow = (workflow: Record<string, unknown>) => {
    if (!Object.hasOwn(workflow, 'promptPresetId')) return;
    workflow.galleryPromptPresetId = workflow.promptPresetId;
    workflow.chatPromptPresetId = String(workflow.operation).startsWith('video')
      ? workflow.promptPresetId
      : null;
    delete workflow.promptPresetId;
  };
  if (row) {
    const settings = JSON.parse(String(row.value));
    const before = JSON.stringify(settings);
    const previous = settings.mediaPrompts;
    if (previous) {
      for (const key of ['galleryImagePrompts', 'galleryVideoPrompts', 'chatVideoPrompts']) {
        const chat = key === 'chatVideoPrompts';
        const presets = previous.presets
          .filter(
            (preset: Record<string, unknown>) =>
              String(preset.operation).startsWith('video') === (key !== 'galleryImagePrompts'),
          )
          .map((preset: Record<string, unknown>) => {
            const {
              id,
              name,
              operation,
              chatPrompt,
              systemPrompt,
              userMessage,
              reasoningPrefill,
              messagePrefill,
            } = preset;
            return chat
              ? {
                  id,
                  name,
                  operation,
                  chatPrompt: systemNote(
                    typeof chatPrompt === 'string'
                      ? chatPrompt
                      : `${systemPrompt}\n\n${userMessage}`.replace(/\{\{context\}\}/gi, '').trim(),
                  ),
                }
              : {
                  id,
                  name,
                  operation,
                  systemPrompt,
                  userMessage,
                  reasoningPrefill,
                  messagePrefill,
                };
          });
        settings[key] = {
          presets,
          defaults: Object.fromEntries(
            Object.entries(previous.defaults).filter(
              ([operation]) => operation.startsWith('video') === (key !== 'galleryImagePrompts'),
            ),
          ),
        };
      }
    }
    for (const key of ['galleryImagePrompts', 'galleryVideoPrompts', 'chatVideoPrompts']) {
      settings[key] ??= { presets: [], defaults: {} };
    }
    delete settings.mediaPrompts;
    for (const workflow of settings.mediaRendering?.workflows ?? []) splitWorkflow(workflow);
    if (JSON.stringify(settings) !== before) {
      settings.revision = Number(settings.revision ?? 0) + 1;
      stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
    }
  }
  for (const table of ['media_jobs', 'media_recipes']) {
    for (const row of stmt(
      `SELECT id, configuration_json FROM ${table} WHERE configuration_json IS NOT NULL`,
    ).all()) {
      const config = JSON.parse(String(row.configuration_json));
      if (config.workflow) splitWorkflow(config.workflow);
      stmt(`UPDATE ${table} SET configuration_json = ? WHERE id = ?`).run(
        JSON.stringify(config),
        String(row.id),
      );
    }
  }
});

// A workflow has exactly one image/video output node; output selection is no longer configurable.
migrate(46, () => {
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  if (row) {
    const settings = JSON.parse(String(row.value));
    let changed = false;
    for (const workflow of settings.mediaRendering?.workflows ?? []) {
      if (Object.hasOwn(workflow, 'outputNodes')) {
        delete workflow.outputNodes;
        changed = true;
      }
    }
    if (changed) {
      settings.revision = Number(settings.revision ?? 0) + 1;
      stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
    }
  }
  for (const table of ['media_jobs', 'media_recipes']) {
    stmt(`UPDATE ${table}
      SET configuration_json = json_remove(configuration_json, '$.workflow.outputNodes')
      WHERE json_type(configuration_json, '$.workflow.outputNodes') IS NOT NULL`).run();
  }
});

migrate(47, () => {
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  if (row) {
    const settings = JSON.parse(String(row.value));
    const before = JSON.stringify(settings);
    if (settings.mediaRendering) {
      settings.mediaRendering.workflows = settings.mediaRendering.workflows.filter(
        (workflow: Record<string, unknown>) => workflow.operation !== 'video-frames',
      );
      for (const key of Object.keys(settings.mediaRendering.defaults)) {
        if (key.startsWith('video-frames:')) delete settings.mediaRendering.defaults[key];
      }
    }
    for (const key of ['chatVideoPrompts', 'galleryVideoPrompts']) {
      if (!settings[key]) continue;
      settings[key].presets = settings[key].presets.filter(
        (preset: Record<string, unknown>) => preset.operation !== 'video-frames',
      );
      delete settings[key].defaults['video-frames'];
    }
    if (JSON.stringify(settings) !== before) {
      settings.revision = Number(settings.revision ?? 0) + 1;
      stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
    }
  }
  // The worker cancels remote submissions and releases uploads/outputs through its normal path.
  stmt(`UPDATE media_jobs SET state = 'cancelling', revision = revision + 1,
    error = 'This media operation has been removed'
    WHERE operation = 'video-frames' AND state NOT IN ('succeeded', 'failed', 'cancelled')`).run();
});

// A deleted gallery source is unavailable as a reference even while an active job uses its file.
migrate(48, () => {
  db.exec(`
    ALTER TABLE media_assets ADD COLUMN reference_deleted INTEGER NOT NULL DEFAULT 0;
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
  `);
});

// Snapshot available source prompts for existing jobs and recipes. Deleted/unsourced images have none.
migrate(49, () => {
  for (const table of ['media_jobs', 'media_recipes']) {
    stmt(`UPDATE ${table} SET inputs_json = (
      SELECT json_group_array(json_set(input.value, '$.prompt',
        COALESCE(json_extract(input.value, '$.prompt'), (
          SELECT r.prompt FROM media_assets a JOIN media_recipes r ON r.id = a.recipe_id
          WHERE a.id = json_extract(input.value, '$.assetId')
        ), '')))
      FROM json_each(${table}.inputs_json) input
    ) WHERE EXISTS (
      SELECT 1 FROM json_each(${table}.inputs_json) input
      WHERE json_type(input.value, '$.prompt') IS NULL
    )`).run();
  }
});

// The shared media tools own gallery generation; retain revision text as a named preset.
migrate(50, () => {
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  if (!row) return;
  const settings = JSON.parse(String(row.value));
  if (!settings.gallery) return;
  const template = settings.gallery.promptRevision ?? DEFAULT_IMAGE_PROMPT_REVISION;
  const prompts: MediaPromptSettings = settings.galleryImagePrompts ?? {
    presets: [],
    defaults: {},
  };
  const names = new Set(prompts.presets.map((preset) => preset.name));
  let name = 'Revise image prompt';
  for (let suffix = 2; names.has(name); suffix++) name = `Revise image prompt (${suffix})`;
  prompts.presets.push({
    ...template,
    id: prompts.presets.some((preset) => preset.id === 'image-prompt-revision')
      ? randomUUID()
      : 'image-prompt-revision',
    name,
    operation: 'image',
  });
  settings.galleryImagePrompts = prompts;
  delete settings.gallery;
  settings.revision = (settings.revision ?? 0) + 1;
  stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
});

// Migration 51 briefly seeded a sample workflow. Remove the untouched example;
// Describe image now starts unconfigured, and user edits/selections are preserved.
migrate(52, () => {
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  if (!row) return;
  const settings = JSON.parse(String(row.value));
  const rendering = settings.mediaRendering;
  if (!rendering) return;
  const removedIds = new Set<string>();
  rendering.workflows = rendering.workflows.filter((workflow: MediaWorkflow) => {
    if (
      workflow.id !== 'image-description' ||
      workflow.operation !== 'image-describe' ||
      workflow.name !== 'Qwen image description' ||
      workflow.referenceCount !== 0 ||
      workflow.galleryPromptPresetId !== null ||
      workflow.chatPromptPresetId !== null
    )
      return true;
    // Exact fingerprint of the seeded JSON; even formatting edits retain the workflow.
    const fingerprint = createHash('sha256').update(workflow.json).digest('hex');
    if (fingerprint !== '9b5ac5773b65f48a181d2bc54f41de6aa38a8d681e654ab39e77f06751c9d206')
      return true;
    removedIds.add(workflow.id);
    return false;
  });
  if (!removedIds.size) return;
  const key = 'image-describe:0';
  if (removedIds.has(rendering.defaults[key])) delete rendering.defaults[key];
  settings.revision = (settings.revision ?? 0) + 1;
  stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
});

// Gallery thumbnails are replaceable derivatives, independent of original media and recipes.
migrate(53, () => {
  db.exec(`
    ALTER TABLE gallery_items ADD COLUMN thumbnail TEXT;
    ALTER TABLE gallery_items ADD COLUMN thumbnail_size INTEGER;
    ALTER TABLE gallery_items ADD COLUMN thumbnail_retry_at INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX gallery_thumbnail_pending ON gallery_items(thumbnail_retry_at, id)
      WHERE thumbnail_size IS NULL;
    CREATE INDEX gallery_thumbnail_path ON gallery_items(thumbnail) WHERE thumbnail IS NOT NULL;
  `);
});

migrate(54, () => {
  db.exec(`
    ALTER TABLE media_assets ADD COLUMN thumbnail TEXT;
    ALTER TABLE media_assets ADD COLUMN thumbnail_size INTEGER;
    ALTER TABLE media_assets ADD COLUMN thumbnail_retry_at INTEGER NOT NULL DEFAULT 0;
    UPDATE media_assets SET (thumbnail, thumbnail_size) = (
      SELECT thumbnail, thumbnail_size FROM gallery_items
      WHERE image = media_assets.path AND thumbnail IS NOT NULL ORDER BY id LIMIT 1
    );
    CREATE INDEX media_thumbnail_pending ON media_assets(thumbnail_retry_at, id)
      WHERE thumbnail_size IS NULL;
    CREATE INDEX media_thumbnail_path ON media_assets(thumbnail) WHERE thumbnail IS NOT NULL;
    DROP INDEX gallery_thumbnail_pending;
    DROP INDEX gallery_thumbnail_path;
    ALTER TABLE gallery_items DROP COLUMN thumbnail;
    ALTER TABLE gallery_items DROP COLUMN thumbnail_size;
    ALTER TABLE gallery_items DROP COLUMN thumbnail_retry_at;
    ALTER TABLE media_assets DROP COLUMN poster;
    CREATE TABLE avatar_thumbnails (
      source TEXT PRIMARY KEY,
      thumbnail TEXT,
      thumbnail_size INTEGER,
      thumbnail_retry_at INTEGER NOT NULL DEFAULT 0
    );
  `);
});

// Separate migration also covers development databases that applied the thumbnail move earlier.
migrate(55, () => {
  const columns = stmt('PRAGMA table_info(media_assets)').all();
  if (!columns.some((column) => column.name === 'thumbnail_revision')) {
    db.exec('ALTER TABLE media_assets ADD COLUMN thumbnail_revision INTEGER NOT NULL DEFAULT 0');
  }
});

// Chat videos saved to the gallery previously went through the raster dimension reader.
migrate(56, () => {
  stmt(`UPDATE gallery_items SET (image_width, image_height) = (
    SELECT width, height FROM media_assets WHERE path = gallery_items.image
  ) WHERE (image_width IS NULL OR image_height IS NULL)
    AND EXISTS (SELECT 1 FROM media_assets WHERE path = gallery_items.image
      AND width > 0 AND height > 0)`).run();
});

// Replace the old one-hour default; explicitly different limits remain configured.
migrate(57, () => {
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  if (row) {
    const settings = JSON.parse(String(row.value));
    if (settings.mediaRendering?.jobTimeoutSeconds === 3600) {
      settings.mediaRendering.jobTimeoutSeconds = 0;
      settings.revision = Number(settings.revision ?? 0) + 1;
      stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
    }
  }
  stmt(`UPDATE media_jobs SET
    configuration_json = json_set(configuration_json, '$.timeoutSeconds', 0), deadline = NULL
    WHERE json_extract(configuration_json, '$.timeoutSeconds') = 3600`).run();
  stmt(`UPDATE media_recipes SET
    configuration_json = json_set(configuration_json, '$.timeoutSeconds', 0)
    WHERE json_extract(configuration_json, '$.timeoutSeconds') = 3600`).run();
});

// Image editing has one to three reference images, with no separate source slot.
migrate(58, () => {
  const isEdit = (operation: string) =>
    operation === 'image-edit' || operation === 'image-edit-references';
  const renameSlot = (slot: string) => {
    if (slot === 'source') return 'reference1';
    const match = /^reference([123])$/.exec(slot);
    return match ? `reference${Number(match[1]) + 1}` : slot;
  };
  const renamePromptMacros = (text: string) =>
    text.replace(
      /\{\{(\s*(?:#if\s+)?)(source|reference[123])_prompt(\s*)\}\}/gi,
      (_, prefix, slot, suffix) => `{{${prefix}${renameSlot(slot.toLowerCase())}_prompt${suffix}}}`,
    );
  const convertWorkflow = (workflow: Record<string, any>) => {
    const count = workflow.operation === 'image-edit' ? 1 : workflow.referenceCount + 1;
    workflow.operation = 'image-edit';
    workflow.referenceCount = Math.min(count, 3);
    if (!workflow.json.trim()) return;
    // Keep unquoted numeric seed macros while parsing the graph to target only loader filenames.
    const seedMarker = `migration-seed-${randomUUID()}`;
    const graph = JSON.parse(workflow.json.replace(/\{\{seed\}\}/gi, JSON.stringify(seedMarker)));
    const renameMacros = (value: any): any => {
      if (typeof value === 'string') {
        return value.replace(
          /\{\{(source|reference[123])\}\}/gi,
          (_, slot) => `{{${renameSlot(slot.toLowerCase())}}}`,
        );
      }
      if (Array.isArray(value)) return value.map(renameMacros);
      if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) value[key] = renameMacros(value[key]);
      }
      return value;
    };
    renameMacros(graph);
    for (const node of Object.values(graph) as Record<string, any>[]) {
      if (node.class_type !== 'LoadImage' && node.class_type !== 'LoadImageMask') continue;
      if (typeof node.inputs?.image !== 'string') continue;
      node.inputs.image = node.inputs.image.replace(
        /(^|\/)(source|reference[123])\.png( \[input\])?$/,
        (_: string, prefix: string, slot: string, suffix: string = '') => {
          const reference = renameSlot(slot);
          if (reference === 'reference4') return '{{reference4}}';
          return `${prefix}${reference}.png${suffix}`;
        },
      );
    }
    // A former four-input workflow stays editable in the three-reference group, but
    // reference4 remains an explicit validation error until its graph is corrected.
    if (count > 3) workflow.name += ' (requires three-reference workflow)';
    workflow.json = JSON.stringify(graph).replaceAll(JSON.stringify(seedMarker), '{{seed}}');
  };
  const row = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  if (row) {
    const settings = JSON.parse(String(row.value));
    const before = JSON.stringify(settings);
    const rendering = settings.mediaRendering;
    for (const workflow of rendering?.workflows ?? []) {
      if (isEdit(workflow.operation)) convertWorkflow(workflow);
    }
    if (rendering?.defaults) {
      const defaults = { ...rendering.defaults };
      for (const key of Object.keys(rendering.defaults)) {
        if (key.startsWith('image-edit:') || key.startsWith('image-edit-references:')) {
          delete rendering.defaults[key];
          const workflow = rendering.workflows.find((item: any) => item.id === defaults[key]);
          if (workflow && key !== 'image-edit-references:3') {
            rendering.defaults[`image-edit:${workflow.referenceCount}`] = workflow.id;
          }
        }
      }
    }
    const prompts = settings.galleryImagePrompts;
    if (prompts) {
      const names = new Set<string>();
      for (const preset of prompts.presets) {
        if (!isEdit(preset.operation)) continue;
        preset.operation = 'image-edit';
        const originalName = preset.name;
        for (let suffix = 2; names.has(preset.name.toLowerCase()); suffix++) {
          preset.name = `${originalName} (${suffix})`;
        }
        names.add(preset.name.toLowerCase());
        for (const field of ['systemPrompt', 'userMessage', 'reasoningPrefill', 'messagePrefill']) {
          if (typeof preset[field] === 'string') preset[field] = renamePromptMacros(preset[field]);
        }
      }
      if (!prompts.defaults['image-edit'] && prompts.defaults['image-edit-references']) {
        prompts.defaults['image-edit'] = prompts.defaults['image-edit-references'];
      }
      delete prompts.defaults['image-edit-references'];
    }
    if (JSON.stringify(settings) !== before) {
      settings.revision = Number(settings.revision ?? 0) + 1;
      stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
    }
  }
  for (const table of ['media_jobs', 'media_recipes']) {
    const rows = stmt(`SELECT * FROM ${table} WHERE
      json_extract(configuration_json, '$.workflow.operation') IN ('image-edit', 'image-edit-references')
      ${table === 'media_jobs' ? "OR operation IN ('image-edit', 'image-edit-references')" : ''}`).all();
    for (const row of rows) {
      const configuration = row.configuration_json
        ? JSON.parse(String(row.configuration_json))
        : null;
      if (configuration?.workflow) convertWorkflow(configuration.workflow);
      const inputs = JSON.parse(String(row.inputs_json));
      for (const input of inputs) input.slot = renameSlot(input.slot);
      stmt(`UPDATE ${table} SET configuration_json = ?, inputs_json = ? WHERE id = ?`).run(
        configuration ? JSON.stringify(configuration) : null,
        JSON.stringify(inputs),
        row.id!,
      );
      const ownerType = table === 'media_jobs' ? 'job' : 'recipe';
      // Rename from the end so the unique owner/slot key never collides.
      for (const slot of ['reference3', 'reference2', 'reference1', 'source']) {
        stmt(
          'UPDATE media_owners SET slot = ? WHERE owner_type = ? AND owner_id = ? AND slot = ?',
        ).run(renameSlot(slot), ownerType, row.id!, slot);
      }
    }
  }
  stmt(
    "UPDATE media_jobs SET operation = 'image-edit', revision = revision + 1 WHERE operation IN ('image-edit', 'image-edit-references')",
  ).run();
});

migrate(59, () => {
  db.exec("ALTER TABLE media_recipes ADD COLUMN instruction TEXT NOT NULL DEFAULT ''");
  // Recover existing instructions while their generating jobs are still available.
  stmt(`UPDATE media_recipes SET instruction = (
    SELECT instruction FROM media_jobs WHERE id = media_recipes.id
  ) WHERE EXISTS (SELECT 1 FROM media_jobs WHERE id = media_recipes.id)`).run();
});

migrate(60, () => {
  db.exec(`CREATE TABLE media_characters (
    asset_id INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    PRIMARY KEY(asset_id, character_id)
  );
  CREATE INDEX media_characters_character ON media_characters(character_id, asset_id);
  INSERT OR IGNORE INTO media_characters
    SELECT a.id, g.character_id FROM gallery_items g JOIN media_assets a ON a.path = g.image
    WHERE g.character_id IS NOT NULL;
  INSERT OR IGNORE INTO media_characters
    SELECT o.asset_id, c.character_id FROM media_owners o
    JOIN messages m ON o.owner_type = 'message' AND m.id = CAST(o.owner_id AS INTEGER)
    JOIN conversations c ON c.id = m.conversation_id WHERE c.character_id IS NOT NULL;
  CREATE TRIGGER media_message_characters AFTER INSERT ON media_owners
    WHEN new.owner_type = 'message' BEGIN
      INSERT OR IGNORE INTO media_characters(asset_id, character_id)
        SELECT new.asset_id, c.character_id FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = CAST(new.owner_id AS INTEGER) AND c.character_id IS NOT NULL;
    END;
  DROP INDEX idx_gallery_character;
  ALTER TABLE gallery_items DROP COLUMN character_id;`);
});

// Also install this on development databases that already applied the association tables.
migrate(61, () => {
  db.exec(`CREATE TRIGGER IF NOT EXISTS media_message_characters AFTER INSERT ON media_owners
    WHEN new.owner_type = 'message' BEGIN
      INSERT OR IGNORE INTO media_characters(asset_id, character_id)
        SELECT new.asset_id, c.character_id FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = CAST(new.owner_id AS INTEGER) AND c.character_id IS NOT NULL;
    END;`);
});

// Durable links precede the path transaction; startup's orphan sweep removes old names afterward.
migrate(62, () => migrateMediaFileNames(IMAGES_DIR, stmt));

migrate(63, () => {
  db.exec('ALTER TABLE avatar_thumbnails ADD COLUMN thumbnail_revision INTEGER NOT NULL DEFAULT 0');
});

migrate(64, () => {
  migrateNumericMediaFileNames(IMAGES_DIR, stmt);
  migrateAvatarFileNames(AVATAR_DIR, stmt);
});

migrate(65, () => migrateAvatarThumbnailPrefix(AVATAR_DIR, stmt));

// Text generations cannot resume after a restart; submitted media jobs recover separately.
// Speculative placeholders are disposable; do not expose them as broken swipe choices.
stmt("DELETE FROM messages WHERE status = 'streaming' AND generation_kind = 'speculative'").run();
stmt(
  `UPDATE messages SET status = 'error',
   gen_meta_json = json_object('error', 'Server restarted during generation') WHERE status = 'streaming'
   AND NOT EXISTS (SELECT 1 FROM media_jobs j WHERE j.message_id = messages.id
     AND j.state NOT IN ('succeeded', 'failed', 'cancelled', 'draft'))`,
).run();
// Preserve pending attachments owned by recoverable media jobs; clear legacy stale flags.
stmt(`UPDATE messages SET image_pending = 0 WHERE image_pending = 1
  AND NOT EXISTS (SELECT 1 FROM media_jobs j WHERE j.message_id = messages.id
    AND j.state NOT IN ('succeeded', 'failed', 'cancelled', 'draft', 'ready'))`).run();

/**
 * Only the outermost call opens/commits; there are no savepoints.
 * Inner failures roll back only if propagated; catching them commits the inner writes.
 */
export function transaction<T>(fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

type Row = Record<string, unknown>;

const assetCache = new Map<string, MediaAsset>();
const assetObservers = new Set<() => void>();
export function observeMediaAssets(observer: () => void): () => void {
  assetObservers.add(observer);
  return () => {
    assetObservers.delete(observer);
  };
}
export function invalidateMediaAsset(path: string): void {
  assetCache.delete(path);
  for (const observer of assetObservers) observer();
}

export function toMediaAsset(row: Row): MediaAsset {
  return {
    id: row.id as number,
    kind: row.kind as MediaAsset['kind'],
    url: row.path as string,
    mime: row.mime as string,
    byteSize: row.byte_size as number | null,
    width: row.width as number | null,
    height: row.height as number | null,
    duration: row.duration as number | null,
    thumbnail: row.thumbnail as string | null,
    thumbnailRevision: row.thumbnail_revision as number,
    recipeId: row.recipe_id as string | null,
  };
}

export function mediaAssetForPath(path: string): MediaAsset | undefined {
  const cached = assetCache.get(path);
  if (cached) return cached;
  const row = stmt('SELECT * FROM media_assets WHERE path = ?').get(path);
  if (!row) return undefined;
  const asset = toMediaAsset(row);
  if (assetCache.size >= 16384) assetCache.delete(assetCache.keys().next().value!);
  assetCache.set(path, asset);
  return asset;
}

function parseCustomTemplate(raw: string | null): CustomTemplate | null {
  if (!raw) return null;
  return JSON.parse(raw) as CustomTemplate;
}

export function toMessage(r: Row): Message {
  const images = r.images_json ? (JSON.parse(r.images_json as string) as string[]) : [];
  return {
    id: r.id as number,
    conversationId: r.conversation_id as number,
    parentId: r.parent_id as number | null,
    role: r.role as Message['role'],
    content: r.content as string,
    reasoning: (r.reasoning as string | null) ?? null,
    name: r.name as string | null,
    status: r.status as Message['status'],
    activeChildId: r.active_child_id as number | null,
    model: r.model as string | null,
    genMeta: r.gen_meta_json ? JSON.parse(r.gen_meta_json as string) : null,
    generationKind: r.generation_kind as Message['generationKind'],
    generationToken: (r.generation_token as number | null) ?? null,
    media: images.map((path) => {
      const asset = mediaAssetForPath(path);
      // Attachment triggers create asset records for every stored path, including missing files.
      if (!asset) throw new Error(`Missing media asset for message ${r.id}: ${path}`);
      return asset;
    }),
    activeImage: (r.active_image as number) ?? 0,
    imagePending: (r.image_pending as number) === 1,
    hasImageRender: r.render_recipe_id != null,
    createdAt: r.created_at as number,
  };
}

export function toGalleryItem(r: Row): GalleryItem {
  const characters = JSON.parse(String(r.characters_json)) as GalleryItem['characters'];
  return {
    id: r.id as number,
    characters,
    characterName:
      characters.map((character) => character.name).join(', ') || String(r.character_name),
    sourceConversationId: (r.source_conversation_id as number | null) ?? null,
    sourceMessageId: (r.source_message_id as number | null) ?? null,
    sourceImage: (r.source_image as string | null) ?? null,
    prompt: r.prompt as string,
    image: r.image as string,
    media: typeof r.image === 'string' ? mediaAssetForPath(r.image) : undefined,
    imageWidth: (r.image_width as number | null) ?? null,
    imageHeight: (r.image_height as number | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function toConversation(r: Row): Conversation {
  return {
    id: r.id as number,
    title: r.title as string,
    characterId: r.character_id as number | null,
    personaId: r.persona_id as number | null,
    endpointId: r.endpoint_id as number | null,
    speakerName: r.speaker_name as string | null,
    scenarioOverride: (r.scenario_override as string | null) ?? null,
    activeLeafId: r.active_leaf_id as number | null,
    mutationRevision: (r.mutation_revision as number) ?? 0,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function toCharacter(r: Row): Character {
  return {
    id: r.id as number,
    name: r.name as string,
    chatName: (r.chat_name as string | null) ?? null,
    folderId: (r.folder_id as number | null) ?? null,
    avatar: r.avatar as string | null,
    personality: r.personality as string,
    scenario: r.scenario as string,
    examples: r.examples as string,
    firstMessage: r.first_message as string,
    presetId: r.preset_id as number | null,
    customPrompt: r.custom_prompt as string | null,
    templateId: r.template_id as number | null,
    customTemplate: parseCustomTemplate(r.custom_template as string | null),
    disableBackgroundSwipeGeneration: !!r.disable_background_swipe_generation,
    createdAt: r.created_at as number,
  };
}

export function toCharacterFolder(r: Row): CharacterFolder {
  return {
    id: r.id as number,
    name: r.name as string,
    createdAt: r.created_at as number,
  };
}

export function toPreset(r: Row): Preset {
  return {
    id: r.id as number,
    readOnly: r.builtin === 1,
    name: r.name as string,
    content: r.content as string,
    createdAt: r.created_at as number,
  };
}

export function toTemplate(r: Row): Template {
  return {
    id: r.id as number,
    readOnly: r.builtin === 1,
    name: r.name as string,
    content: r.content as string,
    userPrologue: r.user_prologue as string,
    reasoningPrefill: r.reasoning_prefill as string,
    messagePrefill: r.message_prefill as string,
    prefixNames: (r.prefix_names as number) !== 0,
    usesPersonas: (r.uses_personas as number) !== 0,
    steerTemplate: r.steer_template as string,
    speakerHandoffTemplate: r.speaker_handoff_template as string,
    createdAt: r.created_at as number,
  };
}

export function toPersona(r: Row): Persona {
  return {
    id: r.id as number,
    name: r.name as string,
    avatar: r.avatar as string | null,
    description: r.description as string,
    createdAt: r.created_at as number,
  };
}

export function toEndpoint(r: Row): Endpoint {
  const apiKey = r.api_key as string;
  return {
    id: r.id as number,
    name: r.name as string,
    baseUrl: r.base_url as string,
    apiKey,
    hasApiKey: apiKey.length > 0,
    models: JSON.parse(r.models_json as string),
    model: r.model as string | null,
    genParams: JSON.parse(r.gen_params_json as string),
    prefillMode: r.prefill_mode as Endpoint['prefillMode'],
    createdAt: r.created_at as number,
  };
}
