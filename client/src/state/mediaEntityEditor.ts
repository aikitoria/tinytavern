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
  const write = async (id: string | null, fields: Record<string, unknown>): Promise<T> => {
    const current = id == null ? undefined : items().find((item) => item.id === id);
    if (id != null && !current) throw new Error('This entity was deleted. Discard to continue.');
    const result = await api.mediaEntity<T & { settingsRevision: number }>(
      table,
      id == null ? 'POST' : 'PATCH',
      id,
      { ...fields, expectedRevision: fields.revision ?? current?.revision ?? 0 },
    );
    const item = { ...result, id: String(result.id) };
    Reflect.deleteProperty(item, 'settingsRevision');
    if (result.settingsRevision === state.settings.revision + 1) {
      const base = unwrap(state.settings);
      const settings = {
        ...base,
        mediaRendering: {
          ...base.mediaRendering,
          workflows: [...base.mediaRendering.workflows],
          folders: base.mediaRendering.folders.map((group) => ({
            ...group,
            workflowIds: [...group.workflowIds],
          })),
        },
        mediaChatPrompts: {
          ...base.mediaChatPrompts,
          presets: [...base.mediaChatPrompts.presets],
          folders: base.mediaChatPrompts.folders.map((group) => ({
            ...group,
            presetIds: [...group.presetIds],
          })),
        },
        mediaStandalonePrompts: {
          ...base.mediaStandalonePrompts,
          presets: [...base.mediaStandalonePrompts.presets],
          folders: base.mediaStandalonePrompts.folders.map((group) => ({
            ...group,
            presetIds: [...group.presetIds],
          })),
        },
      };
      const list =
        kind === 'workflows' ? settings.mediaRendering.workflows : settings[kind].presets;
      const index = list.findIndex((value) => value.id === item.id);
      if (index < 0) list.push(item as never);
      else list[index] = item as never;
      const groups =
        kind === 'workflows' ? settings.mediaRendering.folders : settings[kind].folders;
      for (const group of groups) {
        const members = 'workflowIds' in group ? group.workflowIds : group.presetIds;
        const position = members.indexOf(item.id);
        if (position >= 0) members.splice(position, 1);
        if (group.id === item.folderId) members.push(item.id);
      }
      settings.revision = result.settingsRevision;
      applySettings(settings);
    }
    if (result.settingsRevision > state.settings.revision) await refresh();
    return item;
  };
  return {
    create: (data: Record<string, unknown>) => write(null, data),
    patch: (id: string, data: Record<string, unknown>) => write(id, data),
    duplicate: (id: string) => {
      const source = items().find((item) => item.id === id);
      if (!source) throw new Error('The entity no longer exists');
      let name = `${source.name} (copy)`;
      for (let n = 2; items().some((item) => item.name.toLowerCase() === name.toLowerCase()); n++)
        name = `${source.name} (copy ${n})`;
      return write(null, { ...source, name });
    },
    remove: async (id: string) => {
      const current = items().find((item) => item.id === id);
      await api.mediaEntity(table, 'DELETE', id, { expectedRevision: current?.revision ?? 0 });
      await refresh();
    },
    folders: {
      create: async (name: string) => {
        await api.mediaEntity(
          `${table === 'media_workflows' ? 'media_workflow' : table}_folders`,
          'POST',
          null,
          { name },
        );
        await refresh();
      },
      rename: async (id: string, name: string) => {
        await api.mediaEntity(
          `${table === 'media_workflows' ? 'media_workflow' : table}_folders`,
          'PATCH',
          id,
          { name },
        );
        await refresh();
      },
      remove: async (id: string) => {
        await api.mediaEntity(
          `${table === 'media_workflows' ? 'media_workflow' : table}_folders`,
          'DELETE',
          id,
        );
        await refresh();
      },
    },
  };
}
