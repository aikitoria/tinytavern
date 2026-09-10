import {
  ENTITY_FIELDS,
  entityTransferData,
  type TransferEntity,
  ENTITY_FOLDERS,
  DEFAULT_CUSTOM_TEMPLATE,
  settingsFields,
  settingsNullable,
  settingsObject,
  settingsReference,
  settingsText,
  settingsDictionary,
  settingsNumber,
  type SettingsFieldSchema,
} from '@tinytavern/shared';
import { state } from '../../state/store.ts';

/** Entity defaults already declare scalar fields. Only relationships need transfer metadata. */
export function entitySettingsSchema(type: keyof typeof ENTITY_FIELDS): SettingsFieldSchema {
  const { apiKey: _secret, ...defaults } = ENTITY_FIELDS[type] as Record<string, unknown>;
  const template = settingsFields(DEFAULT_CUSTOM_TEMPLATE);
  const overrides: SettingsFieldSchema =
    type === 'characters'
      ? {
          folderId: settingsReference(() => state.characterFolders),
          presetId: settingsReference(() => state.presets),
          templateId: settingsReference(() => state.templates),
          customTemplate: settingsNullable(settingsObject(template)),
        }
      : type === 'endpoints'
        ? {
            genParams: settingsDictionary({
              encode: (value) => value,
              decode: (value, current) =>
                (typeof value === 'string' ? settingsText : settingsNumber).decode(value, current),
            }),
          }
        : {};
  return {
    ...settingsFields(defaults, {
      ...overrides,
      folderId: settingsReference(() => state[ENTITY_FOLDERS[type].state]),
    }),
    ...(type === 'personas' ? { avatarData: settingsNullable(settingsText) } : {}),
    ...(type === 'characters'
      ? Object.fromEntries(
          Object.entries(template).map(([key, codec]) => [`customTemplate.${key}`, codec]),
        )
      : {}),
  };
}

/** Portable entity transfers resolve folder references by name, like section transfers. */
export function exportEntityDraft(type: TransferEntity, data: Record<string, unknown>) {
  return entityTransferData(type, {
    ...data,
    ...(data.folderId === undefined
      ? {}
      : { folderId: entitySettingsSchema(type).folderId!.encode(data.folderId) }),
  });
}
export function importEntityDraft(type: TransferEntity, data: unknown) {
  const imported = entityTransferData(type, data);
  if (Object.hasOwn(imported, 'folderId'))
    imported.folderId = entitySettingsSchema(type).folderId!.decode(imported.folderId, null);
  return imported;
}
