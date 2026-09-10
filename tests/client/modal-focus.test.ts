import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
import { createRoot } from 'solid-js';

test('restored pages leave focus alone until Tab, while confirmations focus their control', async () => {
  const focused: string[] = [];
  const document = Object.assign(new EventTarget(), {
    activeElement: null as unknown,
    body: null as unknown,
    querySelectorAll: () => [dialog],
  });
  const element = (name: string) => ({
    isConnected: true,
    tabIndex: 0,
    closest: () => null,
    hasAttribute: () => false,
    getClientRects: () => [{}],
    focus() {
      document.activeElement = this;
      focused.push(name);
    },
  });
  const body = element('body');
  document.body = document.activeElement = body;
  const first = element('first');
  const last = element('last');
  const dialog = {
    ...element('dialog'),
    contains: (target: unknown) => target === first || target === last,
    querySelector: () => first,
    querySelectorAll: () => [first, last],
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  mock.module('../../client/src/state/dialogContext.ts', () => ({
    useDialogActive: () => () => true,
  }));
  mock.module('../../client/src/state/dialogLayers.ts', () => ({
    dialogLayers: { register: () => ({ isTop: () => true, dispose() {} }) },
  }));
  mock.module('../../client/src/state/store.ts', () => ({ openModal() {} }));
  mock.module('../../client/src/state/uiBack.ts', () => ({ registerUiBack() {} }));
  mock.module('react/jsx-dev-runtime', () => ({
    jsxDEV: (_type: unknown, props: Record<string, unknown>) => {
      if (props.role === 'dialog') (props.ref as (element: unknown) => void)(dialog);
      return null;
    },
  }));
  const path = '../../client/src/components/ui/Modal.tsx';
  const { default: Modal } = await import(path);
  const mount = (fullscreen: boolean) => {
    let dispose!: () => void;
    createRoot((cleanup) => {
      dispose = cleanup;
      Modal({ title: 'Test', fullscreen, children: null });
    });
    return dispose;
  };
  const dispose = mount(true);
  await Promise.resolve();
  assert.deepEqual(focused, [], 'A reload must not focus the first button');
  const tab = (shiftKey = false) => {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperties(event, { key: { value: 'Tab' }, shiftKey: { value: shiftKey } });
    document.dispatchEvent(event);
    assert(event.defaultPrevented);
  };
  tab();
  assert.equal(document.activeElement, first, 'Tab enters the restored page');
  tab(true);
  assert.equal(document.activeElement, last, 'Keyboard focus still wraps within the dialog');
  dispose();
  await Promise.resolve();
  focused.length = 0;
  document.activeElement = body;
  const closeConfirmation = mount(false);
  await Promise.resolve();
  assert.deepEqual(focused, ['first'], 'New confirmations retain intentional initial focus');
  closeConfirmation();
});
