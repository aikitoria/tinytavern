import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { createRoot } from 'solid-js';
import { createAsyncScope } from '../../client/src/state/asyncScope.ts';

test('pending imports expire on target changes, new edits and unmount', async () => {
  let identity = 1;
  let draft = { name: 'A' };
  let dispose!: () => void;
  const capture = createRoot((cleanup) => {
    dispose = cleanup;
    return createAsyncScope(() => [identity, draft]);
  });
  const read = () => {
    const current = capture();
    let resolve!: (name: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    }).then((name) => {
      if (current()) draft = { name };
    });
    return { pending, resolve };
  };
  try {
    const first = read();
    identity++;
    draft = { name: 'B' };
    first.resolve('Imported into A');
    await first.pending;
    assert.equal(draft.name, 'B');

    const second = read();
    draft.name = 'New typing';
    second.resolve('Old file');
    await second.pending;
    assert.equal(draft.name, 'New typing');

    const third = read();
    third.resolve('Current file');
    await third.pending;
    assert.equal(draft.name, 'Current file');

    const last = read();
    dispose();
    last.resolve('Unmounted file');
    await last.pending;
    assert.equal(draft.name, 'Current file');
  } finally {
    dispose();
  }
});
