import { defaultMediaPrompt, type MediaWorkflow } from '@tinytavern/shared';
import { stmt } from '../db/db.ts';
import { HttpError } from '../http/router.ts';
import { type JsonObject, requiredString } from '../http/validation.ts';
import {
  MEDIA_ENTITIES,
  mediaEntityDto,
  encodeMediaField,
  type MediaEntityTable,
} from '../settings/mediaEntities.ts';
import { touchMediaSettings } from '../settings/settingsStore.ts';
import {
  parseMediaWorkflow,
  supportsMediaFavorite,
  validateWorkflowSelection,
} from '../media/mediaSettings.ts';
import { requireMediaWorkflow } from '../media/mediaWorkflows.ts';
import { defineEntityRoutes, entityFields } from './shared/entityRoutes.ts';

/** Validate only references to this workflow, without reading or parsing the library. */
function validateWorkflowUpdate(workflow: MediaWorkflow): void {
  const selections = stmt('SELECT * FROM media_selections WHERE id = 1').get();
  for (const purpose of ['default', 'avatar', 'description'] as const) {
    if (String(selections?.[`${purpose}_workflow_id`]) === workflow.id) {
      validateWorkflowSelection(workflow, purpose);
    }
  }
  if (stmt('SELECT id FROM media_shortcuts WHERE workflow_id = ? LIMIT 1').get(workflow.id)) {
    validateWorkflowSelection(workflow, 'shortcut');
  }
  const favorite = stmt('SELECT id FROM media_favorites WHERE workflow_id = ? LIMIT 1').get(
    workflow.id,
  );
  if (favorite && !supportsMediaFavorite(workflow)) {
    throw new HttpError(
      400,
      'Remove this workflow from toolbar favorites before adding media inputs or changing its output',
    );
  }
}

/** Delete only references to the affected row; historical jobs and recipes keep their identity. */
function cleanupReferences(table: MediaEntityTable, id: number): void {
  if (table === 'media_workflows') {
    stmt('DELETE FROM media_shortcuts WHERE workflow_id = ?').run(id);
    stmt('DELETE FROM media_favorites WHERE workflow_id = ?').run(id);
  }
  if (table === 'media_chat_prompts') {
    stmt('DELETE FROM media_favorites WHERE preset_id = ?').run(id);
  }
  const selections = [
    ['default_workflow_id', 'media_workflows'],
    ['avatar_workflow_id', 'media_workflows'],
    ['description_workflow_id', 'media_workflows'],
    ['chat_prompt_id', 'media_chat_prompts'],
    ['standalone_prompt_id', 'media_standalone_prompts'],
    ['avatar_prompt_id', 'avatar_prompts'],
  ];
  for (const [column, target] of selections) {
    if (table === target) {
      stmt(`UPDATE media_selections SET ${column} = NULL WHERE ${column} = ?`).run(id);
    }
  }
  const prompts = [
    ['chat_prompt_preset_id', 'media_chat_prompts'],
    ['standalone_prompt_preset_id', 'media_standalone_prompts'],
  ];
  for (const [column, target] of prompts) {
    if (table === target) {
      stmt(
        `UPDATE media_workflows SET ${column} = NULL, revision = revision + 1 WHERE ${column} = ?`,
      ).run(id);
    }
  }
}

for (const table of Object.keys(MEDIA_ENTITIES) as MediaEntityTable[]) {
  const spec = MEDIA_ENTITIES[table];
  const soft = spec.folder !== null;
  const fields = { ...spec.fields, ...(spec.folder ? { folderId: 'folder_id' } : {}) };
  defineEntityRoutes({
    table,
    invalidateEntity: 'settings',
    softDelete: soft,
    revisionColumn: 'revision',
    affectsGeneration: false,
    toDto: (row) => ({
      ...mediaEntityDto(table, row),
      id: Number(row.id),
      folderId: row.folder_id == null ? null : String(row.folder_id),
      revision: Number(row.revision ?? 0),
      settingsRevision: Number(
        stmt(
          "SELECT json_extract(value, '$.revision') AS revision FROM settings WHERE key = 'app'",
        ).get()?.revision ?? 0,
      ),
    }),
    guard: (body, current) => {
      if (current && body.expectedRevision !== current.revision)
        throw new HttpError(409, 'This entity changed elsewhere; reload it before saving');
    },
    prepare: (body, current) => {
      const merged: JsonObject = {
        ...current,
        ...body,
        name: body.name === undefined && current ? current.name : requiredString(body, 'name'),
      };
      if (
        stmt(
          `SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE AND id <> ?${soft ? ' AND deleted_at IS NULL' : ''}`,
        ).get(String(merged.name), current?.id ?? 0)
      )
        throw new HttpError(409, 'An entity with this name already exists');
      if (table === 'media_workflows') {
        const parsed = parseMediaWorkflow({
          inputBindings: {},
          json: '',
          standalonePromptPresetId: null,
          chatPromptPresetId: null,
          ...merged,
          id: String(current?.id ?? 'new'),
        });
        if (current) {
          validateWorkflowUpdate(parsed);
        }
        Object.assign(merged, parsed);
        for (const [key, target] of [
          ['chatPromptPresetId', 'media_chat_prompts'],
          ['standalonePromptPresetId', 'media_standalone_prompts'],
        ] as const) {
          const ref = parsed[key];
          if (
            ref != null &&
            !stmt(`SELECT id FROM ${target} WHERE id = ? AND deleted_at IS NULL`).get(ref)
          )
            throw new HttpError(400, 'The prompt preset is unavailable');
        }
      } else if (table === 'media_standalone_prompts') {
        for (const [key, fallback] of Object.entries(defaultMediaPrompt())) {
          const value = merged[key] ?? fallback;
          if (typeof value !== 'string') throw new HttpError(400, `${key} must be text`);
          merged[key] = value;
        }
      }
      if (table === 'media_shortcuts' || table === 'media_favorites') {
        const references = [['workflowId', 'media_workflows']];
        if (table === 'media_favorites') references.push(['presetId', 'media_chat_prompts']);
        for (const [field, target] of references) {
          const id = merged[field!];
          if (
            typeof id !== 'string' ||
            !stmt(`SELECT id FROM ${target} WHERE id = ? AND deleted_at IS NULL`).get(id)
          ) {
            throw new HttpError(400, 'The referenced media entity is unavailable');
          }
        }
        const position = merged.position ?? 0;
        if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0) {
          throw new HttpError(400, 'Position must be a non-negative integer');
        }
        merged.position = position;
        const workflow = requireMediaWorkflow(String(merged.workflowId));
        if (table === 'media_shortcuts') {
          validateWorkflowSelection(workflow, 'shortcut');
        } else if (!supportsMediaFavorite(workflow)) {
          throw new HttpError(
            400,
            'Favorites require a workflow with a prompt and no media inputs',
          );
        }
      }
      if (spec.folder) {
        let folderId = current?.folderId ?? null;
        if (body.folderId !== undefined) {
          folderId = body.folderId === null ? null : String(body.folderId);
        }
        if (
          folderId != null &&
          (!Number.isSafeInteger(Number(folderId)) ||
            !stmt(`SELECT id FROM ${spec.folder} WHERE id = ?`).get(Number(folderId)))
        )
          throw new HttpError(400, 'The folder is unavailable');
        merged.folderId = folderId;
      }
      for (const key of Object.keys(spec.fields)) {
        if (key === 'chatPrompt' || key === 'prompt' || key === 'context') {
          merged[key] ??= '';
          if (typeof merged[key] !== 'string') throw new HttpError(400, `${key} must be text`);
        }
      }
      const instruction = table === 'media_chat_prompts' ? merged.chatPrompt : merged.userMessage;
      if (
        (table === 'media_chat_prompts' || table === 'media_standalone_prompts') &&
        !String(instruction).trim()
      ) {
        throw new HttpError(400, 'The prompt instruction cannot be empty');
      }
      return merged;
    },
    fields: Object.entries(fields).map(([key, column]) => ({
      column,
      value: (body) => encodeMediaField(column, body[key]),
    })),
    prepareDelete: (id) => cleanupReferences(table, id),
    afterWrite: touchMediaSettings,
  });
  if (spec.folder)
    defineEntityRoutes<{ id: number; name: string; createdAt: number }>({
      table: spec.folder,
      invalidateEntity: 'settings',
      affectsGeneration: false,
      toDto: (row) => ({
        id: Number(row.id),
        name: String(row.name),
        createdAt: Number(row.created_at),
      }),
      prepare: (body, current) => {
        const name =
          body.name === undefined && current ? current.name : requiredString(body, 'name');
        if (
          stmt(`SELECT id FROM ${spec.folder} WHERE name = ? COLLATE NOCASE AND id <> ?`).get(
            name,
            current?.id ?? 0,
          )
        ) {
          throw new HttpError(409, 'A folder with this name already exists');
        }
        return { ...body, name };
      },
      prepareDelete: (id) => {
        stmt(
          `UPDATE ${table} SET folder_id = NULL, revision = revision + 1 WHERE folder_id = ?`,
        ).run(id);
      },
      fields: entityFields({ name: '' }),
      afterWrite: touchMediaSettings,
    });
}
