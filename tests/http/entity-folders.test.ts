import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { ENTITY_FOLDERS, transferDocument, type GalleryItem } from '@tinytavern/shared';
import { testApi } from '../support/http.ts';
import { conversationFixture } from '../support/fixtures.ts';

test('entity folders preserve contents and transfer by name with atomic imports', async () => {
  await import('../../server/src/routes/entityFolders.ts');
  await import('../../server/src/routes/presets.ts');
  await import('../../server/src/routes/templates.ts');
  await import('../../server/src/routes/personas.ts');
  await import('../../server/src/routes/endpoints.ts');
  await import('../../server/src/routes/characters.ts');
  await import('../../server/src/routes/gallery.ts');
  const { stmt } = await import('../../server/src/db/db.ts');
  const conversation = conversationFixture();
  const { server, request, base } = await testApi();
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

    const galleryFolder = await request('POST', '/api/gallery-folders', { name: 'Scenes' });
    const destination = await request('POST', '/api/gallery-folders', { name: 'Keep' });
    const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
    const upload = async (folder = '') => {
      const response = await fetch(`${base}/api/gallery/upload${folder}`, {
        method: 'POST',
        body: makePlaceholderPng(),
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<GalleryItem>;
    };
    const images = [await upload(`?folderId=${galleryFolder.id}`), await upload()];
    const uploadsFolder = (await request('GET', '/api/gallery-folders')).find(
      (folder: { name: string }) => folder.name === 'Uploads',
    );
    assert(uploadsFolder, 'Default uploads create an Uploads folder');
    assert.deepEqual(
      images.map((item) => item.folderId),
      [galleryFolder.id, uploadsFolder.id],
    );
    assert.equal(images[1]!.characterName, '');
    assert.deepEqual(images[1]!.characters, [], 'Uploads are not a character association');
    const repeated = await upload();
    assert.equal(repeated.folderId, uploadsFolder.id, 'Default uploads reuse the same folder');
    const root = await upload('?folderId=root');
    assert.equal(root.folderId, null, 'An explicitly selected root overrides the default folder');
    await request('DELETE', `/api/gallery/${repeated.id}`, undefined, 204);
    await request('DELETE', `/api/gallery/${root.id}`, undefined, 204);
    const owners = stmt("SELECT * FROM media_owners WHERE owner_type = 'gallery'").all();
    const move = (
      folderId: number | null,
      expected: Pick<GalleryItem, 'id' | 'folderId'>[] = images,
    ) => ({
      folderId,
      items: expected.map((item) => ({ id: item.id, expectedFolderId: item.folderId })),
    });
    await request('POST', '/api/gallery/move', move(999999), 400);
    await request('POST', '/api/gallery/move', move(destination.id));
    const moved = await request('GET', '/api/gallery');
    assert(moved.every((item: { folderId: number }) => item.folderId === destination.id));
    await request(
      'POST',
      '/api/gallery/move',
      move(null, [moved[0], { ...moved[1], folderId: null }]),
      409,
    );
    assert.deepEqual(
      await request('GET', '/api/gallery'),
      moved,
      'A stale bulk move changes nothing',
    );
    await request(
      'POST',
      '/api/gallery/move',
      move(null, [moved[0], { id: 999999, folderId: null }]),
      404,
    );
    const detail = moved[0];
    const details = {
      prompt: 'Filed and edited together',
      characterIds: [],
      folderId: null,
      expectedPrompt: detail.prompt,
      expectedCharacterIds: detail.characters.map((character: { id: number }) => character.id),
      expectedFolderId: detail.folderId,
    };
    const edited = await request('PATCH', `/api/gallery/${detail.id}`, details);
    assert.equal(edited.folderId, null);
    assert.equal(edited.prompt, details.prompt);
    await request(
      'PATCH',
      `/api/gallery/${detail.id}`,
      {
        ...details,
        prompt: 'Must not overwrite',
        expectedPrompt: edited.prompt,
      },
      409,
    );
    await request(
      'PATCH',
      `/api/gallery/${detail.id}`,
      {
        ...details,
        folderId: 999999,
        expectedFolderId: null,
        expectedPrompt: edited.prompt,
      },
      400,
    );
    assert.equal(
      (await request('GET', '/api/gallery')).find((item: GalleryItem) => item.id === detail.id)
        .prompt,
      edited.prompt,
    );
    await request('PATCH', `/api/gallery-folders/${destination.id}`, { name: 'Selected' });
    await request('DELETE', `/api/gallery-folders/${destination.id}`, undefined, 204);
    const rooted = await request('GET', '/api/gallery');
    assert(rooted.every((item: { folderId: number | null }) => item.folderId === null));
    assert.deepEqual(
      stmt("SELECT * FROM media_owners WHERE owner_type = 'gallery'").all(),
      owners,
      'Moving items and deleting folders preserve media ownership',
    );

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
