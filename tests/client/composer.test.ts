import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
import { createRoot, createSignal } from 'solid-js';

test('pending sends restore failed drafts only in their original mounted conversation', async () => {
  const location = { hash: '#' };
  Object.defineProperties(globalThis, {
    location: { configurable: true, value: location },
    history: {
      configurable: true,
      value: {
        state: {},
        replaceState(_state: unknown, _title: string, hash: string) {
          location.hash = hash;
        },
      },
    },
    window: { configurable: true, value: { setTimeout, clearTimeout } },
    matchMedia: { configurable: true, value: () => ({ matches: false, addEventListener() {} }) },
    requestAnimationFrame: { configurable: true, value: () => 0 },
    cancelAnimationFrame: { configurable: true, value: () => {} },
  });
  let send!: () => void;
  // Exercise the real controller and send callback without mounting browser DOM.
  mock.module('react/jsx-dev-runtime', () => ({
    Fragment: Symbol('Fragment'),
    jsxDEV: (_type: unknown, props: Record<string, unknown>) => {
      if (props.title === 'Send') send = props.onClick as () => void;
      return null;
    },
  }));
  const storePath = '../../client/src/state/store.ts';
  const { selectConversation, mainConversationSession } = await import(storePath);
  const apiPath = '../../client/src/state/api.ts';
  const { api } = await import(apiPath);
  const composerPath = '../../client/src/components/chat/Composer.tsx';
  const { default: Composer } = await import(composerPath);
  const originalSend = api.send;
  const originalNavigate = mainConversationSession.navigateTree;
  let operation!: Promise<boolean>;
  mainConversationSession.navigateTree = (action: () => Promise<unknown>) => {
    operation = originalNavigate(action);
    return operation;
  };
  try {
    for (const scenario of ['switch', 'return', 'unmount', 'failure', 'typing'] as const) {
      selectConversation(1);
      let finish!: () => void;
      let fail!: (error: Error) => void;
      api.send = () =>
        new Promise<void>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
      const [text, setText] = createSignal('Message for conversation A');
      let dispose!: () => void;
      createRoot((cleanup) => {
        dispose = cleanup;
        Composer({
          get text() {
            return text();
          },
          onText: setText,
        });
      });
      try {
        send();
        assert.equal(text(), '');
        if (scenario === 'switch' || scenario === 'return') selectConversation(2);
        if (scenario === 'return') selectConversation(1);
        if (scenario === 'unmount') dispose();
        if (scenario === 'typing') setText('New draft');
        if (scenario === 'failure' || scenario === 'typing') fail(new Error('Send failed'));
        else finish();
        // The composer registered its continuation before this observer.
        await operation;
        assert.equal(
          text(),
          scenario === 'failure' ? 'Message for conversation A' : scenario === 'typing' ? 'New draft' : '',
          scenario,
        );
      } finally {
        dispose();
      }
    }
  } finally {
    api.send = originalSend;
    mainConversationSession.navigateTree = originalNavigate;
  }
});
