import { unwrap } from 'solid-js/store';
import type { MediaWorkflow, MediaPromptPreset } from '@tinytavern/shared';
import { api } from './api.ts';
import { applySettings, state } from './store.ts';

export type MediaLibrary = 'workflows' | 'mediaChatPrompts' | 'mediaStandalonePrompts';
const tables = {
  workflows: 'media_workflows',
  mediaChatPrompts: 'media_chat_prompts',
  mediaStandalonePrompts: 'media_standalone_prompts',
} as const;
type Entity = (MediaWorkflow | MediaPromptPreset) & { folderId: string | null; revision?: number };

/** Workflow and prompt editors share the same row CRUD, revision guards and folder operations. */
export function mediaEntityEditor<T extends Entity>(kind: MediaLibrary, items: () => T[]) {
  const table = tables[kind];
  const refresh = async () => {
    applySettings(await api.settings());
  };
  const write = async (id: string | null, fields: Record<string, unknown>, duplicate = false): Promise<T> => {
    const current = id == null ? undefined : items().find((item) => item.id === id);
    if (id != null && !current) throw new Error('This entity was deleted. Discard to continue.');
    const result = await api.mediaEntity<T & { settingsRevision: number }>(
      table,
      id == null || duplicate ? 'POST' : 'PATCH',
      duplicate ? `${id}/duplicate` : id,
      { ...fields, expectedRevision: fields.revision ?? current?.revision ?? 0 },
    );
    const item = { ...result, id: String(result.id) };
    Reflect.deleteProperty(item, 'settingsRevision');
    if (result.settingsRevision === state.settings.revision + 1) {
      const base = unwrap(state.settings);
      const currentItems = kind === 'workflows' ? base.mediaRendering.workflows : base[kind].presets;
      const exists = currentItems.some((value) => value.id === item.id);
      const nextItems = exists
        ? currentItems.map((value) => (value.id === item.id ? item : value))
        : [...currentItems, item];
      const settings =
        kind === 'workflows'
          ? { ...base, mediaRendering: { ...base.mediaRendering, workflows: nextItems as MediaWorkflow[] } }
          : { ...base, [kind]: { ...base[kind], presets: nextItems } };
      settings.revision = result.settingsRevision;
      applySettings(settings);
    }
    if (result.settingsRevision > state.settings.revision) await refresh();
    return item;
  };
  return {
    create: (data: Record<string, unknown>) => write(null, data),
    patch: (id: string, data: Record<string, unknown>) => write(id, data),
    duplicate: (id: string) => write(id, {}, true),
    remove: async (id: string) => {
      const current = items().find((item) => item.id === id);
      await api.mediaEntity(table, 'DELETE', id, { expectedRevision: current?.revision ?? 0 });
      await refresh();
    },
    folders: {
      create: async (name: string) => {
        await api.mediaEntity(`${table === 'media_workflows' ? 'media_workflow' : table}_folders`, 'POST', null, {
          name,
        });
        await refresh();
      },
      rename: async (id: string, name: string) => {
        await api.mediaEntity(`${table === 'media_workflows' ? 'media_workflow' : table}_folders`, 'PATCH', id, {
          name,
        });
        await refresh();
      },
      remove: async (id: string) => {
        await api.mediaEntity(`${table === 'media_workflows' ? 'media_workflow' : table}_folders`, 'DELETE', id);
        await refresh();
      },
    },
  };
}
