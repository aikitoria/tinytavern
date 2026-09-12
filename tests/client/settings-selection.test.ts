import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
import { DEFAULT_SETTINGS, type Settings } from '@tinytavern/shared';

test('entity activation coalesces pending selections and never retries a superseded target', async () => {
  const state = { settings: structuredClone(DEFAULT_SETTINGS) as Settings };
  class ApiError extends Error {
    status: number;
    constructor(status: number) {
      super(String(status));
      this.status = status;
    }
  }
  type Request = {
    patch: Partial<Settings>;
    revision: number;
    accept: () => void;
    reject: (error: Error) => void;
  };
  const requests: Request[] = [];
  let requested: ((request: Request) => void) | undefined;
  const nextRequest = () =>
    requests.length
      ? Promise.resolve(requests.shift()!)
      : new Promise<Request>((resolve) => {
          requested = resolve;
        });
  let refreshing: (() => void) | undefined;
  let refreshed!: (settings: Settings) => void;
  mock.module('../../client/src/state/api.ts', () => ({
    ApiError,
    api: {
      putSettings: (patch: Partial<Settings>, revision: number) =>
        new Promise<Settings>((resolve, reject) => {
          const request = {
            patch,
            revision,
            accept: () => resolve({ ...state.settings, ...patch, revision: revision + 1 }),
            reject,
          };
          if (requested) {
            const notify = requested;
            requested = undefined;
            notify(request);
          } else requests.push(request);
        }),
      settings: () =>
        new Promise<Settings>((resolve) => {
          refreshed = resolve;
          refreshing?.();
        }),
    },
  }));
  mock.module('../../client/src/state/store.ts', () => ({
    state,
    applySettings: (next: Settings) => {
      if (next.revision >= state.settings.revision) state.settings = next;
    },
  }));
  const path = '../../client/src/state/settingsSelection.ts';
  const { selectSettingsEntity, selectMediaPromptPreset } = await import(path);

  state.settings.activeEndpointId = 1;
  const first = selectSettingsEntity('activeEndpointId', 2);
  const returning = selectSettingsEntity('activeEndpointId', 1);
  const outward = await nextRequest();
  assert.equal(requests.length, 0, 'Only one selection request can be in flight per setting');
  assert.equal(outward.patch.activeEndpointId, 2);
  outward.accept();
  const back = await nextRequest();
  assert.equal(back.patch.activeEndpointId, 1, 'Returning to the cached active row is not skipped');
  back.accept();
  await Promise.all([first, returning]);
  assert.equal(state.settings.activeEndpointId, 1);

  state.settings.mediaChatPrompts.defaultPresetId = 'a';
  const prompt = selectMediaPromptPreset('mediaChatPrompts', 'b');
  const backToDefault = selectMediaPromptPreset('mediaChatPrompts', 'a');
  (await nextRequest()).accept();
  const lastPrompt = await nextRequest();
  assert.equal(lastPrompt.patch.mediaChatPrompts!.defaultPresetId, 'a');
  assert.deepEqual(lastPrompt.patch.mediaChatPrompts!.presets, state.settings.mediaChatPrompts.presets);
  lastPrompt.accept();
  await Promise.all([prompt, backToDefault]);
  assert.equal(state.settings.mediaChatPrompts.defaultPresetId, 'a');

  const stale = selectSettingsEntity('activeEndpointId', 2);
  const refreshStarted = new Promise<void>((resolve) => {
    refreshing = resolve;
  });
  (await nextRequest()).reject(new ApiError(409));
  await refreshStarted;
  const newest = selectSettingsEntity('activeEndpointId', 3);
  refreshed({ ...state.settings, revision: state.settings.revision + 1 });
  const latest = await nextRequest();
  assert.equal(latest.patch.activeEndpointId, 3, 'A stale retry must use the newest selection');
  latest.accept();
  await Promise.all([stale, newest]);
  assert.equal(state.settings.activeEndpointId, 3);
  assert.equal(requests.length, 0);
});
