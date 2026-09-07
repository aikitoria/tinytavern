import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expandWorkflowTemplate, workflowValidationError } from '@tinytavern/shared';
import type { GenParams, Settings } from '@tinytavern/shared';
import { createIpAllowlist } from '../../server/src/ipAccess.ts';
import {
  BASE,
  MOCK_URL,
  MOCK_CONTROL,
  assert,
  assertClientDevModules,
  req,
  expectStatus,
  websocketHandshake,
  putSettings,
} from './helpers.ts';

export async function testSetup() {
  console.log('== development client modules ==');
  await assertClientDevModules();

  const unrestricted = createIpAllowlist('   ');
  assert(
    unrestricted.isAllowed('203.0.113.42') && unrestricted.isAllowed('2001:db8::42'),
    'an explicitly empty IP allowlist permits every source address',
  );

  console.log('== cross-site request rejection ==');
  const hostileGet = await fetch(`${BASE}/api/settings`, {
    headers: { origin: 'http://attacker.invalid' },
  });
  assert(hostileGet.status === 403, 'cross-site HTTP reads are rejected');
  const hostilePost = await fetch(`${BASE}/api/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'http://attacker.invalid' },
    body: '{}',
  });
  assert(hostilePost.status === 403, 'cross-site text/plain POSTs are rejected before mutation');
  const sameOriginGet = await fetch(`${BASE}/api/settings`, {
    headers: { origin: new URL(BASE).origin },
  });
  assert(sameOriginGet.ok, 'same-origin browser HTTP requests remain accepted');
  assert(
    (await websocketHandshake('http://attacker.invalid')) === 403,
    'cross-site WebSocket upgrades are rejected',
  );
  assert(
    (await websocketHandshake(new URL(BASE).origin)) === 'open',
    'same-origin WebSocket upgrades remain accepted',
  );

  console.log('== workflow macro context validation ==');
  const unsafeWorkflow = String.raw`{"x":"\{{prompt}}"}`;
  assert(
    workflowValidationError(unsafeWorkflow)?.includes('unpaired backslash') === true,
    'backslash-adjacent prompt macros are rejected at validation time',
  );
  assert(
    workflowValidationError('{"seed":"{{seed}}"}')?.includes('JSON number value') === true,
    'quoted seed macros are rejected instead of changing type',
  );
  const macroPrompt = 'quotes " and slash \\ survive\nnewlines';
  const expandedWorkflow = expandWorkflowTemplate(
    '{"text":"prefix {{prompt}} suffix","seed":{{seed}}}',
    macroPrompt,
    42,
  );
  const expandedWorkflowJson = JSON.parse(expandedWorkflow) as { text: string; seed: number };
  assert(
    expandedWorkflowJson.text === `prefix ${macroPrompt} suffix` &&
      expandedWorkflowJson.seed === 42,
    'shared workflow expansion preserves prompt text and numeric seeds in real JSON context',
  );

  console.log('== setup: endpoint, models, settings ==');
  const endpoint = await req<{ id: number }>('POST', '/api/endpoints', {
    name: 'mock',
    baseUrl: MOCK_URL,
    apiKey: 'test-key',
  });
  const publicEndpoint = (
    await req<{ id: number; apiKey: string; hasApiKey: boolean }[]>('GET', '/api/endpoints')
  ).find((candidate) => candidate.id === endpoint.id)!;
  assert(
    publicEndpoint.apiKey === '' && publicEndpoint.hasApiKey,
    'endpoint API responses redact stored secrets',
  );
  const models = await req<string[]>('GET', `/api/endpoints/${endpoint.id}/models`);
  assert(models.includes('mock-large'), 'model list fetched from upstream');
  const modelAuthorization = async () =>
    (
      (await (await fetch(`${MOCK_CONTROL}/control/last-model-authorization`)).json()) as {
        authorization: string | null;
      }
    ).authorization;
  assert(
    (await modelAuthorization()) === 'Bearer test-key',
    'model fetch sends the configured key',
  );
  const sameAuthorityUrl = new URL(MOCK_URL);
  sameAuthorityUrl.pathname = '/alt/v1';
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { baseUrl: sameAuthorityUrl.toString() });
  await req<string[]>('GET', `/api/endpoints/${endpoint.id}/models`);
  assert(
    (await modelAuthorization()) === 'Bearer test-key',
    'same-authority endpoint path edits preserve the stored key',
  );
  const retargetedUrl = new URL(sameAuthorityUrl);
  retargetedUrl.hostname = retargetedUrl.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { baseUrl: retargetedUrl.toString() });
  await req<string[]>('GET', `/api/endpoints/${endpoint.id}/models`);
  const retargetedEndpoint = (
    await req<{ id: number; hasApiKey: boolean }[]>('GET', '/api/endpoints')
  ).find((candidate) => candidate.id === endpoint.id)!;
  assert(
    !retargetedEndpoint.hasApiKey && (await modelAuthorization()) === null,
    'retargeting endpoint authority clears the hidden key before model fetch',
  );
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { baseUrl: MOCK_URL, apiKey: 'test-key' });
  await req('PATCH', `/api/endpoints/${endpoint.id}`, { model: 'mock-large' });
  await req('PATCH', `/api/endpoints/${endpoint.id}`, {
    genParams: { reasoningEffort: 'high' },
  });
  await req('PATCH', `/api/endpoints/${endpoint.id}`, {
    genParams: { maxTokens: 321 },
  });
  const endpointAfterPartialParams = (
    await req<{ id: number; genParams: { reasoningEffort?: string; maxTokens?: number } }[]>(
      'GET',
      '/api/endpoints',
    )
  ).find((candidate) => candidate.id === endpoint.id)!;
  assert(
    endpointAfterPartialParams.genParams.reasoningEffort === 'high' &&
      endpointAfterPartialParams.genParams.maxTokens === 321,
    'partial endpoint generation-parameter PATCH preserves unspecified keys',
  );
  await req('PATCH', `/api/endpoints/${endpoint.id}`, {
    genParams: {},
    replaceGenParams: true,
  });
  const endpointAfterClearingParams = (
    await req<{ id: number; genParams: GenParams }[]>('GET', '/api/endpoints')
  ).find((candidate) => candidate.id === endpoint.id)!;
  assert(
    Object.keys(endpointAfterClearingParams.genParams).length === 0,
    'the first-party replacement marker persists omitted generation parameters',
  );
  await req('PATCH', `/api/endpoints/${endpoint.id}`, {
    genParams: { reasoningEffort: 'high', maxTokens: 321 },
    replaceGenParams: true,
  });
  await expectStatus(
    'PATCH',
    `/api/endpoints/${endpoint.id}`,
    { genParams: { reasoningEffort: 'extreme' } },
    400,
  );

  console.log('== endpoint duplicate carries the secret key ==');
  const endpointCopy = await req<{
    id: number;
    name: string;
    apiKey: string;
    hasApiKey: boolean;
    model: string | null;
  }>('POST', `/api/endpoints/${endpoint.id}/duplicate`);
  assert(
    endpointCopy.name === 'mock (copy)' &&
      endpointCopy.apiKey === '' &&
      endpointCopy.hasApiKey &&
      endpointCopy.model === 'mock-large',
    'endpoint duplicate copies fields and redacts the copied secret',
  );
  await req<string[]>('GET', `/api/endpoints/${endpointCopy.id}/models`);
  assert(
    (await modelAuthorization()) === 'Bearer test-key',
    'duplicated endpoint fetches models with the copied key',
  );
  await req('DELETE', `/api/endpoints/${endpointCopy.id}`);

  await putSettings({ activeEndpointId: endpoint.id });

  console.log('== private persistence + online backup ==');
  const dataDir = process.env.DATA_DIR!;
  for (const path of [dataDir, join(dataDir, 'tinytavern.db')]) {
    assert((statSync(path).mode & 0o077) === 0, `${path} is private to the server user`);
  }
  assert(
    !existsSync(join(dataDir, 'tinytavern.db-wal')) &&
      !existsSync(join(dataDir, 'tinytavern.db-shm')),
    'rollback journaling creates no persistent WAL or shared-memory files',
  );
  const backupPath = join('/tmp', `tinytavern-e2e-backup-${randomUUID()}.db`);
  execFileSync('node', ['server/src/backup.ts', backupPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'pipe',
  });
  try {
    assert((statSync(backupPath).mode & 0o077) === 0, 'online backup file is mode 0600');
    const live = new DatabaseSync(join(dataDir, 'tinytavern.db'), { readOnly: true });
    const snapshot = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const liveEndpoints = (
        live.prepare('SELECT count(*) AS n FROM endpoints').get() as { n: number }
      ).n;
      const backupEndpoints = (
        snapshot.prepare('SELECT count(*) AS n FROM endpoints').get() as { n: number }
      ).n;
      const integrity = snapshot.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      };
      assert(
        liveEndpoints === backupEndpoints && integrity.integrity_check === 'ok',
        'online backup is a complete, valid SQLite snapshot while the server is running',
      );
    } finally {
      live.close();
      snapshot.close();
    }
  } finally {
    unlinkSync(backupPath);
  }

  console.log('== shared settings reject stale device writes ==');
  const settingsBase = await req<Settings>('GET', '/api/settings');
  await req<Settings>('PUT', '/api/settings', {
    autoExpandThinking: true,
    expectedRevision: settingsBase.revision,
  });
  await expectStatus(
    'PUT',
    '/api/settings',
    { autoExpandThinking: false, expectedRevision: settingsBase.revision },
    409,
  );
  await putSettings({ autoExpandThinking: false });

  console.log('== persona + preset + macro substitution ==');
  const persona = await req<{ id: number }>('POST', '/api/personas', {
    name: 'Aiki',
    description: 'A performance-obsessed developer.',
  });
  const preset = await req<{ id: number }>('POST', '/api/presets', {
    name: 'Test preset',
    content: 'You are {{char}} speaking with {{user}}.',
  });
  await putSettings({ defaultPersonaId: persona.id, defaultPresetId: preset.id });

  console.log('== stale defaults and request validation ==');
  const disposablePersona = await req<{ id: number }>('POST', '/api/personas', {
    name: 'Disposable default',
  });
  await putSettings({ defaultPersonaId: disposablePersona.id });
  await req('DELETE', `/api/personas/${disposablePersona.id}`);
  const settingsAfterDelete = await req<{ defaultPersonaId: number | null }>(
    'GET',
    '/api/settings',
  );
  assert(
    settingsAfterDelete.defaultPersonaId === null,
    'deleting a default persona clears settings',
  );
  const noPersonaConv = await req<{ personaId: number | null }>('POST', '/api/conversations', {});
  assert(
    noPersonaConv.personaId === null,
    'conversation creation survives a deleted default persona',
  );
  await putSettings({ defaultPersonaId: persona.id });
  await expectStatus('PATCH', `/api/personas/${persona.id}`, { name: '   ' }, 400);
  await expectStatus(
    'PUT',
    '/api/settings',
    {
      defaultPersonaId: 999999999,
      expectedRevision: (await req<Settings>('GET', '/api/settings')).revision,
    },
    400,
  );
  const withImageSettings = await putSettings({
    imageGeneration: { describePrompt: 'test prompt' },
  });
  assert(
    (withImageSettings.imageGeneration as { describePrompt?: string }).describePrompt ===
      'test prompt',
    'image settings round-trip through PUT /api/settings',
  );
  await expectStatus(
    'PUT',
    '/api/settings',
    { imageGeneration: 'nope', expectedRevision: withImageSettings.revision },
    400,
  );

  return { endpoint, dataDir, persona };
}

export type SetupFixture = Awaited<ReturnType<typeof testSetup>>;
