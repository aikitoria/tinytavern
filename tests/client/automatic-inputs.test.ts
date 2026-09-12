import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { canFillMediaInputs } from '../../client/src/media/automaticInputs.ts';

test('context filling is available only for an empty mapped slot with a usable source', () => {
  const unavailable = { selectedAssets: [], characterAvatar: false, personaAvatar: false };
  const available = {
    selectedAssets: [{ kind: 'image' as const }, { kind: 'video' as const }],
    characterAvatar: true,
    personaAvatar: true,
  };
  assert.equal(canFillMediaInputs(['subject'], {}, [], available), false);
  assert.equal(canFillMediaInputs(['subject'], { removed: 'character-avatar' }, [], available), false);
  for (const source of ['selected:1', 'character-avatar', 'persona-avatar'] as const) {
    const bindings = { subject: source };
    assert.equal(canFillMediaInputs(['subject'], bindings, [], unavailable), false);
    assert.equal(canFillMediaInputs(['subject'], bindings, [], available), true);
    assert.equal(canFillMediaInputs(['subject'], bindings, [{ slot: 'subject' }], available), false);
  }
  assert.equal(canFillMediaInputs(['subject'], { subject: 'selected:2' }, [], available), false);
  assert.equal(canFillMediaInputs(['subject'], { subject: 'selected:3' }, [], available), false);
  const videoContext = { ...available, inputKinds: new Map([['subject', 'video' as const]]) };
  assert.equal(canFillMediaInputs(['subject'], { subject: 'selected:2' }, [], videoContext), true);
  assert.equal(canFillMediaInputs(['subject'], { subject: 'selected:1' }, [], videoContext), false);
  assert.equal(canFillMediaInputs(['subject'], { subject: 'character-avatar' }, [], videoContext), false);
  assert.equal(
    canFillMediaInputs(
      ['subject', 'style'],
      { subject: 'selected:1', style: 'persona-avatar' },
      [{ slot: 'subject' }],
      available,
    ),
    true,
  );
});
