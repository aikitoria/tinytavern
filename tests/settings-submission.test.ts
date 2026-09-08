import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRoot, createSignal } from 'solid-js';
import {
  createSettingsNavigation,
  createSettingsSubmission,
} from '../client/src/state/settingsSubmission.ts';
import { changedFields, sameValue } from '../client/src/state/editorSync.ts';

// Node's default Solid export disables effects. Exercise the same reactive implementation as Vite.
if (!process.execArgv.includes('--conditions=browser')) {
  const child = spawnSync(process.execPath, ['--conditions=browser', import.meta.filename], {
    stdio: 'inherit',
  });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

type Values = { title: string; enabled: boolean };
type Saved = { revision: number; values: Values };
let remote: Saved = { revision: 3, values: { title: 'Original', enabled: false } };
let draft = { ...remote.values };
let baseline = draft;
let password = '';
let error = '';
let validationError = false;
const requests: { values: Partial<Values>; password: string; revision: number }[] = [];
let resolve!: (saved: Saved) => void;
let reject!: (error: Error) => void;
const form = createSettingsSubmission({
  revision: () => remote.revision,
  isDirty: () => !sameValue(draft, baseline) || password !== '',
  snapshot: () => {
    if (validationError) throw new Error('Invalid template');
    return { values: draft, password };
  },
  submit: (snapshot, revision) => {
    requests.push({
      values: changedFields(baseline, snapshot.values),
      password: snapshot.password,
      revision,
    });
    return new Promise<Saved>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
  },
  accepted: (snapshot, saved) => {
    remote = saved;
    baseline = snapshot.values;
    if (password === snapshot.password) password = '';
  },
  discard: () => {
    draft = { ...remote.values };
    baseline = draft;
    password = '';
  },
  onError: (message) => {
    error = message;
  },
});

assert.equal(await form.save(), true, 'A clean editor can navigate without sending a request');
assert.equal(requests.length, 0);
draft = { ...draft, title: 'Submitted' };
password = 'submitted-password';
const first = form.save();
assert.equal(form.saving(), true);
assert.equal(await form.save(), false, 'Another Save cannot overlap a pending request');
assert.equal(requests.length, 1);
assert.deepEqual(requests[0], {
  values: { title: 'Submitted' },
  password: 'submitted-password',
  revision: 3,
});

// Reverting to the old server value is still a new edit relative to this request.
draft = { title: 'Original', enabled: true };
password = 'newer-password';
form.discard();
assert.equal(draft.title, 'Original');
assert.equal(password, 'newer-password', 'Discard cannot reset a draft while it is being saved');
resolve({ revision: 4, values: { title: 'Submitted', enabled: false } });
assert.equal(await first, false, 'Save-and-leave must remain in the editor when newer edits exist');
assert.equal(form.saving(), false);
assert.deepEqual(draft, { title: 'Original', enabled: true });
assert.equal(password, 'newer-password');

const second = form.save();
assert.deepEqual(requests[1], {
  values: { title: 'Original', enabled: true },
  password: 'newer-password',
  revision: 4,
});
resolve({ revision: 5, values: { ...draft } });
assert.equal(await second, true, 'A submitted draft with no newer edits permits navigation');
assert.equal(password, '');
assert.equal(form.isDirty(), false);

draft = { ...draft, title: 'Local conflict' };
const conflict = form.save();
remote = { revision: 6, values: { title: 'Remote edit', enabled: false } };
reject(Object.assign(new Error('Conflict'), { status: 409 }));
assert.equal(await conflict, false);
assert.equal(form.saving(), false);
assert.match(error, /Settings changed elsewhere.*Discard/);
assert.equal(draft.title, 'Local conflict');
const retry = form.save();
assert.equal(requests.at(-1)!.revision, 5, 'A conflict cannot silently rebase a dirty draft');
reject(Object.assign(new Error('Conflict'), { status: 409 }));
await retry;
form.discard();
assert.equal(error, '');
assert.deepEqual(draft, remote.values);
assert.equal(form.isDirty(), false);

draft = { ...draft, title: 'Reviewed change' };
validationError = true;
const count = requests.length;
assert.equal(await form.save(), false);
assert.equal(form.saving(), false, 'Validation failure releases the submission lock');
assert.equal(requests.length, count);
assert.equal(error, 'Invalid template');
validationError = false;
const afterDiscard = form.save();
assert.equal(requests.at(-1)!.revision, 6, 'Discard adopts the latest revision');
reject(new Error('Network unavailable'));
assert.equal(await afterDiscard, false);
assert.equal(error, 'Network unavailable');
assert.equal(form.isDirty(), true);

const navigation = createSettingsNavigation();
navigation.register(form);
let navigations = 0;
const leave = () => {
  navigations++;
};
navigation.navigate(leave);
assert.equal(navigation.promptOpen(), true);
navigation.cancel();
assert.equal(navigations, 0, 'Cancel leaves the draft intact');

// A direct page Save can be pending even after the user reverts to the old clean baseline.
const directSave = form.save();
draft = { ...baseline };
assert.equal(form.isDirty(), false);
navigation.navigate(leave);
assert.equal(navigation.promptOpen(), true, 'Pending submission itself guards navigation');
assert.equal(navigation.saving(), true);
navigation.discard();
await navigation.save();
assert.equal(navigations, 0, 'Neither guarded Discard nor Save can leave during a direct Save');
resolve({ revision: 7, values: { title: 'Reviewed change', enabled: false } });
assert.equal(await directSave, false);
assert.equal(navigation.saving(), false);
navigation.discard();
assert.equal(navigations, 1, 'Discard after completion loads saved state before leaving');
assert.deepEqual(draft, remote.values);

draft = { ...draft, title: 'Guarded save' };
navigation.navigate(leave);
const guardedSave = navigation.save();
draft = { ...draft, title: 'Later edit' };
resolve({ revision: 8, values: { title: 'Guarded save', enabled: false } });
await guardedSave;
assert.equal(navigations, 1, 'Save-and-leave does not consume edits made during the request');
assert.equal(navigation.promptOpen(), false, 'A remaining edit returns focus to the editor');
navigation.navigate(leave);
const finalSave = navigation.save();
resolve({ revision: 9, values: { ...draft } });
await finalSave;
assert.equal(navigations, 2, 'Save-and-leave completes when the submitted draft stays clean');

const reactive = createRoot((dispose) => {
  const [remote, setRemote] = createSignal({ revision: 1, title: 'Initial' });
  const [draft, setDraft] = createSignal(remote().title);
  let baseline = draft();
  let resolve!: (settings: { revision: number; title: string }) => void;
  let reject!: (error: Error) => void;
  const revisions: number[] = [];
  const form = createSettingsSubmission({
    revision: () => remote().revision,
    isDirty: () => draft() !== baseline,
    snapshot: draft,
    submit: (_snapshot, revision) => {
      revisions.push(revision);
      return new Promise<{ revision: number; title: string }>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
    },
    accepted: (snapshot, response) => {
      // Match applySettings: a late response cannot overwrite a newer WebSocket invalidation.
      if (response.revision >= remote().revision) setRemote(response);
      baseline = snapshot;
    },
    discard: () => {
      baseline = remote().title;
      setDraft(baseline);
    },
    onError: () => {},
  });
  return {
    dispose,
    form,
    draft,
    setDraft,
    remote,
    setRemote,
    revisions,
    resolve: (settings: { revision: number; title: string }) => resolve(settings),
    reject: (error: Error) => reject(error),
  };
});
try {
  reactive.setRemote({ revision: 2, title: 'Pristine refresh' });
  assert.equal(reactive.draft(), 'Pristine refresh', 'Browser Solid effects refresh a clean draft');
  reactive.setDraft('Submitted');
  const overtaken = reactive.form.save();
  reactive.setRemote({ revision: 4, title: 'Newer remote value' });
  assert.equal(
    reactive.draft(),
    'Submitted',
    'A pending save holds its draft through invalidation',
  );
  reactive.resolve({ revision: 3, title: 'Submitted' });
  assert.equal(await overtaken, true);
  assert.equal(reactive.remote().revision, 4);
  assert.equal(
    reactive.draft(),
    'Newer remote value',
    'Save completion refreshes from the newer revision',
  );
  assert.equal(reactive.form.isDirty(), false);

  reactive.setDraft('Next submission');
  const editedWhileSaving = reactive.form.save();
  assert.equal(reactive.revisions.at(-1), 4, 'The next request uses the refreshed revision');
  reactive.setDraft('Newer local edit');
  reactive.setRemote({ revision: 6, title: 'Another remote value' });
  reactive.resolve({ revision: 5, title: 'Next submission' });
  assert.equal(await editedWhileSaving, false);
  assert.equal(
    reactive.draft(),
    'Newer local edit',
    'Completion never refreshes over a newer local edit',
  );
  assert.equal(reactive.form.isDirty(), true);
  const conflicted = reactive.form.save();
  assert.equal(reactive.revisions.at(-1), 5, 'A preserved local edit keeps its baseline revision');
  reactive.reject(Object.assign(new Error('Conflict'), { status: 409 }));
  assert.equal(await conflicted, false);
  assert.equal(reactive.draft(), 'Newer local edit');
  reactive.form.discard();
  assert.equal(reactive.draft(), 'Another remote value');
} finally {
  reactive.dispose();
}

console.log(
  'Settings submission preserves pending edits, locks requests, guards navigation and retains conflicts.',
);
