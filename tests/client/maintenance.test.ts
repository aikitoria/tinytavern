import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
import { createRoot, createSignal } from 'solid-js';
import { DEFAULT_SETTINGS, type Settings } from '@tinytavern/shared';
import { pendingConfirmation, settleConfirmation } from '../../client/src/state/confirm.ts';

test('delete-all and reset actions require confirmation even with Shift and block duplicate requests', async () => {
  const [settings, setSettings] = createSignal({
    ...structuredClone(DEFAULT_SETTINGS),
    revision: 7,
  });
  const calls: string[] = [];
  const controls = new Map<string, (event: { shiftKey: boolean }) => void>();
  let finish!: () => void;
  let busy!: () => boolean;
  const run = (action: string) => {
    calls.push(action);
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  };
  mock.module('../../client/src/state/store.ts', () => ({
    state: {
      get settings() {
        return settings();
      },
      conversations: [{ id: 1 }],
      characters: [{ id: 1 }],
    },
    applySettings: (next: Settings) => setSettings(next),
    deleteAllConversations: () => run('chats'),
  }));
  mock.module('../../client/src/state/api.ts', () => ({
    api: {
      deleteAllCharacters: () => run('characters'),
      resetSettings: async (revision: number) => {
        assert.equal(revision, 7);
        await run('settings');
        return { ...DEFAULT_SETTINGS, revision: 8 };
      },
    },
  }));
  mock.module('../../client/src/util.ts', () => ({
    createSavedFlash: () => [() => false, () => {}],
    errorMessage: String,
  }));
  mock.module('../../client/src/components/settings/SettingsGuard.tsx', () => ({
    useSettingsGuard: (actions: { saving: () => boolean }) => {
      busy = actions.saving;
    },
  }));
  mock.module('react/jsx-dev-runtime', () => ({
    Fragment: Symbol('Fragment'),
    jsxDEV: (_type: unknown, props: Record<string, unknown>) => {
      if (typeof props.children === 'string' && typeof props.onClick === 'function')
        controls.set(props.children, props.onClick as (event: { shiftKey: boolean }) => void);
      return null;
    },
  }));
  const path = '../../client/src/components/settings/tabs/GeneralTab.tsx';
  const { default: GeneralTab } = await import(path);
  let dispose!: () => void;
  createRoot((cleanup) => {
    dispose = cleanup;
    GeneralTab();
  });
  try {
    for (const [label, action] of [
      ['Delete all chats', 'chats'],
      ['Delete all characters', 'characters'],
      ['Reset settings', 'settings'],
    ]) {
      const click = controls.get(label!)!;
      const before = calls.length;
      click({ shiftKey: true });
      assert.equal(pendingConfirmation()!.confirmLabel, label);
      assert.equal(pendingConfirmation()!.danger, true);
      assert.equal(calls.length, before);
      settleConfirmation(false);
      await Promise.resolve();
      assert.equal(calls.length, before);
      assert.equal(busy(), false);
      click({ shiftKey: true });
      settleConfirmation(true);
      await Promise.resolve();
      assert.equal(busy(), true);
      click({ shiftKey: true });
      assert.deepEqual(calls.slice(before), [action]);
      finish();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(busy(), false);
    }
    assert.equal(settings().revision, 8);
  } finally {
    settleConfirmation(false);
    dispose();
  }
});
