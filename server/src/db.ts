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

// Chats and endpoint credentials are plaintext in SQLite. Keep both newly
// created files and SQLite's later-created WAL/SHM sidecars private, regardless
// of the host/container's inherited umask.
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
// WAL avoids a full journal cycle (two fsyncs) per write — this matters for
// the periodic streaming flushes. NORMAL is durable enough under WAL: a crash
// can only lose the last transactions, never corrupt the database.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
for (const sidecar of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try {
    chmodSync(sidecar, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
// Auto-checkpointing (default: every ~4MB) keeps the WAL bounded; this only
// truncates the file back after a large write burst instead of leaving it at
// its high-water mark.
db.exec('PRAGMA journal_size_limit = 67108864');

/** Memoized prepare: every query in the codebase is one of a bounded set of SQL strings. */
const stmtCache = new Map<string, StatementSync>();
export function stmt(sql: string): StatementSync {
  let prepared = stmtCache.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    stmtCache.set(sql, prepared);
  }
  return prepared;
}

// Schema migrations (DDL + seeds only). Settings that move between scopes are
// not carried over — they reset to defaults and get re-picked in the UI.
const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
  user_version: number;
};

if (version < 1) {
  db.exec(`
    BEGIN;
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
  db.prepare('INSERT INTO presets (name, content, created_at) VALUES (?, ?, ?)').run(
    'Default assistant',
    'You are {{char}}, a helpful assistant talking to {{user}}. Answer accurately and concisely.',
    Date.now(),
  );
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    'app',
    JSON.stringify({ ...DEFAULT_SETTINGS, defaultPresetId: 1, defaultTemplateId: 1 }),
  );
  db.exec('PRAGMA user_version = 1; COMMIT;');
}

if (version < 2) {
  db.exec(`
    BEGIN;
    CREATE TABLE templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare('INSERT INTO templates (name, content, created_at) VALUES (?, ?, ?)').run(
    'Default',
    DEFAULT_PROMPT_TEMPLATE,
    Date.now(),
  );
  db.exec('PRAGMA user_version = 2; COMMIT;');
}

if (version < 3) {
  db.exec(`
    BEGIN;
    ALTER TABLE templates ADD COLUMN user_prologue TEXT NOT NULL DEFAULT '';
    ALTER TABLE characters ADD COLUMN template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL;
    PRAGMA user_version = 3;
    COMMIT;
  `);
}

if (version < 4) {
  db.exec(`
    BEGIN;
    ALTER TABLE conversations ADD COLUMN speaker_name TEXT;
    ALTER TABLE messages ADD COLUMN name TEXT;
    ALTER TABLE templates ADD COLUMN prefix_names INTEGER NOT NULL DEFAULT 0;
    PRAGMA user_version = 4;
    COMMIT;
  `);
}

if (version < 5) {
  db.exec(`
    BEGIN;
    ALTER TABLE endpoints ADD COLUMN gen_params_json TEXT NOT NULL DEFAULT '{}';
    PRAGMA user_version = 5;
    COMMIT;
  `);
}

if (version < 6) {
  db.exec(`
    BEGIN;
    ALTER TABLE endpoints ADD COLUMN model TEXT;
    PRAGMA user_version = 6;
    COMMIT;
  `);
}

if (version < 7) {
  db.exec(`
    BEGIN;
    ALTER TABLE endpoints ADD COLUMN prefill_mode TEXT NOT NULL DEFAULT 'none';
    PRAGMA user_version = 7;
    COMMIT;
  `);
}

if (version < 8) {
  db.exec(`
    BEGIN;
    ALTER TABLE messages ADD COLUMN generation_kind TEXT NOT NULL DEFAULT 'normal';
    PRAGMA user_version = 8;
    COMMIT;
  `);
}

// model/gen_params_json were superseded by endpoint-owned settings and never read.
// endpoint_id stays: it becomes the per-conversation endpoint override.
if (version < 9) {
  db.exec(`
    BEGIN;
    ALTER TABLE conversations DROP COLUMN model;
    ALTER TABLE conversations DROP COLUMN gen_params_json;
    PRAGMA user_version = 9;
    COMMIT;
  `);
}

// Full-text search over message contents (external-content FTS5, kept in sync
// by triggers so the message body is stored only once).
if (version < 10) {
  db.exec(`
    BEGIN;
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
    PRAGMA user_version = 10;
    COMMIT;
  `);
}

// The bare assistant becomes an editable character: new chats pick it from the
// character list, and its preset/template overrides apply like any character's.
// Multiple assistants are simply more characters.
if (version < 11) {
  db.exec('BEGIN');
  db.prepare(
    `INSERT INTO characters (name, personality, scenario, first_message, created_at)
     VALUES ('Assistant', '', '', '', ?)`,
  ).run(Date.now());
  db.exec('PRAGMA user_version = 11');
  db.exec('COMMIT');
}

// Inline template override on characters, parallel to custom_prompt: replaces
// the template content (no prologue or name prefixing in custom mode).
if (version < 12) {
  db.exec(`
    BEGIN;
    ALTER TABLE characters ADD COLUMN custom_template TEXT;
    PRAGMA user_version = 12;
    COMMIT;
  `);
}

// Templates can opt a chat out of the persona feature entirely.
if (version < 13) {
  db.exec(`
    BEGIN;
    ALTER TABLE templates ADD COLUMN uses_personas INTEGER NOT NULL DEFAULT 1;
    PRAGMA user_version = 13;
    COMMIT;
  `);
}

// Generated image attached to a message (plugin tool output): NULL, the
// 'pending' placeholder while rendering, or a served /images/ path.
if (version < 14) {
  db.exec(`
    BEGIN;
    ALTER TABLE messages ADD COLUMN image TEXT;
    PRAGMA user_version = 14;
    COMMIT;
  `);
}

// Image swipes: a message carries a list of generated images plus the stored
// render config so alternatives can be re-rendered with a fresh seed.
if (version < 15) {
  db.exec(`
    BEGIN;
    ALTER TABLE messages ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE messages ADD COLUMN active_image INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN image_pending INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN image_render_json TEXT;
    UPDATE messages SET images_json = json_array(image) WHERE image IS NOT NULL AND image <> 'pending';
    ALTER TABLE messages DROP COLUMN image;
    PRAGMA user_version = 15;
    COMMIT;
  `);
}

// Steer format moves from a global setting to a per-template field, resolved
// through the same chain as the template itself. Existing rows keep the empty
// default, which resolves to DEFAULT_STEER_TEMPLATE (same text as before).
if (version < 16) {
  db.exec(`
    BEGIN;
    ALTER TABLE templates ADD COLUMN steer_template TEXT NOT NULL DEFAULT '';
    PRAGMA user_version = 16;
    COMMIT;
  `);
}

// Example conversation partials on characters (SillyTavern mes_example),
// substituted into templates via the {{examples}} slot.
if (version < 17) {
  db.exec(`
    BEGIN;
    ALTER TABLE characters ADD COLUMN examples TEXT NOT NULL DEFAULT '';
    PRAGMA user_version = 17;
    COMMIT;
  `);
}

// Optimistic conversation concurrency and generation ABA protection.
if (version < 18) {
  db.exec(`
    BEGIN;
    ALTER TABLE conversations ADD COLUMN mutation_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN generation_token INTEGER;
    PRAGMA user_version = 18;
    COMMIT;
  `);
}

// One-level character folders. A character can belong to one folder; deleting
// the folder returns its characters to the root of the picker tree.
if (version < 19) {
  db.exec(`
    BEGIN;
    CREATE TABLE character_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at INTEGER NOT NULL
    );
    ALTER TABLE characters ADD COLUMN folder_id INTEGER
      REFERENCES character_folders(id) ON DELETE SET NULL;
    PRAGMA user_version = 19;
    COMMIT;
  `);
}

// Login sessions survive ordinary process/container restarts. Only a SHA-256
// digest of the opaque cookie token is stored; changing/removing the password
// clears this table through auth.ts.
if (version < 20) {
  db.exec(`
    BEGIN;
    CREATE TABLE auth_sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
    PRAGMA user_version = 20;
    COMMIT;
  `);
}

// Templates can seed both parts of a reasoning-model assistant turn. Keeping
// them separate maps directly onto OpenAI-compatible content/reasoning_content.
if (version < 21) {
  db.exec(`
    BEGIN;
    ALTER TABLE templates ADD COLUMN reasoning_prefill TEXT NOT NULL DEFAULT '';
    ALTER TABLE templates ADD COLUMN message_prefill TEXT NOT NULL DEFAULT '';
    PRAGMA user_version = 21;
    COMMIT;
  `);
}

// Generations don't survive a restart: finalize any rows a previous process left streaming.
// Speculative placeholders are disposable; do not expose them as broken swipe choices.
db.prepare(
  "DELETE FROM messages WHERE status = 'streaming' AND generation_kind = 'speculative'",
).run();
db.prepare(
  `UPDATE messages SET status = 'error',
   gen_meta_json = json_object('error', 'Server restarted during generation') WHERE status = 'streaming'`,
).run();
// Image renders don't survive a restart either: clear stale pending flags.
db.prepare('UPDATE messages SET image_pending = 0 WHERE image_pending = 1').run();

let txDepth = 0;

/**
 * Nestable: only the outermost call opens/commits; an inner throw rolls back everything.
 * There are NO savepoint semantics: an inner transaction that throws is only
 * rolled back if the outer caller lets the exception propagate — catching it
 * inside the outer transaction keeps the inner writes and commits them.
 */
export function transaction<T>(fn: () => T): T {
  if (txDepth > 0) {
    txDepth++;
    try {
      return fn();
    } finally {
      txDepth--;
    }
  }
  txDepth = 1;
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth = 0;
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

export function toConversation(r: Row): Conversation {
  return {
    id: r.id as number,
    title: r.title as string,
    characterId: r.character_id as number | null,
    personaId: r.persona_id as number | null,
    endpointId: r.endpoint_id as number | null,
    speakerName: r.speaker_name as string | null,
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
