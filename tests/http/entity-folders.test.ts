import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { ENTITY_FOLDERS, transferDocument } from '@tinytavern/shared';
import { testApi } from '../support/http.ts';
import { conversationFixture } from '../support/fixtures.ts';

test('entity folders preserve contents and transfer by name with atomic imports', async () => {
  await import('../../server/src/routes/entityFolders.ts');
  await import('../../server/src/routes/presets.ts');
  await import('../../server/src/routes/templates.ts');
  await import('../../server/src/routes/personas.ts');
  await import('../../server/src/routes/endpoints.ts');
  await import('../../server/src/routes/characters.ts');
  const { stmt } = await import('../../server/src/db/db.ts');
  const conversation = conversationFixture();
  const { server, request } = await testApi();
  try {
    for (const type of ['characters', 'presets', 'templates', 'personas', 'endpoints'] as const) {
      const folderPath = `/api/${ENTITY_FOLDERS[type].path}`;
      const folder = await request('POST', folderPath, { name: 'Writing' });
      await request('POST', folderPath, { name: 'writing' }, 409);
      const item = await request('POST', `/api/${type}`, {
        name: `Folder ${type}`,
        folderId: folder.id,
        ...(type === 'endpoints' ? { baseUrl: 'http://unused.invalid/v1' } : {}),
      });
      assert.equal(item.folderId, folder.id);
      const copy = await request('POST', `/api/${type}/${item.id}/duplicate`);
      assert.equal(copy.folderId, folder.id);
      await request('PATCH', `/api/${type}/${item.id}`, { folderId: 999999 }, 400);
      await request('PATCH', `/api/${type}/${item.id}`, { folderId: null });
      assert.equal(
        stmt('SELECT mutation_revision FROM conversations WHERE id=?').get(conversation)!
          .mutation_revision,
        0,
        'Organizing folders does not invalidate chat generations',
      );
      await request('PATCH', `${folderPath}/${folder.id}`, { name: 'Renamed' });
      assert.equal((await request('GET', folderPath))[0].name, 'Renamed');
      await request('DELETE', `${folderPath}/${folder.id}`, undefined, 204);
      const items = await request('GET', `/api/${type}`);
      assert.equal(items.find((row: { id: number }) => row.id === copy.id).folderId, null);
    }

    const folder = await request('POST', '/api/preset-folders', { name: 'Portable' });
    await request('POST', '/api/preset-folders', { name: 'Empty' });
    const preset = await request('POST', '/api/presets', {
      name: 'Portable style',
      folderId: folder.id,
    });
    const exported = await request('GET', '/api/presets/settings-export');
    assert.equal(
      exported.document.data.items.find((item: { name: string }) => item.name === preset.name)
        .folderId,
      'Portable',
    );
    await request('PATCH', `/api/preset-folders/${folder.id}`, { name: 'Changed' });
    await request(
      'POST',
      '/api/presets/settings-import',
      { document: exported.document, expectedSnapshot: exported.snapshot },
      409,
    );
    for (const row of await request('GET', '/api/preset-folders'))
      await request('DELETE', `/api/preset-folders/${row.id}`, undefined, 204);
    const current = await request('GET', '/api/presets/settings-export');
    const imported = await request('POST', '/api/presets/settings-import', {
      document: exported.document,
      expectedSnapshot: current.snapshot,
    });
    const folders = await request('GET', '/api/preset-folders');
    const restored = imported.find((item: { id: number }) => item.id === preset.id);
    assert.equal(
      restored.folderId,
      folders.find((item: { name: string }) => item.name === 'Portable').id,
    );
    assert.notEqual(restored.folderId, folder.id);
    assert(folders.some((item: { name: string }) => item.name === 'Empty'));
    const before = await request('GET', '/api/presets/settings-export');
    for (const items of [
      [
        { name: 'Would create', folderId: 'New folder' },
        { name: 'Invalid', content: 42 },
      ],
      [{ name: 'Foreign ID', folderId: restored.folderId }],
    ]) {
      await request(
        'POST',
        '/api/presets/settings-import',
        {
          document: transferDocument('page:presets', { items }),
          expectedSnapshot: before.snapshot,
        },
        400,
      );
      assert.equal(
        (await request('GET', '/api/presets/settings-export')).snapshot,
        before.snapshot,
      );
    }
    assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
  } finally {
    await server.stop(true);
  }
});
