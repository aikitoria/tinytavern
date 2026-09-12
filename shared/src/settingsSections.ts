import { importNamedCollection, namedItem, transferObject } from './settingsTransfer.ts';
import { nextCollectionId } from './numericIds.ts';

/** Portable field codecs are shared by every settings section, regardless of persistence. */
export interface SettingsFieldCodec {
  encode: (value: unknown) => unknown;
  decode: (value: unknown, current: unknown) => unknown;
}
export type SettingsFieldSchema = Readonly<Record<string, SettingsFieldCodec>>;
const own = (value: unknown, key: string) => value != null && Object.hasOwn(value, key);
const safeKey = (key: string) => {
  if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid settings field');
};
const scalar = (kind: 'string' | 'number' | 'boolean'): SettingsFieldCodec => ({
  encode: (value) => value,
  decode(value) {
    if (typeof value !== kind || (kind === 'number' && !Number.isFinite(value))) throw new Error(`Expected ${kind}`);
    return value;
  },
});
export const settingsText = scalar('string');
export const settingsNumber = scalar('number');
export const settingsBoolean = scalar('boolean');
export const settingsNullable = (codec: SettingsFieldCodec): SettingsFieldCodec => ({
  encode: (value) => (value == null ? null : codec.encode(value)),
  decode: (value, current) => (value === null ? null : codec.decode(value, current)),
});
export const settingsObject = (fields: SettingsFieldSchema): SettingsFieldCodec => ({
  encode(value) {
    const source = transferObject(value);
    return Object.fromEntries(
      Object.entries(fields)
        .filter(([key]) => own(source, key) && source[key] !== undefined)
        .map(([key, codec]) => [key, codec.encode(source[key])]),
    );
  },
  decode(value, current) {
    const source = transferObject(value);
    const result = {
      ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
    } as Record<string, unknown>;
    for (const [key, value] of Object.entries(source)) {
      safeKey(key);
      if (!own(fields, key)) throw new Error(`Unknown settings field: ${key}`);
      result[key] = fields[key]!.decode(value, result[key]);
    }
    return result;
  },
});
export const settingsDictionary = (codec: SettingsFieldCodec): SettingsFieldCodec => ({
  encode: (value) =>
    Object.fromEntries(Object.entries(transferObject(value ?? {})).map(([key, item]) => [key, codec.encode(item)])),
  decode(value, current) {
    const source = transferObject(value);
    const previous = current == null ? {} : transferObject(current);
    return Object.fromEntries(
      Object.entries(source).map(([key, item]) => {
        safeKey(key);
        return [key, codec.decode(item, previous[key])];
      }),
    );
  },
});
export const settingsReference = (
  items: () => readonly { id: string | number; name: string }[],
  nullable = true,
): SettingsFieldCodec => ({
  encode(value) {
    if (value == null && nullable) return null;
    const item = items().find((item) => item.id === value);
    if (!item) throw new Error('A referenced setting no longer exists');
    if (namedItem(items(), item.name)?.id !== item.id) throw new Error(`Setting reference is ambiguous: ${item.name}`);
    return item.name;
  },
  decode(value) {
    if (value === null && nullable) return null;
    const item = namedItem(items(), value);
    if (!item) throw new Error(`Setting reference is unavailable or ambiguous: ${String(value)}`);
    return item.id;
  },
});

/** Imports retain local IDs, honor file order, and append existing entries absent from the file. */
export const settingsCollection = (
  fields: SettingsFieldSchema,
  defaults: () => Record<string, unknown>,
): SettingsFieldCodec => {
  const row = settingsObject(fields);
  return {
    encode: (value) => (value as Record<string, unknown>[]).map(row.encode),
    decode(value, current) {
      if (!Array.isArray(value)) throw new Error('Expected a settings list');
      const previous = Array.isArray(current) ? (current as { id: string; name: string }[]) : [];
      return importNamedCollection(value.map(transferObject), previous, (item, existing) => {
        for (const key of Object.keys(fields)) if (!own(item, key)) throw new Error(`Missing settings field: ${key}`);
        const next = row.decode(item, existing ?? defaults()) as Record<string, unknown>;
        next.id = existing?.id ?? nextCollectionId(previous);
        return next as { id: string; name: string };
      });
    },
  };
};

export function readSettingsPath(source: Record<string, unknown>, path: string): unknown {
  let value: unknown = source;
  for (const key of path.split('.')) value = own(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  return value;
}
function writeSettingsPath(source: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.');
  let target = source;
  for (const key of parts.slice(0, -1)) {
    safeKey(key);
    const current = target[key];
    target[key] = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
    target = target[key] as Record<string, unknown>;
  }
  const key = parts.at(-1)!;
  safeKey(key);
  target[key] = value;
}
const fileKey = (path: string) => path.split('.').at(-1)!;
export function exportSettingsSection(
  schema: SettingsFieldSchema,
  paths: readonly string[],
  source: Record<string, unknown>,
) {
  if (new Set(paths.map(fileKey)).size !== paths.length) throw new Error('Duplicate settings field names');
  return Object.fromEntries(
    paths
      .map((path) => {
        if (!own(schema, path)) throw new Error(`Unregistered settings field: ${path}`);
        const value = readSettingsPath(source, path);
        return [fileKey(path), value === undefined ? undefined : schema[path]!.encode(value)];
      })
      .filter(([, value]) => value !== undefined),
  );
}
export function importSettingsSection(
  schema: SettingsFieldSchema,
  paths: readonly string[],
  value: unknown,
  current: Record<string, unknown>,
) {
  const source = transferObject(value);
  const known = new Map(paths.map((path) => [fileKey(path), path]));
  if (known.size !== paths.length) throw new Error('Duplicate settings field names');
  const next = { ...current };
  // Decode the whole section before handing the new draft to the editor.
  for (const [key, value] of Object.entries(source)) {
    const path = known.get(key);
    if (!path || !own(schema, path)) throw new Error(`Unknown settings field: ${key}`);
    try {
      writeSettingsPath(next, path, schema[path]!.decode(value, readSettingsPath(current, path)));
    } catch (error) {
      throw new Error(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return next;
}

/** Scalar/object field definitions come from the same defaults used by the existing editors. */
export function settingsFields(
  defaults: Record<string, unknown>,
  overrides: SettingsFieldSchema = {},
): SettingsFieldSchema {
  return Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => {
      const codec =
        overrides[key] ??
        (value === null
          ? settingsNullable(settingsText)
          : typeof value === 'string'
            ? settingsText
            : typeof value === 'number'
              ? settingsNumber
              : typeof value === 'boolean'
                ? settingsBoolean
                : settingsObject(settingsFields(transferObject(value))));
      return [key, codec];
    }),
  );
}
