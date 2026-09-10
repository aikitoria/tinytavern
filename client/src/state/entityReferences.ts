import { openDialog } from './store.ts';
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
  items: readonly { id: number | string; name: string }[],
): SelectOption[] {
  return collectionByName(items).map((item) => entityOption(kind, item));
}
