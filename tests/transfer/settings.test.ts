import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { testApi } from '../support/http.ts';

test('settings transfer', async () => {
  const {
    DEFAULT_SETTINGS,
    defaultMediaPrompt,
    defaultChatMediaPrompt,
    transferDocument,
    transferData,
    namedItem,
    exportRendering,
    importRendering,
    exportWorkflowLibrary,
    importWorkflowLibrary,
    exportPromptCollection,
    importPromptCollection,
    importImagePromptSet,
    exportMediaFavorites,
    importMediaFavorites,
    exportGenerationSettings,
    importGenerationSettings,
  } = await import('@tinytavern/shared');
  type Settings = import('@tinytavern/shared').Settings;
  type MediaWorkflow = import('@tinytavern/shared').MediaWorkflow;
  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  assert.throws(
    () =>
      transferData(transferDocument('page:mediaChatPrompts', {}), 'page:mediaStandalonePrompts'),
    /not/,
  );
  assert.equal(namedItem([{ name: 'Style' }, { name: 'STYLE' }], 'style'), undefined);
  assert.equal(namedItem([{ name: 'Style' }, { name: 'STYLE' }], 'Style')?.name, 'Style');
  const { parseImageGenerationSettings } = await import('../../server/src/media/imageSettings.ts');
  const portrait = { name: 'Portrait', prompt: 'Paint a portrait', context: '{{description}}' };
  const imageSet = { presets: [portrait], active: portrait.name };
  assert.deepEqual(importImagePromptSet(imageSet, { presets: [], active: '' }, true), imageSet);
  const references = {
    presets: [{ name: 'Reference style', prompt: '{{instruction}}: {{input1_prompt}}' }],
    active: 'Reference style',
  };
  assert.throws(
    () => parseImageGenerationSettings({ promptPresets: { references } }),
    /media prompt library/,
  );
  for (const presets of [
    [{ ...portrait, context: ' ' }],
    [{ ...portrait, name: 'Default' }],
    [portrait, { ...portrait, name: 'portrait' }],
  ]) {
    const invalid = { presets, active: portrait.name };
    assert.throws(() => importImagePromptSet(invalid, imageSet, true));
  }
  const settings: Settings = clone(DEFAULT_SETTINGS);
  settings.mediaChatPrompts = {
    folders: [],
    presets: [
      {
        id: 'chat-local',
        name: 'Cinematic',
        chatPrompt: defaultChatMediaPrompt(),
      },
    ],
    defaultPresetId: 'chat-local',
  };
  settings.mediaStandalonePrompts = {
    folders: [],
    presets: [
      {
        ...defaultMediaPrompt(),
        id: 'gallery-local',
        name: 'Cinematic',
      },
    ],
    defaultPresetId: 'gallery-local',
  };
  const workflow: MediaWorkflow = {
    id: 'local-workflow',
    name: 'Fast',
    inputBindings: {},
    textOutputNodeId: null,
    json: '{"1":{"class_type":"Test","inputs":{"text":"{{prompt}}","seed":{{seed}}}}}',
    chatPromptPresetId: 'chat-local',
    standalonePromptPresetId: 'gallery-local',
  };
  settings.mediaRendering = {
    ...settings.mediaRendering,
    workflows: [workflow],
    folders: [{ id: 'folder-local', name: 'Images', workflowIds: [workflow.id] }],
    defaultWorkflowId: workflow.id,
  };
  const exported = exportRendering(settings);
  assert(!JSON.stringify(exported).includes('chat-local'));
  assert(!JSON.stringify(exported).includes('local-workflow'));
  const imported = importRendering(exported, settings);
  assert.deepEqual(imported, settings.mediaRendering);
  const ordered = clone(settings);
  ordered.mediaRendering.shortcuts = ['One', 'Two', 'Keep'].map((name, index) => ({
    id: String(index),
    name,
    workflowId: workflow.id,
  }));
  ordered.mediaFavorites = ordered.mediaRendering.shortcuts.map((item) => ({
    ...item,
    presetId: 'chat-local',
  }));
  const renderingOrder = exportRendering(ordered);
  renderingOrder.shortcuts = renderingOrder.shortcuts.slice(0, 2).reverse();
  assert.deepEqual(
    importRendering(renderingOrder, ordered).shortcuts.map((item) => item.id),
    ['1', '0', '2'],
  );
  const favoriteOrder = exportMediaFavorites(ordered).slice(0, 2).reverse();
  assert.deepEqual(
    importMediaFavorites(favoriteOrder, ordered).map((item) => item.id),
    ['1', '0', '2'],
  );
  ordered.mediaRendering.shortcuts.forEach((item) => {
    item.name = 'Repeated';
  });
  ordered.mediaFavorites.forEach((item) => {
    item.name = 'Repeated';
  });
  ordered.imageGeneration = {
    promptRevisionTemplate: 'Revise: {{instruction}}',
    promptRevisionContext: 'Context: {{description}}',
    promptRevisionOriginal: 'Original: {{prompt}}',
    promptPresets: { avatar: imageSet },
  };
  const generationFile = exportGenerationSettings(ordered);
  assert.deepEqual(
    importGenerationSettings(generationFile, ordered),
    {
      mediaRendering: ordered.mediaRendering,
      mediaFavorites: ordered.mediaFavorites,
      imageGeneration: ordered.imageGeneration,
    },
    'Generation page includes image prompts, selected avatar preset and repeated favorites/shortcuts',
  );
  const otherInstallation = clone(settings);
  otherInstallation.mediaRendering.workflows[0]!.id = 'remote-workflow';
  otherInstallation.mediaRendering.folders[0]!.workflowIds = ['remote-workflow'];
  otherInstallation.mediaRendering.defaultWorkflowId = 'remote-workflow';
  otherInstallation.mediaChatPrompts.presets[0]!.id = 'remote-preset';
  const copiedGeneration = importGenerationSettings(generationFile, otherInstallation);
  assert.deepEqual(copiedGeneration.imageGeneration, ordered.imageGeneration);
  assert.equal(copiedGeneration.mediaFavorites.length, 3);
  assert.equal(new Set(copiedGeneration.mediaFavorites.map((item) => item.id)).size, 3);
  assert.equal(new Set(copiedGeneration.mediaRendering.shortcuts.map((item) => item.id)).size, 3);
  assert(
    copiedGeneration.mediaFavorites.every(
      (item) => item.workflowId === 'remote-workflow' && item.presetId === 'remote-preset',
    ),
  );
  assert(
    copiedGeneration.mediaRendering.shortcuts.every(
      (item) => item.workflowId === 'remote-workflow',
    ),
  );
  const legacyGeneration = importGenerationSettings(exportRendering(settings), ordered);
  assert.deepEqual(legacyGeneration.imageGeneration, ordered.imageGeneration);
  assert.deepEqual(legacyGeneration.mediaFavorites, ordered.mediaFavorites);
  const beforeFailedImport = clone(otherInstallation);
  assert.throws(
    () =>
      importGenerationSettings(
        {
          ...generationFile,
          imageGeneration: {
            promptPresets: {
              avatar: { presets: [{ ...portrait, context: '' }], active: 'Portrait' },
            },
          },
        },
        otherInstallation,
      ),
    /context/,
  );
  assert.deepEqual(
    otherInstallation,
    beforeFailedImport,
    'Validation does not partially import rendering or favorites',
  );
  assert(!JSON.stringify(exported).includes('folder-local'));
  const library = exportWorkflowLibrary(settings);
  const destination = clone(settings);
  destination.mediaRendering.workflows[0]!.id = 'destination-workflow';
  destination.mediaRendering.folders = [
    { id: 'destination-folder', name: 'Images', workflowIds: [] },
  ];
  const transferred = importWorkflowLibrary(library, destination);
  assert.equal(transferred.workflows[0]!.id, 'destination-workflow');
  assert.deepEqual(transferred.folders, [
    { id: 'destination-folder', name: 'Images', workflowIds: ['destination-workflow'] },
  ]);
  const rootImport = importWorkflowLibrary({ ...library, folders: [] }, settings);
  assert.deepEqual(rootImport.folders[0]!.workflowIds, []);
  assert.deepEqual(
    importWorkflowLibrary({ workflows: library.workflows }, settings).folders,
    settings.mediaRendering.folders,
    'Older exports preserve folder membership',
  );
  for (const folders of [
    [{ name: 'Unknown', workflows: ['Missing workflow'] }],
    [
      { name: 'Images', workflows: ['Fast'] },
      { name: 'Other', workflows: ['Fast'] },
    ],
  ])
    assert.throws(() => importWorkflowLibrary({ ...library, folders }, settings));
  assert.deepEqual(
    settings.mediaRendering.folders[0]!.workflowIds,
    [workflow.id],
    'Import validation never mutates source settings',
  );
  const unmatched = clone(exported);
  unmatched.workflows[0]!.chatPromptPreset = 'Not installed';
  unmatched.defaultWorkflow = 'Not installed';
  assert.equal(importRendering(unmatched, settings).workflows[0]!.chatPromptPresetId, 'chat-local');
  assert.equal(importRendering(unmatched, settings).defaultWorkflowId, 'local-workflow');
  for (const [collection, isChat] of [
    [settings.mediaChatPrompts, true],
    [settings.mediaStandalonePrompts, false],
  ] as const) {
    const presetId = collection.presets[0]!.id;
    collection.folders = [{ id: 'local-prompt-folder', name: 'Favorites', presetIds: [presetId] }];
    const portable = exportPromptCollection(collection);
    assert(!JSON.stringify(portable).includes(presetId));
    assert(!JSON.stringify(portable).includes('local-prompt-folder'));
    const destination = {
      ...collection,
      presets: [{ ...collection.presets[0]!, id: 'destination' }],
      folders: [{ id: 'destination-folder', name: 'Favorites', presetIds: [] }],
      defaultPresetId: 'destination',
    };
    const imported = importPromptCollection(portable, destination, isChat);
    assert.deepEqual(imported.folders, [
      { id: 'destination-folder', name: 'Favorites', presetIds: ['destination'] },
    ]);
    assert.equal(imported.defaultPresetId, 'destination');
    assert.throws(() =>
      importPromptCollection(
        { ...portable, folders: [{ name: 'Broken', presets: ['Missing'] }] },
        collection,
        isChat,
      ),
    );
    assert.deepEqual(collection.folders[0]!.presetIds, [presetId]);
  }
  const promptFile = exportPromptCollection(settings.mediaChatPrompts);
  promptFile.presets[0] = { ...promptFile.presets[0]!, chatPrompt: 'Imported chat instructions' };
  const chat = importPromptCollection(promptFile, settings.mediaChatPrompts, true);
  assert.equal(chat.presets[0]!.id, 'chat-local');
  assert.equal(settings.mediaStandalonePrompts.presets[0]!.name, 'Cinematic');
  assert(!JSON.stringify(chat).includes('systemPrompt'));
  assert(!JSON.stringify(settings.mediaStandalonePrompts).includes('chatPrompt'));

  const { stmt } = await import('../../server/src/db/db.ts');
  const { getSettings } = await import('../../server/src/settings/settingsStore.ts');
  await import('../../server/src/routes/templates.ts');
  await import('../../server/src/routes/presets.ts');
  await import('../../server/src/routes/personas.ts');
  await import('../../server/src/routes/endpoints.ts');
  await import('../../server/src/routes/characters.ts');
  await import('../../server/src/routes/settings.ts');
  const { makePlaceholderPng, parseCharacterCard } =
    await import('../../server/src/characters/pngCard.ts');
  const { readAvatarFile } = await import('../../server/src/characters/avatarStore.ts');
  const { server, base, request: send } = await testApi();
  const request = (method: string, path: string, body?: unknown, status = 200) =>
    send(method, path, body, status);
  try {
    const original = getSettings();
    let saved = await request('PUT', '/api/settings', {
      expectedRevision: original.revision,
      mediaChatPrompts: settings.mediaChatPrompts,
      mediaStandalonePrompts: settings.mediaStandalonePrompts,
      mediaRendering: settings.mediaRendering,
      imageGeneration: {
        promptPresets: { avatar: { presets: [portrait], active: 'portrait' } },
      },
    });
    assert.deepEqual(saved.imageGeneration.promptPresets.avatar, imageSet);
    assert.deepEqual(
      getSettings().imageGeneration.promptPresets?.avatar,
      imageSet,
      'The server persists the canonical avatar preset selection returned by validation',
    );
    for (const key of ['mediaChatPrompts', 'mediaStandalonePrompts'] as const) {
      const before = saved[key];
      saved = await request('PUT', '/api/settings', {
        expectedRevision: saved.revision,
        [key]: { ...before, folders: [] },
      });
      assert.deepEqual(
        saved[key].presets,
        before.presets,
        'Deleting a folder preserves its prompts',
      );
      assert.equal(saved[key].defaultPresetId, before.defaultPresetId);
      assert.deepEqual(
        saved.mediaRendering.workflows,
        settings.mediaRendering.workflows,
        'Folder changes preserve workflow references',
      );
      saved = await request('PUT', '/api/settings', {
        expectedRevision: saved.revision,
        [key]: before,
      });
    }
    saved = await request('PUT', '/api/settings', {
      expectedRevision: saved.revision,
      mediaChatPrompts: chat,
    });
    assert.deepEqual(saved.mediaStandalonePrompts, settings.mediaStandalonePrompts);
    assert.equal(saved.mediaRendering.workflows[0].standalonePromptPresetId, 'gallery-local');
    await request(
      'PUT',
      '/api/settings',
      { expectedRevision: saved.revision, mediaChatPrompts: settings.mediaStandalonePrompts },
      400,
    );
    assert.deepEqual(getSettings().mediaStandalonePrompts, settings.mediaStandalonePrompts);
    const favorite = {
      id: 'favorite',
      name: 'Favorite',
      presetId: 'chat-local',
      workflowId: workflow.id,
    };
    saved = await request('PUT', '/api/settings', {
      expectedRevision: saved.revision,
      mediaFavorites: [favorite],
    });
    const { exportMediaFavorites, importMediaFavorites } = await import('@tinytavern/shared');
    const portableFavorites = exportMediaFavorites(getSettings());
    assert.deepEqual(portableFavorites, [
      { name: 'Favorite', promptPreset: 'Cinematic', workflow: 'Fast' },
    ]);
    assert.deepEqual(importMediaFavorites(portableFavorites, getSettings()), [favorite]);
    const withInput = {
      ...workflow,
      json:
        workflow.json.slice(0, -1) +
        ',"load":{"class_type":"LoadImage","inputs":{"image":"source.png"}}}',
    };
    await request(
      'PUT',
      '/api/settings',
      {
        expectedRevision: saved.revision,
        mediaRendering: { ...settings.mediaRendering, workflows: [withInput] },
      },
      400,
    );
    assert.equal(
      getSettings().mediaRendering.workflows[0]!.json,
      workflow.json,
      'Favorite input restrictions reject the whole settings mutation',
    );
    saved = await request('PUT', '/api/settings', {
      expectedRevision: saved.revision,
      mediaChatPrompts: { folders: [], presets: [], defaultPresetId: null },
    });
    assert.deepEqual(saved.mediaFavorites, [], 'Deleting a preset removes its dependent favorites');
    assert.equal(saved.mediaRendering.workflows[0].chatPromptPresetId, null);

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
        items: [
          { name: protectedTemplate.name, content: 'Imported editable default' },
          { name: `${protectedTemplate.name} (imported)`, content: 'Existing portable copy' },
        ],
        active: protectedTemplate.name,
      }),
      expectedSnapshot: page.snapshot,
    });
    assert(!copies[0].readOnly);
    assert.notEqual(copies[0].id, protectedTemplate.id);
    assert.equal(copies[0].name, `${protectedTemplate.name} (imported 2)`);
    assert.equal(copies[1].name, `${protectedTemplate.name} (imported)`);
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
      systemPromptPrefix: 'Prefix\n',
      systemPromptSuffix: '\nSuffix',
      reasoningPrefillPrefix: 'Reasoning\n',
      allowMessagePrefill: false,
    });
    const endpoints = await request('GET', '/api/endpoints/settings-export');
    assert(!JSON.stringify(endpoints.document).includes('private-credential'));
    assert.equal(endpoints.document.data.items[0].systemPromptPrefix, 'Prefix\n');
    assert.equal(endpoints.document.data.items[0].systemPromptSuffix, '\nSuffix');
    assert.equal(endpoints.document.data.items[0].reasoningPrefillPrefix, 'Reasoning\n');
    await request('POST', '/api/endpoints/settings-import', {
      expectedSnapshot: endpoints.snapshot,
      document: endpoints.document,
    });
    assert.equal(
      stmt('SELECT api_key FROM endpoints WHERE id = ?').get(endpoint.id)!.api_key,
      'private-credential',
    );
    const [endpointCopy] = await request('POST', '/api/endpoints/settings-import', {
      targetId: null,
      document: transferDocument('entity:endpoints', {
        ...endpoints.document.data.items[0],
        name: 'Copied endpoint',
      }),
    });
    assert.equal(endpointCopy.systemPromptPrefix, 'Prefix\n');
    assert.equal(endpointCopy.systemPromptSuffix, '\nSuffix');
    assert.equal(endpointCopy.reasoningPrefillPrefix, 'Reasoning\n');
    assert.equal(endpointCopy.allowMessagePrefill, false);
    assert.equal(endpointCopy.allowReasoningPrefill, true);

    const repeatedEndpoint = await request('POST', `/api/endpoints/${endpoint.id}/duplicate`);
    await request('POST', `/api/endpoints/${endpoint.id}/duplicate`);
    await request('POST', '/api/endpoints', {
      name: endpoint.name.toUpperCase(),
      baseUrl: endpoint.baseUrl,
      systemPromptPrefix: 'Case-distinct endpoint',
    });
    await request('PUT', '/api/settings', {
      expectedRevision: getSettings().revision,
      activeEndpointId: repeatedEndpoint.id,
    });
    const repeatedBefore = await request('GET', '/api/endpoints');
    const repeatedPage = await request('GET', '/api/endpoints/settings-export');
    const repeatedImport = await request('POST', '/api/endpoints/settings-import', {
      expectedSnapshot: repeatedPage.snapshot,
      document: repeatedPage.document,
    });
    assert.deepEqual(
      repeatedImport,
      repeatedBefore,
      'Untouched exports retain every occurrence, case-distinct name, local ID and credential',
    );
    assert.equal(
      getSettings().activeEndpointId,
      repeatedEndpoint.id,
      'An ambiguous name must not repoint the active reference',
    );
    assert.equal(
      stmt('SELECT api_key FROM endpoints WHERE id = ?').get(repeatedEndpoint.id)!.api_key,
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
    await server.stop(true);
  }
});
