import { migrateReviewPrompts } from './mediaPromptSeed.ts';
import { MEDIA_LIBRARY_VERSION_SCHEMA } from './mediaLibraryVersions.ts';
import { Database, type Statement, type SQLQueryBindings } from 'bun:sqlite';

type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;
type PreparedStatement = Statement<SqlRow, SQLQueryBindings[]>;
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ATTACHMENT_SCHEMA } from './attachmentSchema.ts';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';
import { MEDIA_ENTITY_SCHEMA, MEDIA_REFERENCE_INDEXES } from './mediaEntitySchema.ts';
import { scalarSettings, importMediaLibraries } from '../settings/mediaEntities.ts';
import { migrateMediaEntities } from './mediaEntityMigration.ts';
import type {
  Character,
  EntityFolder,
  Conversation,
  CustomTemplate,
  Endpoint,
  GalleryItem,
  Message,
  MediaAsset,
  Persona,
  Preset,
  Template,
} from '@tinytavern/shared';
import {
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_STEER_TEMPLATE,
  DEFAULT_SPEAKER_HANDOFF_TEMPLATE,
  DEFAULT_SETTINGS,
  settingsPreferences,
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

export const db = new Database(DB_PATH, { strict: true });
chmodSync(DB_PATH, 0o600);
db.exec('PRAGMA foreign_keys = ON');
// The online backup opens a separate connection; allow its short read locks to finish.
db.exec('PRAGMA busy_timeout = 5000');
// Streams stay in memory until they end. SQLite handles conversion of existing WAL databases;
// EXTRA also syncs the directory after deleting the rollback journal at commit.
db.exec('PRAGMA journal_mode = DELETE');
db.exec('PRAGMA synchronous = EXTRA');

// Query strings form a bounded set, so this cache needs no eviction.
const stmtCache = new Map<string, PreparedStatement>();
export function stmt(sql: string): PreparedStatement {
  let prepared = stmtCache.get(sql);
  if (!prepared) {
    prepared = db.prepare<SqlRow, SQLQueryBindings[]>(sql);
    stmtCache.set(sql, prepared);
  }
  return prepared;
}

// Existing databases must already meet the minimum supported schema version.
// Never renumber this baseline or silently open an older/newer schema.
const BASELINE_VERSION = 81;
let version = Number(stmt('PRAGMA user_version').get()!.user_version);
if (version !== 0 && (version < BASELINE_VERSION || version > SCHEMA_VERSION)) {
  throw new Error(
    `Unsupported database schema ${version}; this build supports ${BASELINE_VERSION}–${SCHEMA_VERSION}. ` +
      'Older databases must be upgraded with a compatible build first.',
  );
}

if (version === 0) {
  transaction(() => {
    db.exec(SCHEMA_SQL);
    const now = Date.now();
    const presetId = Number(
      stmt('INSERT INTO presets (name, content, builtin, created_at) VALUES (?, ?, 1, ?)').run(
        'Default assistant',
        DEFAULT_SYSTEM_PROMPT,
        now,
      ).lastInsertRowid,
    );
    const templateId = Number(
      stmt(`INSERT INTO templates
        (name, content, steer_template, speaker_handoff_template, builtin, created_at)
        VALUES (?, ?, ?, ?, 1, ?)`).run(
        'Default',
        DEFAULT_PROMPT_TEMPLATE,
        DEFAULT_STEER_TEMPLATE,
        DEFAULT_SPEAKER_HANDOFF_TEMPLATE,
        now,
      ).lastInsertRowid,
    );
    stmt('INSERT INTO characters (name, created_at) VALUES (?, ?)').run('Assistant', now);
    const settings = structuredClone({
      ...DEFAULT_SETTINGS,
      defaultPresetId: presetId,
      defaultTemplateId: templateId,
    });
    importMediaLibraries(settings);
    stmt("INSERT INTO settings (key, value) VALUES ('app', ?)").run(scalarSettings(settingsPreferences(settings)));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
  version = SCHEMA_VERSION;
}

// Also update schema.ts and fresh seeds above when adding a migration.
function migrate(target: number, apply: () => void): void {
  if (version >= target) return;
  transaction(() => {
    apply();
    db.exec(`PRAGMA user_version = ${target}`);
  });
  version = target;
}
// Register future upgrades here with migrate(nextVersion, apply).
migrate(82, () => {
  const uploaded = `character_name = 'Uploads'
    AND source_conversation_id IS NULL AND source_message_id IS NULL AND source_image IS NULL
    AND EXISTS (SELECT 1 FROM media_assets a WHERE a.path = gallery_items.image
      AND a.recipe_id IS NULL AND NOT EXISTS (SELECT 1 FROM media_characters mc WHERE mc.asset_id = a.id))`;
  stmt(`INSERT INTO gallery_folders(name, created_at)
    SELECT 'Uploads', ? WHERE EXISTS (SELECT 1 FROM gallery_items WHERE ${uploaded} AND folder_id IS NULL)
    ON CONFLICT(name) DO NOTHING`).run(Date.now());
  stmt(`UPDATE gallery_items SET character_name = '',
    folder_id = COALESCE(folder_id, (SELECT id FROM gallery_folders WHERE name = 'Uploads'))
    WHERE ${uploaded}`).run();
});

migrate(83, () => {
  stmt(`UPDATE gallery_items SET character_name = ''
    WHERE character_name IN ('Uploads', 'Media tools') AND NOT EXISTS (
      SELECT 1 FROM media_assets a JOIN media_characters mc ON mc.asset_id = a.id
      WHERE a.path = gallery_items.image
    )`).run();
});

migrate(84, () => {
  db.exec(`ALTER TABLE conversations ADD COLUMN prompt_context_json TEXT;
    ALTER TABLE media_drafts ADD COLUMN conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL;
    ALTER TABLE media_jobs ADD COLUMN prompt_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
    CREATE UNIQUE INDEX media_drafts_conversation ON media_drafts(conversation_id) WHERE conversation_id IS NOT NULL;
    CREATE INDEX media_jobs_prompt_message ON media_jobs(prompt_message_id) WHERE prompt_message_id IS NOT NULL;`);
});

migrate(85, () => {
  db.exec(MEDIA_ENTITY_SCHEMA);
  db.exec('ALTER TABLE media_recipes ADD COLUMN workflow_id INTEGER REFERENCES media_workflows(id)');
  migrateMediaEntities();
  db.exec(MEDIA_REFERENCE_INDEXES);
});

migrate(86, () => {
  db.exec('DROP TRIGGER media_message_insert');
  db.exec('DROP TRIGGER media_message_update');
  db.exec('DROP TRIGGER media_gallery_insert');
  db.exec('DROP TRIGGER media_gallery_update');
  db.exec('DROP TRIGGER media_message_reference_insert');
  db.exec('DROP TRIGGER media_message_reference_update');
  db.exec('DROP TRIGGER media_message_reference_delete');
  db.exec('DROP TRIGGER media_gallery_reference_insert');
  db.exec('DROP TRIGGER media_gallery_reference_update');
  db.exec('DROP TRIGGER media_gallery_input_delete');
  db.exec(`DROP INDEX idx_gallery_image;
    DROP VIEW message_media_files;
    ALTER TABLE messages DROP COLUMN images_json;
    ALTER TABLE gallery_items DROP COLUMN image;
    ALTER TABLE gallery_items DROP COLUMN image_width;
    ALTER TABLE gallery_items DROP COLUMN image_height;`);
  db.exec(ATTACHMENT_SCHEMA);
});

migrate(87, () => {
  db.exec(MEDIA_LIBRARY_VERSION_SCHEMA);
  migrateReviewPrompts();
});

migrate(88, () => {
  // Version 87 only linked the first saved prompt in each draft.
  migrateReviewPrompts();
  // Version 87 moved interrupted review preparation to ready without releasing deleted inputs.
  // Keep pins for active work; the normal startup sweep removes files whose final pin is released.
  stmt(`DELETE FROM media_owners WHERE owner_type = 'job' AND slot LIKE 'input:%'
    AND EXISTS (SELECT 1 FROM media_assets WHERE id = media_owners.asset_id AND reference_deleted = 1)
    AND EXISTS (SELECT 1 FROM media_jobs WHERE id = media_owners.owner_id
      AND state IN ('draft', 'ready', 'succeeded', 'failed', 'cancelled'))`).run();
});

// Text generations cannot resume after a restart; submitted media jobs recover separately.
// Speculative placeholders are disposable; do not expose them as broken swipe choices.
deleteMessageSubtrees(
  stmt("SELECT id FROM messages WHERE status = 'streaming' AND generation_kind = 'speculative'")
    .all()
    .map((row) => Number(row.id)),
);
stmt(
  `UPDATE messages SET status = 'error',
   gen_meta_json = json_object('error', 'Server restarted during generation') WHERE status = 'streaming'
   AND NOT EXISTS (SELECT 1 FROM media_jobs j WHERE j.message_id = messages.id
     AND j.state NOT IN ('succeeded', 'failed', 'cancelled', 'draft'))`,
).run();
// Preserve pending attachments owned by recoverable media jobs; clear abandoned pending flags.
stmt(`UPDATE messages SET image_pending = 0 WHERE image_pending = 1
  AND NOT EXISTS (SELECT 1 FROM media_jobs j WHERE j.message_id = messages.id
    AND j.state NOT IN ('succeeded', 'failed', 'cancelled', 'draft', 'ready'))`).run();

/**
 * Only the outermost call opens/commits; there are no savepoints.
 * Inner failures roll back only if propagated; catching them commits the inner writes.
 */
export function transaction<T>(fn: () => T): T {
  if (db.inTransaction) return fn();
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

/** Freeze the doomed set before detaching its edges, avoiding SQLite's cascade-depth limit.
 * Callers collect media first and repair navigation before the outer transaction commits. */
export function deleteMessageSubtrees(rootIds: readonly number[]): number {
  if (!rootIds.length) return 0;
  return transaction(() => {
    const rows = stmt(`WITH RECURSIVE doomed(id) AS (
      SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?))
      UNION
      SELECT m.id FROM messages m JOIN doomed d ON m.parent_id = d.id
    ) SELECT id FROM doomed`).all(JSON.stringify(rootIds));
    if (!rows.length) return 0;
    const ids = JSON.stringify(rows.map((row) => Number(row.id)));
    // A single message has no descendants to cascade through.
    if (rows.length > 1) {
      stmt(`UPDATE messages SET parent_id = NULL, active_child_id = NULL
        WHERE id IN (SELECT value FROM json_each(?))
          AND (parent_id IS NOT NULL OR active_child_id IS NOT NULL)`).run(ids);
    }
    return Number(stmt('DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))').run(ids).changes);
  });
}

/** Conversation membership already defines the full doomed set; no recursive traversal needed. */
export function deleteConversationRows(ids: readonly number[]): number {
  if (!ids.length) return 0;
  return transaction(() => {
    const encoded = JSON.stringify(ids);
    stmt(`UPDATE messages SET parent_id = NULL, active_child_id = NULL
      WHERE conversation_id IN (SELECT value FROM json_each(?))
        AND (parent_id IS NOT NULL OR active_child_id IS NOT NULL)`).run(encoded);
    return Number(stmt('DELETE FROM conversations WHERE id IN (SELECT value FROM json_each(?))').run(encoded).changes);
  });
}

type Row = Record<string, unknown>;

const assetCache = new Map<string, MediaAsset>();
const assetsById = new Map<number, MediaAsset>();
const assetObservers = new Set<() => void>();
export function observeMediaAssets(observer: () => void): () => void {
  assetObservers.add(observer);
  return () => {
    assetObservers.delete(observer);
  };
}
export function invalidateMediaAsset(path: string): void {
  const asset = assetCache.get(path);
  if (asset) assetsById.delete(asset.id);
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
    recipeId: row.recipe_id as number | null,
  };
}

function cacheMediaAsset(row: Row): MediaAsset {
  const asset = toMediaAsset(row);
  if (assetCache.size >= 16384) {
    const oldest = assetCache.values().next().value!;
    assetCache.delete(oldest.url);
    assetsById.delete(oldest.id);
  }
  assetCache.set(asset.url, asset);
  assetsById.set(asset.id, asset);
  return asset;
}

export function mediaAssetForPath(path: string): MediaAsset | undefined {
  const cached = assetCache.get(path);
  if (cached) return cached;
  const row = stmt('SELECT * FROM media_assets WHERE path = ?').get(path);
  return row ? cacheMediaAsset(row) : undefined;
}

function parseCustomTemplate(raw: string | null): CustomTemplate | null {
  if (!raw) return null;
  return JSON.parse(raw) as CustomTemplate;
}

/** Fetch metadata only for cache misses; associations remain authoritative on every read. */
function attachmentMedia(attachments: Row[]): Map<number, MediaAsset[]> {
  const assets = new Map<number, MediaAsset>();
  const missing = new Set<number>();
  for (const attachment of attachments) {
    const assetId = Number(attachment.asset_id);
    const cached = assetsById.get(assetId);
    if (cached) {
      assets.set(assetId, cached);
    } else {
      missing.add(assetId);
    }
  }
  if (missing.size) {
    const rows = stmt('SELECT * FROM media_assets WHERE id IN (SELECT value FROM json_each(?))').all(
      JSON.stringify([...missing]),
    );
    for (const row of rows) {
      const asset = cacheMediaAsset(row);
      assets.set(asset.id, asset);
    }
  }
  const media = new Map<number, MediaAsset[]>();
  for (const attachment of attachments) {
    const asset = assets.get(Number(attachment.asset_id));
    if (!asset) continue;
    const messageId = Number(attachment.owner_id);
    let list = media.get(messageId);
    if (!list) {
      list = [];
      media.set(messageId, list);
    }
    list.push(asset);
  }
  return media;
}

export function messageMedia(messageId: number): MediaAsset[] {
  const attachments = stmt(`SELECT owner_id, asset_id FROM media_owners
    WHERE owner_type = 'message' AND owner_id = ? ORDER BY CAST(slot AS INTEGER)`).all(messageId);
  return attachmentMedia(attachments).get(messageId) ?? [];
}

/** One association query for a whole tree or path, including messages with no attachments. */
export function toMessages(rows: Row[]): Message[] {
  if (rows.length === 0) return [];
  const ids = JSON.stringify(rows.map((row) => row.id));
  const attachments = stmt(`SELECT owner_id, asset_id FROM media_owners
    WHERE owner_type = 'message' AND owner_id IN (SELECT value FROM json_each(?))
    ORDER BY owner_id, CAST(slot AS INTEGER)`).all(ids);
  const media = attachmentMedia(attachments);
  return rows.map((row) => toMessage(row, media.get(Number(row.id)) ?? []));
}

export function toMessage(r: Row, media = messageMedia(Number(r.id))): Message {
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
    media,
    activeImage: (r.active_image as number) ?? 0,
    imagePending: (r.image_pending as number) === 1,
    hasImageRender: r.render_recipe_id != null,
    createdAt: r.created_at as number,
  };
}

export function toGalleryItem(r: Row): GalleryItem {
  const characters = JSON.parse(String(r.characters_json)) as GalleryItem['characters'];
  return {
    workflowId: (r.workflow_id as string | null) ?? null,
    workflowName: (r.workflow_name as string | null) ?? null,
    id: r.id as number,
    folderId: (r.folder_id as number | null) ?? null,
    characters,
    characterName: characters.map((character) => character.name).join(', ') || String(r.character_name),
    sourceConversationId: (r.source_conversation_id as number | null) ?? null,
    sourceMessageId: (r.source_message_id as number | null) ?? null,
    sourceImage: (r.source_image as string | null) ?? null,
    prompt: r.prompt as string,
    media: toMediaAsset({ ...r, id: r.asset_id }),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function toConversation(r: Row): Conversation {
  return {
    promptMode: r.prompt_context_json ? 'media' : 'chat',
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

export function toEntityFolder(r: Row): EntityFolder {
  return {
    id: r.id as number,
    name: r.name as string,
    createdAt: r.created_at as number,
  };
}

export function toPreset(r: Row): Preset {
  return {
    id: r.id as number,
    folderId: (r.folder_id as number | null) ?? null,
    readOnly: r.builtin === 1,
    name: r.name as string,
    content: r.content as string,
    createdAt: r.created_at as number,
  };
}

export function toTemplate(r: Row): Template {
  return {
    id: r.id as number,
    folderId: (r.folder_id as number | null) ?? null,
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
    folderId: (r.folder_id as number | null) ?? null,
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
    folderId: (r.folder_id as number | null) ?? null,
    name: r.name as string,
    baseUrl: r.base_url as string,
    apiKey,
    hasApiKey: apiKey.length > 0,
    models: JSON.parse(r.models_json as string),
    model: r.model as string | null,
    genParams: JSON.parse(r.gen_params_json as string),
    systemPromptPrefix: r.system_prompt_prefix as string,
    systemPromptSuffix: r.system_prompt_suffix as string,
    reasoningPrefillPrefix: r.reasoning_prefill_prefix as string,
    allowReasoningPrefill: r.allow_reasoning_prefill === 1,
    allowMessagePrefill: r.allow_message_prefill === 1,
    prefillMode: r.prefill_mode as Endpoint['prefillMode'],
    createdAt: r.created_at as number,
  };
}
