import assert from 'node:assert/strict';
import { test } from 'bun:test';
import type { GenerationMetrics, Message, ServerEvent } from '@tinytavern/shared';

test('generation metrics reject stale continuations and retain earlier measurements', async () => {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {} }),
  });
  const modulePath = '../../client/src/state/store.ts';
  const { state, setState, handleServerEvent } = (await import(modulePath)) as {
    state: { tree: { messages: Record<number, Message> } };
    setState(...args: unknown[]): void;
    handleServerEvent(event: ServerEvent): void;
  };
  const previous: GenerationMetrics = {
    generationToken: 1,
    model: 'mina',
    continuation: false,
    speculative: false,
    elapsedMs: 100,
    attempts: [{ completionTokens: 5, status: 'done' }],
  };
  const current: GenerationMetrics = {
    ...previous,
    generationToken: 2,
    continuation: true,
    elapsedMs: undefined,
    attempts: [{ firstTokenMs: 20 }],
  };
  setState('tree', 'messages', {
    1: { id: 1, status: 'streaming', generationToken: 2, genMeta: { generations: [previous] } },
  });
  handleServerEvent({ t: 'generationMetrics', mid: 1, metrics: previous });
  assert.equal(state.tree.messages[1]!.genMeta!.generations!.length, 1);
  // A copied conversation can reuse an old measurement's revision number.
  setState('tree', 'messages', 1, 'genMeta', 'generations', 0, 'generationToken', 2);
  handleServerEvent({ t: 'generationMetrics', mid: 1, metrics: current });
  handleServerEvent({
    t: 'generationMetrics',
    mid: 1,
    metrics: { ...current, attempts: [{ firstTokenMs: 20, firstContentMs: 40 }] },
  });
  assert.equal(state.tree.messages[1]!.genMeta!.generations!.length, 2);
  assert.deepEqual(state.tree.messages[1]!.genMeta!.generations![0], {
    ...previous,
    generationToken: 2,
  });
  assert.equal(state.tree.messages[1]!.genMeta!.generations![1]!.attempts[0]!.firstContentMs, 40);
  setState('tree', 'messages', 1, 'status', 'done');
  handleServerEvent({ t: 'generationMetrics', mid: 1, metrics: current });
  assert.equal(state.tree.messages[1]!.genMeta!.generations![1]!.attempts[0]!.firstContentMs, 40);
});
