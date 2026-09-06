import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  Character,
  CharacterFolder,
  Conversation,
  CustomTemplate,
  Endpoint,
  GalleryItem,
  Message,
  Persona,
  Preset,
  Template,
} from '@minitavern/shared';
import { DEFAULT_PROMPT_TEMPLATE, DEFAULT_SETTINGS } from '@minitavern/shared';

export const DATA_DIR = process.env.DATA_DIR ?? '/data';
export const AVATAR_DIR = join(DATA_DIR, 'avatars');
export const IMAGES_DIR = join(DATA_DIR, 'images');
const DB_PATH = process.env.DB_PATH ?? join(DATA_DIR, 'minitavern.db');

// SQLite holds plaintext chats and credentials; keep future WAL/SHM sidecars private too.
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
// WAL + NORMAL reduces fsyncs during streaming; a crash may lose recent commits,
// but does not corrupt the database.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
for (const sidecar of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try {
    chmodSync(sidecar, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
// Auto-checkpointing bounds the WAL; reclaim its high-water allocation after write bursts.
db.exec('PRAGMA journal_size_limit = 67108864');

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

// Generations don't survive a restart: finalize any rows a previous process left streaming.
// Speculative placeholders are disposable; do not expose them as broken swipe choices.
stmt("DELETE FROM messages WHERE status = 'streaming' AND generation_kind = 'speculative'").run();
stmt(
  `UPDATE messages SET status = 'error',
   gen_meta_json = json_object('error', 'Server restarted during generation') WHERE status = 'streaming'`,
).run();
// Image renders don't survive a restart either: clear stale pending flags.
stmt('UPDATE messages SET image_pending = 0 WHERE image_pending = 1').run();

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

function parseCustomTemplate(raw: string | null): CustomTemplate | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CustomTemplate>;
    return {
      content: typeof parsed.content === 'string' ? parsed.content : '',
      userPrologue: typeof parsed.userPrologue === 'string' ? parsed.userPrologue : '',
      reasoningPrefill: typeof parsed.reasoningPrefill === 'string' ? parsed.reasoningPrefill : '',
      messagePrefill: typeof parsed.messagePrefill === 'string' ? parsed.messagePrefill : '',
      prefixNames: parsed.prefixNames === true,
      usesPersonas: parsed.usesPersonas !== false,
      // Old blobs predate this key; empty resolves to DEFAULT_STEER_TEMPLATE.
      steerTemplate: typeof parsed.steerTemplate === 'string' ? parsed.steerTemplate : '',
    };
  } catch {
    // Tolerate pre-JSON dev builds that stored the raw template text.
    return {
      content: raw,
      userPrologue: '',
      reasoningPrefill: '',
      messagePrefill: '',
      prefixNames: false,
      usesPersonas: true,
      steerTemplate: '',
    };
  }
}

export function toMessage(r: Row): Message {
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
    images: r.images_json ? (JSON.parse(r.images_json as string) as string[]) : [],
    activeImage: (r.active_image as number) ?? 0,
    imagePending: (r.image_pending as number) === 1,
    hasImageRender: r.image_render_json != null,
    createdAt: r.created_at as number,
  };
}

export function toGalleryItem(r: Row): GalleryItem {
  return {
    id: r.id as number,
    characterId: (r.character_id as number | null) ?? null,
    characterName: (r.current_character_name as string | null) ?? (r.character_name as string),
    sourceConversationId: (r.source_conversation_id as number | null) ?? null,
    sourceMessageId: (r.source_message_id as number | null) ?? null,
    sourceImage: (r.source_image as string | null) ?? null,
    prompt: r.prompt as string,
    image: r.image as string,
    hasImageRender: r.image_render_json != null,
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
    name: r.name as string,
    content: r.content as string,
    createdAt: r.created_at as number,
  };
}

export function toTemplate(r: Row): Template {
  return {
    id: r.id as number,
    name: r.name as string,
    content: r.content as string,
    userPrologue: r.user_prologue as string,
    reasoningPrefill: r.reasoning_prefill as string,
    messagePrefill: r.message_prefill as string,
    prefixNames: (r.prefix_names as number) !== 0,
    usesPersonas: (r.uses_personas as number) !== 0,
    steerTemplate: r.steer_template as string,
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
