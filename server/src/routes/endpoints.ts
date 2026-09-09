import { ENTITY_FIELDS } from '@tinytavern/shared';
import type { Endpoint, GenParams, ReasoningEffort } from '@tinytavern/shared';
import { stmt, toEndpoint } from '../db.ts';
import { invalidate } from '../events.ts';
import { route, HttpError } from '../router.ts';
import { objectBody, optionalNumber, optionalString, positiveId } from '../validation.ts';
import { defineEntityRoutes, entityFields } from './entityRoutes.ts';
import { rowById } from './entityUtils.ts';

const PREFILL_MODES = new Set<Endpoint['prefillMode']>(['disabled', 'none', 'vllm', 'deepseek']);

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'max',
]);

function publicEndpoint(endpoint: Endpoint): Endpoint {
  return { ...endpoint, apiKey: '', hasApiKey: endpoint.apiKey.length > 0 };
}

function baseUrl(value: string | undefined, current?: string): string {
  const text = (value ?? current ?? '').trim().replace(/\/+$/, '');
  if (!text) throw new HttpError(400, 'baseUrl is required');
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new HttpError(400, 'baseUrl must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'baseUrl must use http or https');
  }
  return text;
}

function endpointApiKey(
  body: Record<string, unknown>,
  current?: typeof ENTITY_FIELDS.endpoints,
): string {
  const supplied = optionalString(body, 'apiKey');
  if (supplied !== undefined) return supplied;
  if (!current) return '';
  const nextBaseUrl = baseUrl(optionalString(body, 'baseUrl'), current.baseUrl);
  // Changing origin requires re-entering the key; redacted clients cannot forward it.
  return new URL(nextBaseUrl).origin === new URL(current.baseUrl).origin ? current.apiKey : '';
}

const GEN_PARAM_RANGES = [
  ['temperature', 0, 2],
  ['topP', 0, 1],
  ['minP', 0, 1],
  ['maxTokens', 1, Infinity],
  ['frequencyPenalty', -2, 2],
  ['presencePenalty', -2, 2],
] as const;

function genParams(value: unknown, current: GenParams = {}, replace = false): GenParams {
  if (value === undefined) return current;
  const b = objectBody(value);
  // PATCH merges parameters; the editor requests replacement for its complete form.
  const next: GenParams = replace ? {} : { ...current };
  const numbers = GEN_PARAM_RANGES.map(([key]) => optionalNumber(b, key));
  for (let i = 0; i < GEN_PARAM_RANGES.length; i++) {
    const [key, min, max] = GEN_PARAM_RANGES[i]!;
    const value = numbers[i];
    if (value === undefined) continue;
    if (key === 'maxTokens') {
      if (!Number.isInteger(value) || value < 1)
        throw new HttpError(400, 'maxTokens must be a positive integer');
    } else if (value < min || value > max) {
      throw new HttpError(400, `${key} must be between ${min} and ${max}`);
    }
    next[key] = value;
  }
  const reasoningEffort = b.reasoningEffort;
  if (reasoningEffort !== undefined) {
    if (
      typeof reasoningEffort !== 'string' ||
      !REASONING_EFFORTS.has(reasoningEffort as ReasoningEffort)
    ) {
      throw new HttpError(400, 'reasoningEffort must be none, minimal, low, medium, high or max');
    }
    next.reasoningEffort = reasoningEffort as ReasoningEffort;
  }
  return next;
}

function prefillMode(value: unknown, current: Endpoint['prefillMode']): Endpoint['prefillMode'] {
  if (value === undefined) return current;
  if (typeof value !== 'string' || !PREFILL_MODES.has(value as Endpoint['prefillMode'])) {
    throw new HttpError(400, 'prefillMode must be disabled, none, vllm or deepseek');
  }
  return value as Endpoint['prefillMode'];
}

defineEntityRoutes<Endpoint>({
  table: 'endpoints',
  toDto: toEndpoint,
  toPublic: publicEndpoint,
  fields: entityFields(ENTITY_FIELDS.endpoints, {
    baseUrl: (b, cur) => baseUrl(optionalString(b, 'baseUrl'), cur?.baseUrl),
    apiKey: endpointApiKey,
    genParams: (b, cur) =>
      JSON.stringify(genParams(b.genParams, cur?.genParams, b.replaceGenParams === true)),
    prefillMode: (b, cur) => prefillMode(b.prefillMode, cur?.prefillMode ?? 'none'),
  }),
  settingsRef: 'activeEndpointId',
  // ON DELETE SET NULL clears conversation overrides; refetch them.
  invalidateOnDelete: ['conversations'],
});

route.get('/api/endpoints/:id/models', async ({ params }) => {
  const endpoint = toEndpoint(rowById('endpoints', positiveId(params.id)));
  let res: Response;
  try {
    res = await fetch(`${endpoint.baseUrl}/models`, {
      headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // undici puts connection details in cause behind a generic "fetch failed".
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const reason = err instanceof Error ? err.message : String(err);
    const detail = cause?.code ?? cause?.message;
    throw new HttpError(
      502,
      `upstream /models failed for ${endpoint.baseUrl}: ${reason}${detail ? ` (${detail})` : ''}`,
    );
  }
  if (!res.ok) throw new HttpError(502, `upstream /models returned ${res.status}`);
  const json = (await res.json()) as { data?: unknown };
  if (!Array.isArray(json.data)) throw new HttpError(502, 'upstream /models returned invalid JSON');
  const models = json.data
    .map((model) => (model && typeof model === 'object' ? (model as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === 'string')
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  stmt('UPDATE endpoints SET models_json = ? WHERE id = ?').run(
    JSON.stringify(models),
    endpoint.id,
  );
  invalidate('endpoints');
  return models;
});
