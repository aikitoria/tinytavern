import assert from 'node:assert/strict';
import { prepareEndpointPatch } from '../client/src/state/endpointSync.ts';
import { changedFields, mergeRemoteDraft } from '../client/src/state/editorSync.ts';
import {
  isCurrentSettingsRevision,
  SuccessfulFetchSequence,
  upsertById,
} from '../client/src/state/sync.ts';

const rows = upsertById(
  [
    { id: 1, title: 'one' },
    { id: 2, title: 'two' },
  ],
  { id: 2, title: 'updated' },
);
assert.deepEqual(rows, [
  { id: 1, title: 'one' },
  { id: 2, title: 'updated' },
]);
assert.equal(upsertById(rows, { id: 3, title: 'three' }).length, 3);

assert.equal(isCurrentSettingsRevision(4, 3), false);
assert.equal(isCurrentSettingsRevision(4, 4), true);
assert.equal(isCurrentSettingsRevision(4, 5), true);

const sequence = new SuccessfulFetchSequence<string>();
const first = sequence.start('settings');
sequence.start('settings'); // fails: it must not suppress the first success
assert.equal(sequence.accept('settings', first), true);
const third = sequence.start('settings');
const fourth = sequence.start('settings');
assert.equal(sequence.accept('settings', fourth), true);
assert.equal(sequence.accept('settings', third), false);

assert.deepEqual(
  changedFields(
    { name: 'A', content: 'old', nested: { enabled: false } },
    { name: 'B', content: 'old', nested: { enabled: false } },
  ),
  { name: 'B' },
);

assert.deepEqual(prepareEndpointPatch({ genParams: {} }), {
  genParams: {},
  replaceGenParams: true,
});
assert.deepEqual(prepareEndpointPatch({ name: 'renamed' }), { name: 'renamed' });

const merged = mergeRemoteDraft(
  { title: 'old', personaId: 1, endpointId: 1 },
  { title: 'old', personaId: 2, endpointId: 1 },
  { title: 'remote', personaId: 3, endpointId: 1 },
);
assert.deepEqual(merged.draft, { title: 'remote', personaId: 2, endpointId: 1 });
assert.deepEqual(merged.conflicts, ['personaId']);

console.log('client sync tests passed');
