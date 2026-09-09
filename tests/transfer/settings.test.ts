import assert from 'node:assert/strict';
import { test } from 'node:test';

test('settings transfer', async () => {
  const { createServer } = await import('node:http');

  const { once } = await import('node:events');

  const {
    DEFAULT_SETTINGS,
    defaultMediaPrompt,
    defaultChatMediaPrompt,
    transferDocument,
    transferData,
    namedItem,
    exportRendering,
    importRendering,
    exportPromptCollection,
    importPromptCollection,
  } = await import('@tinytavern/shared');
  type Settings = import('@tinytavern/shared').Settings;
  type MediaWorkflow = import('@tinytavern/shared').MediaWorkflow;
  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  assert.throws(
    () => transferData(transferDocument('page:chatVideoPrompts', {}), 'page:galleryVideoPrompts'),
    /not/,
  );
  assert.equal(namedItem([{ name: 'Style' }, { name: 'STYLE' }], 'style'), undefined);
  assert.equal(namedItem([{ name: 'Style' }, { name: 'STYLE' }], 'Style')?.name, 'Style');
  const settings: Settings = clone(DEFAULT_SETTINGS);
  settings.chatVideoPrompts = {
    presets: [
      {
        id: 'chat-local',
        name: 'Cinematic',
        operation: 'video',
        chatPrompt: defaultChatMediaPrompt('video'),
      },
    ],
    defaults: { video: 'chat-local' },
  };
  settings.galleryVideoPrompts = {
    presets: [
      {
        ...defaultMediaPrompt('video'),
        id: 'gallery-local',
        name: 'Cinematic',
        operation: 'video',
      },
    ],
    defaults: { video: 'gallery-local' },
  };
  const workflow: MediaWorkflow = {
    id: 'local-workflow',
    name: 'Fast',
    operation: 'video',
    referenceCount: 0,
    json: '{"1":{"class_type":"Test","inputs":{"text":"{{prompt}}","seed":{{seed}}}}}',
    chatPromptPresetId: 'chat-local',
    galleryPromptPresetId: 'gallery-local',
  };
  settings.mediaRendering = {
    ...settings.mediaRendering,
    workflows: [workflow],
    defaults: { 'video:0': workflow.id },
  };
  const exported = exportRendering(settings);
  assert(!JSON.stringify(exported).includes('chat-local'));
  assert(!JSON.stringify(exported).includes('local-workflow'));
  const imported = importRendering(exported, settings);
  assert.deepEqual(imported, settings.mediaRendering);
  const unmatched = clone(exported);
  unmatched.workflows[0]!.chatPromptPreset = 'Not installed';
  unmatched.defaults['video:0'] = 'Not installed';
  assert.equal(importRendering(unmatched, settings).workflows[0]!.chatPromptPresetId, 'chat-local');
  assert.equal(importRendering(unmatched, settings).defaults['video:0'], 'local-workflow');
  const promptFile = exportPromptCollection(settings.chatVideoPrompts);
  promptFile.presets[0] = { ...promptFile.presets[0]!, chatPrompt: 'Imported chat instructions' };
  const chat = importPromptCollection(promptFile, settings.chatVideoPrompts, true, true);
  assert.equal(chat.presets[0]!.id, 'chat-local');
  assert.equal(settings.galleryVideoPrompts.presets[0]!.name, 'Cinematic');
  assert(!JSON.stringify(chat).includes('systemPrompt'));
  assert(!JSON.stringify(settings.galleryVideoPrompts).includes('chatPrompt'));

  const { stmt } = await import('../../server/src/db.ts');
  const { getSettings, putSettings } = await import('../../server/src/settingsStore.ts');
  const { dispatch } = await import('../../server/src/router.ts');
  await import('../../server/src/routes/templates.ts');
  await import('../../server/src/routes/presets.ts');
  await import('../../server/src/routes/personas.ts');
  await import('../../server/src/routes/endpoints.ts');
  await import('../../server/src/routes/characters.ts');
  await import('../../server/src/routes/settings.ts');
  const { makePlaceholderPng, parseCharacterCard } = await import('../../server/src/pngCard.ts');
  const { readAvatarFile } = await import('../../server/src/routes/avatarStore.ts');
  const server = createServer(
    (req, res) =>
      void dispatch(req, res, new URL(req.url!, 'http://test').pathname).then((found) => {
        if (!found) res.writeHead(404).end();
      }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function request(method: string, path: string, body?: unknown, status = 200): Promise<any> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  try {
    const original = getSettings();
    let saved = await request('PUT', '/api/settings', {
      expectedRevision: original.revision,
      chatVideoPrompts: settings.chatVideoPrompts,
      galleryVideoPrompts: settings.galleryVideoPrompts,
      mediaRendering: settings.mediaRendering,
    });
    saved = await request('PUT', '/api/settings', {
      expectedRevision: saved.revision,
      chatVideoPrompts: chat,
    });
    assert.deepEqual(saved.galleryVideoPrompts, settings.galleryVideoPrompts);
    assert.equal(saved.mediaRendering.workflows[0].galleryPromptPresetId, 'gallery-local');
    await request(
      'PUT',
      '/api/settings',
      { expectedRevision: saved.revision, chatVideoPrompts: settings.galleryVideoPrompts },
      400,
    );
    assert.deepEqual(getSettings().galleryVideoPrompts, settings.galleryVideoPrompts);

    const template = await request('POST', '/api/templates', {
      name: 'Transfer template',
      content: 'Before',
    });
    let page = await request('GET', '/api/templates/settings-export');
    assert(!JSON.stringify(page.document).includes('createdAt'));
    const data = {
      items: [
        { name: 'Transfer template', content: 'After' },
        { name: 'New template', content: 'New' },
      ],
      active: 'Not installed',
    };
    const activeBefore = getSettings().defaultTemplateId;
    const result = await request('POST', '/api/templates/settings-import', {
      document: transferDocument('page:templates', data),
      expectedSnapshot: page.snapshot,
    });
    assert.equal(result[0].id, template.id);
    assert.equal(getSettings().defaultTemplateId, activeBefore);
    page = await request('GET', '/api/templates/settings-export');
    const count = Number(stmt('SELECT count(*) AS n FROM templates').get()!.n);
    await request(
      'POST',
      '/api/templates/settings-import',
      {
        document: transferDocument('page:templates', {
          items: [{ name: 'First valid' }, { name: 'Invalid', prefixNames: 'yes' }],
        }),
        expectedSnapshot: page.snapshot,
      },
      400,
    );
    assert.equal(Number(stmt('SELECT count(*) AS n FROM templates').get()!.n), count);
    const protectedTemplate = (await request('GET', '/api/templates')).find(
      (item: any) => item.readOnly,
    );
    const copies = await request('POST', '/api/templates/settings-import', {
      document: transferDocument('page:templates', {
        items: [{ name: protectedTemplate.name, content: 'Imported editable default' }],
        active: protectedTemplate.name,
      }),
      expectedSnapshot: page.snapshot,
    });
    assert(!copies[0].readOnly);
    assert.notEqual(copies[0].id, protectedTemplate.id);
    assert.equal(getSettings().defaultTemplateId, copies[0].id);
    await request(
      'POST',
      '/api/templates/settings-import',
      { document: page.document, expectedSnapshot: page.snapshot },
      409,
    );

    const avatar = makePlaceholderPng();
    const personas = await request('POST', '/api/personas/settings-import', {
      targetId: null,
      document: transferDocument('entity:personas', {
        name: 'Portable persona',
        description: 'Description',
        avatarData: `data:image/png;base64,${avatar.toString('base64')}`,
      }),
    });
    assert.deepEqual(readAvatarFile('persona', personas[0].id), avatar);
    const personaPage = await request('GET', '/api/personas/settings-export');
    assert.equal(
      personaPage.document.data.items[0].avatarData,
      `data:image/png;base64,${avatar.toString('base64')}`,
    );

    const endpoint = await request('POST', '/api/endpoints', {
      name: 'Portable endpoint',
      baseUrl: 'http://endpoint.invalid/v1',
      apiKey: 'private-credential',
    });
    const endpoints = await request('GET', '/api/endpoints/settings-export');
    assert(!JSON.stringify(endpoints.document).includes('private-credential'));
    await request('POST', '/api/endpoints/settings-import', {
      expectedSnapshot: endpoints.snapshot,
      document: endpoints.document,
    });
    assert.equal(
      stmt('SELECT api_key FROM endpoints WHERE id = ?').get(endpoint.id)!.api_key,
      'private-credential',
    );

    const preset = await request('POST', '/api/presets', {
      name: 'Linked prompt',
      content: 'System text',
    });
    const character = await request('POST', '/api/characters', {
      name: 'Linked character',
      presetId: preset.id,
      templateId: template.id,
      disableBackgroundSwipeGeneration: true,
    });
    const png = Buffer.from(
      await (await fetch(`${base}/api/characters/${character.id}/card`)).arrayBuffer(),
    );
    const card = parseCharacterCard(png);
    assert(JSON.stringify(card.raw).includes('Linked prompt'));
    const cardResponse = await fetch(`${base}/api/characters/import-card`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: png,
    });
    assert.equal(cardResponse.status, 200);
    const importedCharacter = (await cardResponse.json()) as any;
    assert.equal(importedCharacter.presetId, preset.id);
    assert.equal(importedCharacter.templateId, template.id);
    assert.equal(importedCharacter.disableBackgroundSwipeGeneration, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
