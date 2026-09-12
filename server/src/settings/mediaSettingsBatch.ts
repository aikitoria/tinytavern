import {
  mediaSettingsCollections,
  DEFAULT_SETTINGS,
  type MediaSettingsChange,
  type MediaSettingsTable,
} from '@tinytavern/shared';
import { stmt } from '../db/db.ts';
import { HttpError } from '../http/router.ts';
import { requireObject } from '../http/validation.ts';
import { MEDIA_ENTITIES, type MediaEntityTable } from './mediaEntities.ts';
import {
  deleteMediaDependentRows,
  mediaEntityConfig,
  mediaFolderConfig,
  validateWorkflowUpdate,
} from './mediaEntityWrites.ts';
import { createEntityWriter } from '../routes/shared/entityWriter.ts';
import type { EntityConfig } from '../routes/shared/entityRoutes.ts';
import { requireMediaWorkflow } from '../media/mediaWorkflows.ts';

const tables = Object.keys(mediaSettingsCollections(DEFAULT_SETTINGS)) as MediaSettingsTable[];
function batchWriter<T extends { id: number }>(config: EntityConfig<T>) {
  return {
    softDelete: config.softDelete,
    revisionColumn: config.revisionColumn,
    prepareDelete: config.prepareDelete,
    writer: createEntityWriter(config),
  };
}

const configurations = new Map<MediaSettingsTable, ReturnType<typeof batchWriter>>();
for (const table of tables) {
  const parent = Object.keys(MEDIA_ENTITIES).find((key) => {
    return MEDIA_ENTITIES[key as MediaEntityTable].folder === table;
  }) as MediaEntityTable | undefined;
  const configuration = parent
    ? batchWriter(mediaFolderConfig(parent))
    : batchWriter(
        mediaEntityConfig(table as MediaEntityTable, {
          deferWorkflowValidation: true,
          deferDependentDeletes: true,
        }),
      );
  configurations.set(table, configuration);
}

export type MediaAssignedIds = Partial<Record<MediaSettingsTable, Record<string, string>>>;

export function resolveMediaFields(table: MediaSettingsTable, fields: Record<string, unknown>, ids: MediaAssignedIds) {
  const next = { ...fields };
  const references: Record<string, MediaSettingsTable | undefined> = {
    workflowId: 'media_workflows',
    chatPromptPresetId: 'media_chat_prompts',
    standalonePromptPresetId: 'media_standalone_prompts',
    presetId: 'media_chat_prompts',
    folderId:
      table in MEDIA_ENTITIES
        ? ((MEDIA_ENTITIES[table as MediaEntityTable].folder as MediaSettingsTable | null) ?? undefined)
        : undefined,
  };
  for (const [field, target] of Object.entries(references)) {
    if (target && typeof next[field] === 'string') next[field] = ids[target]?.[next[field] as string] ?? next[field];
  }
  return next;
}

/** Caller owns the global revision check and transaction. Only submitted rows are read/written. */
export function applyMediaSettingsChanges(value: unknown): MediaAssignedIds {
  if (!Array.isArray(value) || value.length > 20000) {
    throw new HttpError(400, 'Invalid media changes');
  }
  const seen = new Set<string>();
  const changes = value.map((raw) => {
    const change = requireObject(raw, 'media change') as unknown as MediaSettingsChange;
    if (
      !configurations.has(change.table) ||
      typeof change.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(change.id) ||
      ['__proto__', 'constructor', 'prototype'].includes(change.id) ||
      (change.create !== undefined && typeof change.create !== 'boolean') ||
      seen.has(`${change.table}:${change.id}`)
    )
      throw new HttpError(400, 'Invalid or duplicate media change');
    seen.add(`${change.table}:${change.id}`);
    if (change.fields !== null) requireObject(change.fields, 'media fields');
    if (change.create && change.fields === null) {
      throw new HttpError(400, 'Cannot delete a new row');
    }
    return change;
  });
  // Validate every original revision before an earlier operation changes a dependent row.
  for (const change of changes) {
    if (change.create) {
      continue;
    }
    const config = configurations.get(change.table)!;
    const current = stmt(`SELECT * FROM ${change.table} WHERE id = ?`).get(change.id);
    if (!current || (config.softDelete && current.deleted_at !== null)) {
      throw new HttpError(409, 'A media entity was deleted; reload before saving');
    }
    if (config.revisionColumn && current.revision !== change.revision) {
      throw new HttpError(409, 'A media entity changed; reload before saving');
    }
  }
  changes.sort((a, b) => {
    if ((a.fields === null) !== (b.fields === null)) {
      return a.fields === null ? -1 : 1;
    }
    const order = tables.indexOf(a.table) - tables.indexOf(b.table);
    return a.fields === null ? -order : order;
  });
  const assigned: MediaAssignedIds = Object.create(null);
  const deletedEntities: { table: MediaEntityTable; id: number }[] = [];
  for (const change of changes) {
    const config = configurations.get(change.table)!;
    const current = change.create ? undefined : stmt(`SELECT * FROM ${change.table} WHERE id = ?`).get(change.id);
    if (change.fields === null) {
      config.prepareDelete?.(Number(change.id));
      if (change.table in MEDIA_ENTITIES) {
        deletedEntities.push({ table: change.table as MediaEntityTable, id: Number(change.id) });
      }
      if (config.softDelete)
        stmt(`UPDATE ${change.table} SET deleted_at = ?, revision = revision + 1 WHERE id = ?`).run(
          Date.now(),
          change.id,
        );
      else stmt(`DELETE FROM ${change.table} WHERE id = ?`).run(change.id);
      continue;
    }
    const writer = config.writer;
    const fields = resolveMediaFields(change.table, change.fields, assigned);
    if (!change.create && !current) {
      throw new HttpError(409, 'A referenced deletion removed this media row; reload before saving');
    }
    const values = writer.values(fields, current ?? undefined);
    if (change.create) {
      const id = String(writer.insert(values));
      (assigned[change.table] ??= Object.create(null))[change.id] = id;
    } else writer.update(Number(change.id), values);
  }
  // A retained shortcut or favorite can move to a replacement created by this same batch.
  // Delete only rows that still reference a deleted entity after all submitted edits.
  for (const { table, id } of deletedEntities) {
    deleteMediaDependentRows(table, id);
  }
  return assigned;
}

/** Check selected workflows against the final batch, including changed selections and shortcuts. */
export function validateMediaSettingsChanges(value: unknown, ids: MediaAssignedIds): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const change of value as MediaSettingsChange[]) {
    if (change.table === 'media_workflows' && change.fields !== null) {
      const id = ids.media_workflows?.[change.id] ?? change.id;
      validateWorkflowUpdate(requireMediaWorkflow(id));
    }
  }
}
