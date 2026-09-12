import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  settingsPreferences,
  mediaSettingsCollections,
  MEDIA_SETTINGS_TABLES,
  type SettingsSnapshot,
  type MediaLibraryVersions,
} from '@tinytavern/shared';
import { createSettingsSnapshotLoader } from '../../client/src/state/settingsSnapshot.ts';

test('settings deltas retain unrelated collections through overlapping requests and server restarts', async () => {
  const requests: { query: URLSearchParams; resolve: (snapshot: SettingsSnapshot) => void }[] = [];
  const snapshots = createSettingsSnapshotLoader(
    (query) =>
      new Promise((resolve) => {
        requests.push({ query: new URLSearchParams(query), resolve });
      }),
  );
  const load = async () => (await snapshots()).settings;
  const versions = Object.fromEntries(MEDIA_SETTINGS_TABLES.map((table) => [table, 0])) as MediaLibraryVersions;
  const initial: SettingsSnapshot = {
    epoch: 'first',
    preferences: settingsPreferences(DEFAULT_SETTINGS),
    collections: mediaSettingsCollections(DEFAULT_SETTINGS),
    versions,
  };
  const first = load();
  requests[0]!.resolve(initial);
  await first;
  const older = load();
  let savedQuery: URLSearchParams | undefined;
  const newer = snapshots(
    (query) =>
      new Promise<SettingsSnapshot>((resolve) => {
        savedQuery = new URLSearchParams(query);
        requests.push({ query: savedQuery, resolve });
      }),
  );
  assert.deepEqual(JSON.parse(requests[1]!.query.get('versions')!), versions);
  requests[2]!.resolve({
    ...initial,
    preferences: { ...initial.preferences, revision: 2 },
    assigned: { media_chat_prompts: { draft: '1' } },
    versions: { ...versions, media_chat_prompts: 2 },
    collections: { media_chat_prompts: [{ id: '1', name: 'Newer', chatPrompt: 'Current' }] },
  });
  const saved = await newer;
  assert.equal(saved.settings.mediaChatPrompts.presets[0]!.name, 'Newer');
  assert.equal(saved.assigned.media_chat_prompts!.draft, '1');
  assert.equal(savedQuery!.get('epoch'), initial.epoch, 'Saves share the current read snapshot baseline');
  requests[1]!.resolve({
    ...initial,
    preferences: { ...initial.preferences, revision: 1 },
    versions: { ...versions, media_chat_prompts: 1 },
    collections: { media_chat_prompts: [{ id: '1', name: 'Older', chatPrompt: 'Stale' }] },
  });
  await older;
  const unchanged = load();
  assert.equal(JSON.parse(requests[3]!.query.get('versions')!).media_chat_prompts, 2);
  requests[3]!.resolve({
    ...initial,
    preferences: { ...initial.preferences, revision: 3 },
    versions: { ...versions, media_chat_prompts: 2 },
    collections: {},
  });
  const current = await unchanged;
  assert.equal(current.mediaChatPrompts.presets[0]!.name, 'Newer');
  assert.deepEqual(current.mediaRendering.workflows, DEFAULT_SETTINGS.mediaRendering.workflows);
  current.mediaChatPrompts.presets[0]!.name = 'Local mutation';
  const isolated = load();
  requests[4]!.resolve({
    ...initial,
    preferences: { ...initial.preferences, revision: 3 },
    versions: { ...versions, media_chat_prompts: 2 },
    collections: {},
  });
  assert.equal((await isolated).mediaChatPrompts.presets[0]!.name, 'Newer');
  const restarted = load();
  requests[5]!.resolve({ ...initial, epoch: 'restarted', preferences: { ...initial.preferences, revision: 4 } });
  assert.deepEqual((await restarted).mediaChatPrompts.presets, DEFAULT_SETTINGS.mediaChatPrompts.presets);
});
