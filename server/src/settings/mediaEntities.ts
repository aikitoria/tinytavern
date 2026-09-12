import type { Settings, SettingsPreferences } from '@tinytavern/shared';
import { stmt } from '../db/db.ts';
import { HttpError } from '../http/router.ts';
import { createEntityWriter } from '../routes/shared/entityWriter.ts';

type Row = Record<string, unknown>;
type Item = { id: string; name: string; [key: string]: unknown };
export const MEDIA_ENTITIES = {
  media_workflows: {
    folder: 'media_workflow_folders',
    fields: {
      name: 'name',
      json: 'json',
      inputBindings: 'input_bindings_json',
      standalonePromptPresetId: 'standalone_prompt_preset_id',
      chatPromptPresetId: 'chat_prompt_preset_id',
      textOutputNodeId: 'text_output_node_id',
    },
  },
  media_chat_prompts: {
    folder: 'media_chat_prompts_folders',
    fields: { name: 'name', chatPrompt: 'chat_prompt' },
  },
  media_standalone_prompts: {
    folder: 'media_standalone_prompts_folders',
    fields: {
      name: 'name',
      systemPrompt: 'system_prompt',
      userMessage: 'user_message',
      reasoningPrefill: 'reasoning_prefill',
      messagePrefill: 'message_prefill',
    },
  },
  avatar_prompts: {
    folder: 'avatar_prompts_folders',
    fields: { name: 'name', prompt: 'prompt', context: 'context' },
  },
  media_shortcuts: {
    folder: null,
    fields: { name: 'name', workflowId: 'workflow_id', position: 'position' },
  },
  media_favorites: {
    folder: null,
    fields: {
      name: 'name',
      workflowId: 'workflow_id',
      presetId: 'preset_id',
      position: 'position',
    },
  },
} as const;
export type MediaEntityTable = keyof typeof MEDIA_ENTITIES;
export type MediaFolderTable = Exclude<(typeof MEDIA_ENTITIES)[MediaEntityTable]['folder'], null>;
function nullableId(value: unknown): string | null {
  return value == null ? null : String(value);
}

function decodeField(field: string, column: string, value: unknown): unknown {
  if (column.endsWith('_json')) return JSON.parse(String(value));
  if (field.endsWith('Id')) return nullableId(value);
  return value;
}

export function encodeMediaField(column: string, value: unknown): string | number | null {
  if (column.endsWith('_json')) return JSON.stringify(value ?? {});
  if (value == null) return null;
  const reference = column.endsWith('_id') && column !== 'text_output_node_id';
  if (reference || column === 'position') return Number(value);
  return String(value);
}

export function mediaEntityDto(table: MediaEntityTable, row: Row): Item {
  const value: Item = {
    id: String(row.id),
    name: String(row.name),
    revision: Number(row.revision),
  };
  for (const [field, column] of Object.entries(MEDIA_ENTITIES[table].fields)) {
    value[field] = decodeField(field, column, row[column]);
  }
  if (MEDIA_ENTITIES[table].folder) {
    value.folderId = nullableId(row.folder_id);
    value.revision = Number(row.revision);
  }
  return value;
}
export function mediaEntityRows(table: MediaEntityTable): Item[] {
  const hasFolders = MEDIA_ENTITIES[table].folder !== null;
  const condition = hasFolders ? ' WHERE deleted_at IS NULL' : '';
  const order = hasFolders ? 'name COLLATE NOCASE' : 'position';
  return stmt(`SELECT * FROM ${table}${condition} ORDER BY ${order}, id`)
    .all()
    .map((row) => mediaEntityDto(table, row));
}

export function insertMediaEntity(table: MediaEntityTable, item: Record<string, unknown>): string {
  const fields = Object.entries(MEDIA_ENTITIES[table].fields).map(([key, column]) => ({
    column,
    value: () => encodeMediaField(column, item[key]),
  }));
  const writer = createEntityWriter({ table, fields, toDto: (row) => ({ id: Number(row.id) }) });
  return String(writer.insert(writer.values({})));
}

function synchronizeRows(
  table: MediaEntityTable | MediaFolderTable,
  incoming: Item[],
  fieldMap: Record<string, string>,
  soft: boolean,
  migration: boolean,
): Map<string, string> {
  const now = Date.now();
  const previous = new Map(
    stmt(`SELECT * FROM ${table}${soft ? ' WHERE deleted_at IS NULL' : ''}`)
      .all()
      .map((row) => [String(row.id), row]),
  );
  const remap = new Map<string, string>();
  const columns = Object.values(fieldMap);
  const writer = createEntityWriter({
    table,
    toDto: (row) => ({ id: Number(row.id) }),
    revisionColumn: table in MEDIA_ENTITIES ? 'revision' : undefined,
    fields: columns.map((column) => ({ column, value: () => null })),
  });
  const retained = new Set(incoming.map((item) => item.id));
  for (const key of previous.keys()) {
    if (retained.has(key)) continue;
    if (soft) {
      stmt(`UPDATE ${table} SET deleted_at = ?, revision = revision + 1 WHERE id = ?`).run(now, key);
    } else {
      const entity = Object.entries(MEDIA_ENTITIES).find(([, config]) => config.folder === table)?.[0];
      if (entity) {
        stmt(`UPDATE ${entity} SET folder_id = NULL, revision = revision + 1 WHERE folder_id = ?`).run(key);
      }
      stmt(`DELETE FROM ${table} WHERE id = ?`).run(key);
    }
    previous.delete(key);
  }
  for (const item of incoming) {
    const requested = item.id;
    const current = previous.get(requested);
    const values = Object.entries(fieldMap).map(([key, column]) => encodeMediaField(column, item[key]));
    if (current) {
      const changed = columns.some((column, index) => current[column] !== values[index]);
      if (changed) {
        writer.update(Number(requested), values);
      }
      previous.delete(requested);
    } else {
      const explicit = migration && /^[1-9][0-9]*$/.test(requested) && Number.isSafeInteger(Number(requested));
      let insertedId: number;
      if (explicit) {
        const placeholders = columns.map(() => '?').join(', ');
        const inserted = stmt(
          `INSERT INTO ${table} (id, ${columns.join(', ')}, created_at) VALUES (?, ${placeholders}, ?)`,
        ).run(Number(requested), ...values, now);
        insertedId = Number(inserted.lastInsertRowid);
      } else {
        insertedId = writer.insert(values);
      }
      item.id = String(insertedId);
    }
    if (table in MEDIA_ENTITIES) {
      item.revision = Number(current?.revision ?? 0);
      if (current && columns.some((column, index) => current[column] !== values[index])) {
        item.revision = Number(item.revision) + 1;
      }
    }
    remap.set(requested, item.id);
  }
  return remap;
}

function synchronizeFolderCollection(
  table: MediaEntityTable,
  raw: unknown[],
  rawFolders: unknown[],
  migration: boolean,
): Map<string, string> {
  const items = raw as Item[];
  const groups = rawFolders as Item[];
  const config = MEDIA_ENTITIES[table];
  const folders = synchronizeRows(config.folder!, groups, { name: 'name' }, false, migration);
  for (const item of items) item.folderId = item.folderId == null ? null : (folders.get(String(item.folderId)) ?? null);
  const map = synchronizeRows(table, items, { ...config.fields, folderId: 'folder_id' }, true, migration);
  return map;
}

/** Server assignment treats incoming IDs of new rows as request-local references only. */
export function importMediaLibraries(settings: Settings, migration = false): Map<string, string> {
  const resolve = (map: Map<string, string>, key: string | null) => (key == null ? null : (map.get(key) ?? null));
  const chat = synchronizeFolderCollection(
    'media_chat_prompts',
    settings.mediaChatPrompts.presets,
    settings.mediaChatPrompts.folders,
    migration,
  );
  const standalone = synchronizeFolderCollection(
    'media_standalone_prompts',
    settings.mediaStandalonePrompts.presets,
    settings.mediaStandalonePrompts.folders,
    migration,
  );
  const rendering = settings.mediaRendering;
  for (const workflow of rendering.workflows) {
    workflow.chatPromptPresetId = resolve(chat, workflow.chatPromptPresetId);
    workflow.standalonePromptPresetId = resolve(standalone, workflow.standalonePromptPresetId);
  }
  const workflows = synchronizeFolderCollection('media_workflows', rendering.workflows, rendering.folders, migration);
  rendering.defaultWorkflowId = resolve(workflows, rendering.defaultWorkflowId);
  rendering.avatarWorkflowId = resolve(workflows, rendering.avatarWorkflowId);
  rendering.descriptionWorkflowId = resolve(workflows, rendering.descriptionWorkflowId);
  settings.mediaChatPrompts.defaultPresetId = resolve(chat, settings.mediaChatPrompts.defaultPresetId);
  settings.mediaStandalonePrompts.defaultPresetId = resolve(
    standalone,
    settings.mediaStandalonePrompts.defaultPresetId,
  );
  for (const [table, items] of [
    ['media_shortcuts', rendering.shortcuts],
    ['media_favorites', settings.mediaFavorites],
  ] as const) {
    for (const [position, item] of items.entries()) {
      item.workflowId = resolve(workflows, item.workflowId)!;
      if ('presetId' in item) item.presetId = resolve(chat, item.presetId as string)!;
      Object.assign(item, { position });
      if (!item.workflowId || ('presetId' in item && !item.presetId))
        throw new HttpError(400, 'A media shortcut or favorite references a missing entity');
    }
    synchronizeRows(table, items as unknown as Item[], MEDIA_ENTITIES[table].fields, false, migration);
  }
  const avatarSet = settings.imageGeneration.promptPresets?.avatar;
  const previousAvatars = mediaEntityRows('avatar_prompts');
  const avatars = (avatarSet?.presets ?? []) as unknown as Item[];
  for (const [index, preset] of avatars.entries())
    preset.id ??= previousAvatars.find((item) => item.name === preset.name)?.id ?? `new-avatar-${index}`;
  const avatarIds = synchronizeRows('avatar_prompts', avatars, MEDIA_ENTITIES.avatar_prompts.fields, true, migration);
  const selectedAvatar =
    avatarSet?.activeId === undefined
      ? (avatars.find((item) => item.name === avatarSet?.active)?.id ?? null)
      : resolve(avatarIds, avatarSet.activeId);
  if (avatarSet) {
    avatarSet.activeId = selectedAvatar;
    avatarSet.active = avatars.find((item) => item.id === selectedAvatar)?.name ?? '';
  }
  stmt(
    `UPDATE media_selections SET default_workflow_id = ?, avatar_workflow_id = ?, description_workflow_id = ?, chat_prompt_id = ?, standalone_prompt_id = ?, avatar_prompt_id = ? WHERE id = 1`,
  ).run(
    rendering.defaultWorkflowId,
    rendering.avatarWorkflowId,
    rendering.descriptionWorkflowId,
    settings.mediaChatPrompts.defaultPresetId,
    settings.mediaStandalonePrompts.defaultPresetId,
    selectedAvatar,
  );
  return workflows;
}

export function scalarSettings(settings: SettingsPreferences): string {
  const { defaultWorkflowId, avatarWorkflowId, descriptionWorkflowId, ...mediaRendering } = settings.mediaRendering;
  const { avatarPromptId, ...imageGeneration } = settings.imageGeneration;
  const { mediaChatPrompts, mediaStandalonePrompts, ...rest } = settings;
  return JSON.stringify({ ...rest, mediaRendering, imageGeneration });
}
