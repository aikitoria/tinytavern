import { settingsPreferences, DEFAULT_SETTINGS, type Settings } from '@tinytavern/shared';
import { db, stmt } from './db.ts';
import { SCHEMA_SQL } from './schema.ts';
import { scalarSettings, importMediaLibraries } from '../settings/mediaEntities.ts';

type IdMap = Map<string, string>;
type PromptTable = 'media_chat_prompts' | 'media_standalone_prompts';

function numericId(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function reserveIds(table: string, ids: Iterable<string>): void {
  let maximum = 0;
  for (const id of ids) maximum = Math.max(maximum, numericId(id) ?? 0);
  if (maximum === 0) return;
  const existing = stmt('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table);
  if (existing) {
    stmt('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?').run(maximum, table);
  } else {
    stmt('INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)').run(table, maximum);
  }
}

function archivedId(table: 'media_workflows' | PromptTable, oldId: string): string {
  const id = numericId(oldId);
  const result = stmt(`INSERT INTO ${table}(id, name, created_at, deleted_at) VALUES (?, 'Unavailable', 0, 0)`).run(id);
  return String(result.lastInsertRowid);
}

function migrateJobs(workflows: IdMap, chat: IdMap, standalone: IdMap): void {
  // There are no incoming job foreign keys. Temporarily remove triggers so SQLite does not
  // rewrite references in unrelated triggers to the temporary table name during the rebuild.
  const triggers = stmt("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all();
  const indexes = stmt(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media_jobs' AND sql IS NOT NULL",
  ).all();
  for (const trigger of triggers) {
    const name = String(trigger.name).replaceAll('"', '""');
    db.exec(`DROP TRIGGER "${name}"`);
  }
  db.exec('ALTER TABLE media_jobs RENAME TO old_media_jobs');
  const definition = SCHEMA_SQL.match(/CREATE TABLE media_jobs \([\s\S]*?\n\);/);
  if (!definition) throw new Error('Missing media_jobs schema');
  db.exec(definition[0]);
  // table_info excludes the generated legacy preset_id projection.
  const columns = stmt('PRAGMA table_info(media_jobs)')
    .all()
    .map((row) => String(row.name));
  const placeholders = columns.map(() => '?').join(', ');
  const insert = stmt(`INSERT INTO media_jobs (${columns.join(', ')}) VALUES (${placeholders})`);
  for (const row of stmt('SELECT * FROM old_media_jobs').iterate()) {
    if (row.preset_id != null) {
      const isChat = row.context_conversation_id != null;
      const ids = isChat ? chat : standalone;
      const table = isChat ? 'media_chat_prompts' : 'media_standalone_prompts';
      const oldId = String(row.preset_id);
      if (!ids.has(oldId)) ids.set(oldId, archivedId(table, oldId));
      row.chat_preset_id = isChat ? Number(ids.get(oldId)) : null;
      row.standalone_preset_id = isChat ? null : Number(ids.get(oldId));
    }
    const config = row.configuration_json ? JSON.parse(String(row.configuration_json)) : null;
    if (config?.workflowId != null) config.workflowId = workflows.get(String(config.workflowId));
    row.workflow_id = row.workflow_id == null ? null : Number(workflows.get(String(row.workflow_id)));
    row.configuration_json = config ? JSON.stringify(config) : null;
    insert.run(...columns.map((column) => row[column] ?? null));
  }
  const oldSequence = stmt("SELECT seq FROM sqlite_sequence WHERE name = 'old_media_jobs'").get();
  if (oldSequence) reserveIds('media_jobs', [String(oldSequence.seq)]);
  db.exec('DROP TABLE old_media_jobs');
  for (const index of indexes) db.exec(String(index.sql));
  for (const trigger of triggers) db.exec(String(trigger.sql));
}

/** Preserve known numeric IDs, including references to deleted entities, before allocating IDs. */
export function migrateMediaEntities(): void {
  const saved = stmt("SELECT value FROM settings WHERE key = 'app'").get();
  const stored = saved ? JSON.parse(String(saved.value)) : {};
  const settings = { ...DEFAULT_SETTINGS, ...stored } as Settings;
  settings.mediaRendering = { ...DEFAULT_SETTINGS.mediaRendering, ...stored.mediaRendering };
  const workflowRefs = stmt(`SELECT workflow_id AS id FROM media_jobs WHERE workflow_id IS NOT NULL
    UNION SELECT json_extract(configuration_json, '$.workflowId') FROM media_recipes
    UNION SELECT json_extract(configuration_json, '$.workflowId') FROM media_jobs WHERE configuration_json IS NOT NULL`)
    .all()
    .filter((row) => row.id != null)
    .map((row) => String(row.id));
  const chatRefs = stmt(
    'SELECT DISTINCT preset_id AS id FROM media_jobs WHERE context_conversation_id IS NOT NULL AND preset_id IS NOT NULL',
  )
    .all()
    .map((row) => String(row.id));
  const standaloneRefs = stmt(
    'SELECT DISTINCT preset_id AS id FROM media_jobs WHERE context_conversation_id IS NULL AND preset_id IS NOT NULL',
  )
    .all()
    .map((row) => String(row.id));
  const collections = [
    ['media_workflows', settings.mediaRendering.workflows, workflowRefs],
    ['media_workflow_folders', settings.mediaRendering.folders, []],
    ['media_chat_prompts', settings.mediaChatPrompts.presets, chatRefs],
    ['media_chat_prompts_folders', settings.mediaChatPrompts.folders, []],
    ['media_standalone_prompts', settings.mediaStandalonePrompts.presets, standaloneRefs],
    ['media_standalone_prompts_folders', settings.mediaStandalonePrompts.folders, []],
    ['media_shortcuts', settings.mediaRendering.shortcuts, []],
    ['media_favorites', settings.mediaFavorites, []],
    ['avatar_prompts', settings.imageGeneration.promptPresets?.avatar?.presets ?? [], []],
  ] as const;
  for (const [table, items, references] of collections) {
    reserveIds(table, [...items.map((item) => item.id ?? ''), ...references]);
  }
  // The pre-85 settings document stored membership on folders, not entity rows.
  for (const [items, folders, member] of [
    [settings.mediaRendering.workflows, settings.mediaRendering.folders, 'workflowIds'],
    [settings.mediaChatPrompts.presets, settings.mediaChatPrompts.folders, 'presetIds'],
    [settings.mediaStandalonePrompts.presets, settings.mediaStandalonePrompts.folders, 'presetIds'],
  ] as const) {
    const membership = new Map<string, string>();
    for (const folder of folders) {
      const ids = (folder as unknown as Record<string, string[]>)[member] ?? [];
      for (const id of ids) membership.set(id, folder.id);
    }
    for (const item of items) item.folderId = membership.get(item.id) ?? null;
  }
  const chatBefore = settings.mediaChatPrompts.presets.map((item) => item.id);
  const standaloneBefore = settings.mediaStandalonePrompts.presets.map((item) => item.id);
  const workflows = importMediaLibraries(settings, true);
  for (const oldId of workflowRefs) {
    if (!workflows.has(oldId)) workflows.set(oldId, archivedId('media_workflows', oldId));
  }
  const chat = new Map(chatBefore.map((id, index) => [id, settings.mediaChatPrompts.presets[index]!.id]));
  const standalone = new Map(
    standaloneBefore.map((id, index) => [id, settings.mediaStandalonePrompts.presets[index]!.id]),
  );
  migrateJobs(workflows, chat, standalone);
  for (const row of stmt('SELECT id, configuration_json FROM media_recipes').iterate()) {
    const config = JSON.parse(String(row.configuration_json));
    config.workflowId = workflows.get(String(config.workflowId)) ?? null;
    stmt('UPDATE media_recipes SET workflow_id = ?, configuration_json = ? WHERE id = ?').run(
      config.workflowId,
      JSON.stringify(config),
      row.id!,
    );
  }
  stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(scalarSettings(settingsPreferences(settings)));
}
