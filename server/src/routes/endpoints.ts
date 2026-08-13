import type { Endpoint, GenParams, ReasoningEffort } from '@minitavern/shared';
import { stmt, toEndpoint } from '../db.ts';
import { invalidate } from '../events.ts';
import { route, HttpError } from '../router.ts';
import { objectBody, optionalNumber, optionalString, positiveId } from '../validation.ts';
import { defineEntityRoutes, nameField, nullableTextField } from './entityRoutes.ts';
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

function endpointApiKey(body: Record<string, unknown>, current?: Endpoint): string {
  const supplied = optionalString(body, 'apiKey');
  if (supplied !== undefined) return supplied;
  if (!current) return '';
  const nextBaseUrl = baseUrl(optionalString(body, 'baseUrl'), current.baseUrl);
  // A redacted client may preserve a secret only while it still targets the
  // same scheme/host/port. Retargeting requires the key to be entered again.
  return new URL(nextBaseUrl).origin === new URL(current.baseUrl).origin ? current.apiKey : '';
}

function genParams(value: unknown, current: GenParams = {}, replace = false): GenParams {
  if (value === undefined) return current;
  const b = objectBody(value);
  // API PATCHes are field-level: supplying one sampling parameter must not
  // silently erase all the others. The first-party editor explicitly requests
  // replacement because its form submits the complete visible parameter set.
  const next: GenParams = replace ? {} : { ...current };
  const temperature = optionalNumber(b, 'temperature');
  const topP = optionalNumber(b, 'topP');
  const minP = optionalNumber(b, 'minP');
  const maxTokens = optionalNumber(b, 'maxTokens');
  const frequencyPenalty = optionalNumber(b, 'frequencyPenalty');
  const presencePenalty = optionalNumber(b, 'presencePenalty');
  if (temperature != null && (temperature < 0 || temperature > 2))
    throw new HttpError(400, 'temperature must be between 0 and 2');
  if (topP != null && (topP < 0 || topP > 1))
    throw new HttpError(400, 'topP must be between 0 and 1');
  if (minP != null && (minP < 0 || minP > 1))
    throw new HttpError(400, 'minP must be between 0 and 1');
  if (maxTokens != null && (!Number.isInteger(maxTokens) || maxTokens < 1))
    throw new HttpError(400, 'maxTokens must be a positive integer');
  for (const [key, number] of [
    ['frequencyPenalty', frequencyPenalty],
    ['presencePenalty', presencePenalty],
  ] as const) {
    if (number != null && (number < -2 || number > 2)) {
      throw new HttpError(400, `${key} must be between -2 and 2`);
    }
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
  if (temperature != null) next.temperature = temperature;
  if (topP != null) next.topP = topP;
  if (minP != null) next.minP = minP;
  if (maxTokens != null) next.maxTokens = maxTokens;
  if (frequencyPenalty != null) next.frequencyPenalty = frequencyPenalty;
  if (presencePenalty != null) next.presencePenalty = presencePenalty;
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
  fields: [
    nameField((cur) => cur.name),
    { column: 'base_url', value: (b, cur) => baseUrl(optionalString(b, 'baseUrl'), cur?.baseUrl) },
    { column: 'api_key', value: endpointApiKey },
    nullableTextField('model', 'model', (cur) => cur.model),
    {
      column: 'gen_params_json',
      value: (b, cur) =>
        JSON.stringify(genParams(b.genParams, cur?.genParams, b.replaceGenParams === true)),
    },
    {
      column: 'prefill_mode',
      value: (b, cur) => prefillMode(b.prefillMode, cur?.prefillMode ?? 'none'),
    },
  ],
  settingsRef: 'activeEndpointId',
  // conversations.endpoint_id is ON DELETE SET NULL — clients must drop the
  // stale per-conversation override, same as characters/personas.
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
    // undici hides the real failure (ECONNREFUSED, ENOTFOUND, TLS, ...) in err.cause
    // behind a generic "fetch failed" TypeError.
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
