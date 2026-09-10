import {
  ENTITY_FIELDS,
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
    ...settingsFields(defaults, overrides),
    ...(type === 'personas' ? { avatarData: settingsNullable(settingsText) } : {}),
    ...(type === 'characters'
      ? Object.fromEntries(
          Object.entries(template).map(([key, codec]) => [`customTemplate.${key}`, codec]),
        )
      : {}),
  };
}
