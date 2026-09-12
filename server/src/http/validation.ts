import { HttpError } from './router.ts';

export type JsonObject = Record<string, unknown>;

export function requireObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, `${label} must be an object`);
  return value as JsonObject;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string`);
  return value;
}

export function objectBody(body: unknown): JsonObject {
  if (body == null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'JSON body must be an object');
  }
  return body as JsonObject;
}

export function positiveId(value: string | undefined, label = 'id'): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, `${label} must be a positive integer`);
  return id;
}

export function requiredString(body: JsonObject, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${key} is required`);
  return value.trim();
}

export function optionalString(body: JsonObject, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${key} must be a string`);
  return value;
}

export function optionalNullableString(body: JsonObject, key: string): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw new HttpError(400, `${key} must be a string or null`);
  return value;
}

export function optionalBoolean(body: JsonObject, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, `${key} must be a boolean`);
  return value;
}

export function optionalNullableId(body: JsonObject, key: string): number | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new HttpError(400, `${key} must be a positive integer or null`);
  }
  return value as number;
}

export function optionalNumber(body: JsonObject, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, `${key} must be a finite number`);
  }
  return value;
}
