import { ENTITY_FOLDERS, type FolderEntity } from '@tinytavern/shared';
import { openDialog, state } from './store.ts';
import { readPageLocation } from './pageLocation.ts';
import type { SelectOption } from '../components/ui/Select.tsx';
import { collectionByName } from './collectionOrder.ts';

const ENTITY_TABS = {
  characters: 'characters',
  personas: 'personas',
  presets: 'system-prompts',
  templates: 'chat-templates',
  endpoints: 'model-connections',
  workflows: 'workflows',
  mediaChatPrompts: 'chat-media-prompts',
  mediaStandalonePrompts: 'standalone-media-prompts',
} as const;
export type SettingsEntityKind = keyof typeof ENTITY_TABS;

/** Settings navigation reuses its existing panel and guards the editor being replaced. */
export function editReferencedEntity(kind: SettingsEntityKind, id: number | string): void {
  const current = readPageLocation();
  openDialog({
    chatId: current.chatId,
    viewMode: current.viewMode,
    modal: 'settings',
    settingsTab: ENTITY_TABS[kind],
    settingsEntity: id,
    settingsDetail: true,
  });
}

export function entityOption(
  kind: SettingsEntityKind,
  item: { id: number | string; name: string },
  value = String(item.id),
): SelectOption {
  return { value, label: item.name, edit: () => editReferencedEntity(kind, item.id) };
}

export function entityOptions(
  kind: SettingsEntityKind,
  items: readonly { id: number | string; name: string; folderId?: number | string | null }[],
): SelectOption[] {
  const sorted = collectionByName(items);
  const groups = new Map<number | string, { name: string; options: SelectOption[] }>();
  if (Object.hasOwn(ENTITY_FOLDERS, kind)) {
    for (const folder of collectionByName(state[ENTITY_FOLDERS[kind as FolderEntity].state]))
      groups.set(folder.id, { name: folder.name, options: [] });
  } else {
    const folders =
      kind === 'workflows'
        ? state.settings.mediaRendering.folders
        : state.settings[kind as 'mediaChatPrompts' | 'mediaStandalonePrompts'].folders;
    for (const folder of collectionByName<(typeof folders)[number]>(folders)) {
      groups.set(folder.id, { name: folder.name, options: [] });
    }
  }
  const root: SelectOption[] = [];
  for (const item of sorted) {
    const option = entityOption(kind, item);
    const group = groups.get(item.folderId!);
    if (group) group.options.push({ ...option, group: group.name });
    else root.push(option);
  }
  return [...root, ...Array.from(groups.values()).flatMap((group) => group.options)];
}
