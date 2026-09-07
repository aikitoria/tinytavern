import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Character, CharacterFolder, Settings } from '@tinytavern/shared';
import {
  BASE,
  assert,
  req,
  expectStatus,
  makeCardPng,
  makeCompressedMetadataBombPng,
  tree,
  pathOf,
} from './helpers.ts';
import type { SetupFixture } from './setup.ts';

export async function testCharacters(fixture: Pick<SetupFixture, 'persona'>) {
  const { persona } = fixture;

  console.log('== one-level character folders ==');
  const characterFolder = await req<CharacterFolder>('POST', '/api/character-folders', {
    name: '  Adventurers  ',
  });
  assert(characterFolder.name === 'Adventurers', 'character folder names are trimmed');
  await expectStatus('POST', '/api/character-folders', { name: 'adventurers' }, 409);
  await expectStatus('POST', '/api/characters', { name: 'Lost', folderId: 999999999 }, 400);
  const folderCharacter = await req<Character>('POST', '/api/characters', {
    name: 'Folder Hero',
    folderId: characterFolder.id,
  });
  assert(
    folderCharacter.folderId === characterFolder.id,
    'a character can be assigned to a folder',
  );
  const renamedFolder = await req<CharacterFolder>(
    'PATCH',
    `/api/character-folders/${characterFolder.id}`,
    { name: 'Heroes' },
  );
  assert(renamedFolder.name === 'Heroes', 'a character folder can be renamed');
  await req('DELETE', `/api/character-folders/${characterFolder.id}`);
  const ungroupedCharacter = (await req<Character[]>('GET', '/api/characters')).find(
    (candidate) => candidate.id === folderCharacter.id,
  );
  assert(
    ungroupedCharacter?.folderId === null,
    'deleting a folder moves its characters back to the root',
  );
  await req('DELETE', `/api/characters/${folderCharacter.id}`);

  console.log('== character card import + greeting seeding ==');
  const bombRes = await fetch(`${BASE}/api/characters/import-card`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(makeCompressedMetadataBombPng()),
  });
  assert(bombRes.status === 400, 'oversized compressed PNG metadata is rejected safely');
  const settingsAfterBomb = await req<Settings>('GET', '/api/settings');
  assert(
    typeof settingsAfterBomb.revision === 'number',
    'server remains responsive after compressed metadata rejection',
  );
  for (const malformedCard of [
    { spec: 'chara_card_v2', data: { name: {} } },
    { spec: 'chara_card_v2', data: { name: 'Bad fields', scenario: 42 } },
    {
      spec: 'chara_card_v2',
      data: { name: 'Bad chat name', extensions: { tinytavern: { chatName: 42 } } },
    },
  ]) {
    const malformedRes = await fetch(`${BASE}/api/characters/import-card`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(makeCardPng(malformedCard)),
    });
    assert(malformedRes.status === 400, 'malformed character-card field types return 400');
  }
  const cardRes = await fetch(`${BASE}/api/characters/import-card`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(makeCardPng()),
  });
  if (!cardRes.ok) throw new Error(`card import failed: ${await cardRes.text()}`);
  const character = (await cardRes.json()) as {
    id: number;
    name: string;
    personality: string;
    scenario: string;
    avatar: string | null;
  };
  assert(character.name === 'Card Imported Hero', 'card name imported');
  assert(
    character.personality.includes('brave') && character.personality.includes('Fearless'),
    'description + personality merged',
  );
  assert(character.avatar != null, 'card PNG stored as avatar');
  const avatarRes = await fetch(`${BASE}${character.avatar}`);
  assert(avatarRes.ok, 'avatar served');

  const charConv = await req<{ id: number; title: string }>('POST', '/api/conversations', {
    characterId: character.id,
  });
  const charSnap = await tree(charConv.id);
  await expectStatus(
    'PATCH',
    `/api/conversations/${charConv.id}`,
    {
      characterId: null,
      expectedActiveLeafId: charSnap.activeLeafId,
      expectedMutationRevision: charSnap.mutationRevision,
    },
    400,
  );
  const greeting = pathOf(charSnap)[0]!;
  assert(
    greeting.role === 'assistant' &&
      greeting.content === 'Greetings, Aiki! I am Card Imported Hero.',
    'first message seeded with macros substituted',
  );
  assert(charConv.title === 'Card Imported Hero', 'conversation titled after character');
  const greetingRoots = charSnap.messages.filter((m) => m.parentId === null);
  assert(greetingRoots.length === 2, 'alternate greeting seeded as root sibling');
  assert(
    greetingRoots.some((m) => m.content === 'Alternate hello, Aiki!'),
    'alternate greeting macros substituted',
  );

  console.log('== character card export round-trip ==');
  const exportRes = await fetch(`${BASE}/api/characters/${character.id}/card`);
  assert(
    exportRes.ok && exportRes.headers.get('content-type') === 'image/png',
    'card export returns PNG',
  );
  const reimportRes = await fetch(`${BASE}/api/characters/import-card`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(await exportRes.arrayBuffer()),
  });
  const reimported = (await reimportRes.json()) as {
    id: number;
    name: string;
    personality: string;
  };
  assert(reimported.name === 'Card Imported Hero', 'exported card reimports with same name');
  assert(reimported.personality.includes('brave'), 'exported card keeps personality text');

  console.log('== character duplicate copies the avatar file ==');
  const characterCopy = await req<{
    id: number;
    name: string;
    personality: string;
    avatar: string | null;
  }>('POST', `/api/characters/${reimported.id}/duplicate`);
  assert(
    characterCopy.name === 'Card Imported Hero (copy)',
    'duplicate appends (copy) to the name',
  );
  assert(characterCopy.personality.includes('brave'), 'duplicate copies entity fields');
  assert(
    characterCopy.avatar != null && characterCopy.avatar.includes(`character-${characterCopy.id}.`),
    'duplicate points at its own avatar file, not the source file',
  );
  await req('DELETE', `/api/characters/${reimported.id}`);
  const copyAvatarRes = await fetch(`${BASE}${characterCopy.avatar}`);
  assert(copyAvatarRes.ok, 'copied avatar survives deleting the source character');
  await req('DELETE', `/api/characters/${characterCopy.id}`);

  await req('PATCH', `/api/characters/${character.id}`, { customPrompt: null });
  const clearedExportRes = await fetch(`${BASE}/api/characters/${character.id}/card`);
  const clearedReimportRes = await fetch(`${BASE}/api/characters/import-card`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(await clearedExportRes.arrayBuffer()),
  });
  if (!clearedReimportRes.ok) {
    throw new Error(`cleared card reimport failed: ${await clearedReimportRes.text()}`);
  }
  const clearedReimported = (await clearedReimportRes.json()) as { customPrompt: string | null };
  assert(
    clearedReimported.customPrompt === null,
    'card export preserves an explicitly cleared imported system prompt',
  );

  console.log('== avatars accept PNG only ==');
  // Magic bytes decide, not the content-type: a renamed JPEG stored as .png
  // would break PNG card export later.
  const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
  const webpBytes = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), Buffer.alloc(48)]);
  const putAvatar = (path: string, body: Uint8Array) =>
    fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    });
  const jpegCharRes = await putAvatar(`/api/characters/${character.id}/avatar`, jpegBytes);
  assert(jpegCharRes.status === 415, 'character avatar upload rejects JPEG magic bytes');
  const webpCharRes = await putAvatar(`/api/characters/${character.id}/avatar`, webpBytes);
  assert(webpCharRes.status === 415, 'character avatar upload rejects WebP magic bytes');
  const pngCharRes = await putAvatar(
    `/api/characters/${character.id}/avatar`,
    new Uint8Array(makeCardPng()),
  );
  assert(pngCharRes.ok, 'character avatar upload accepts a valid PNG');
  const pngChar = (await pngCharRes.json()) as { avatar: string | null };
  assert(pngChar.avatar?.includes('.png') === true, 'stored avatar is served as a .png file');
  assert(
    !readdirSync(join(process.env.DATA_DIR!, 'avatars')).some((name) => name.endsWith('.tmp')),
    'atomic avatar replacement leaves no temporary files behind',
  );
  const jpegPersonaRes = await putAvatar(`/api/personas/${persona.id}/avatar`, jpegBytes);
  assert(jpegPersonaRes.status === 415, 'persona avatar upload rejects JPEG magic bytes');

  return { putAvatar, pngChar };
}

export type CharactersFixture = Awaited<ReturnType<typeof testCharacters>>;
