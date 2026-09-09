import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('client sync', async () => {
  const { prepareEndpointPatch } = await import('../../client/src/state/endpointSync.ts');

  const { changedFields, mergeRemoteDraft } = await import('../../client/src/state/editorSync.ts');

  const { isCurrentSettingsRevision, SuccessfulFetchSequence, upsertById } =
    await import('../../client/src/state/sync.ts');

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
});

test('settings submission', async () => {
  const { createRoot, createSignal } = await import('solid-js');

  const { createSettingsNavigation, createSettingsSubmission } =
    await import('../../client/src/state/settingsSubmission.ts');

  const { changedFields, sameValue } = await import('../../client/src/state/editorSync.ts');

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
  assert.equal(
    await first,
    false,
    'Save-and-leave must remain in the editor when newer edits exist',
  );
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
    assert.equal(
      reactive.draft(),
      'Pristine refresh',
      'Browser Solid effects refresh a clean draft',
    );
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
    assert.equal(
      reactive.revisions.at(-1),
      5,
      'A preserved local edit keeps its baseline revision',
    );
    reactive.reject(Object.assign(new Error('Conflict'), { status: 409 }));
    assert.equal(await conflicted, false);
    assert.equal(reactive.draft(), 'Newer local edit');
    reactive.form.discard();
    assert.equal(reactive.draft(), 'Another remote value');
  } finally {
    reactive.dispose();
  }
});

test('client transport', async () => {
  // Dynamic paths keep browser-only types out of the server typecheck.
  const apiPath = '../../client/src/state/api.ts';
  const draftPath = '../../client/src/state/draftCompletion.ts';
  const { api, ApiError, streamTextCompletion, setAuthenticationRequiredHandler } = await import(
    apiPath
  );
  const { completeComposerDraft, stopDraftCompletion } = await import(draftPath);
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();

  function response(text: string): Response {
    const bytes = encoder.encode(text);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // Split every UTF-8 sequence and line delimiter at network boundaries.
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
    );
  }

  try {
    globalThis.fetch = (async () =>
      response(
        'data: {"d":"A😀"}\r\n\r\ndata: {"d":"B"}\ndata: {"done":true}',
      )) as unknown as typeof fetch;
    const deltas: string[] = [];
    const accumulated: string[] = [];
    assert.equal(
      await streamTextCompletion(
        '/test',
        {},
        (delta: string, text: string) => {
          deltas.push(delta);
          accumulated.push(text);
        },
        'test',
      ),
      'A😀B',
    );
    assert.deepEqual(deltas, ['A😀', 'B']);
    assert.deepEqual(accumulated, ['A😀', 'A😀B']);

    globalThis.fetch = (async () => response('data: {"d":"partial"}\n')) as unknown as typeof fetch;
    await assert.rejects(
      streamTextCompletion('/test', {}, () => {}, 'test'),
      /ended before completion/,
    );
    globalThis.fetch = (async () =>
      response('data: {"error":"upstream failure"}\n')) as unknown as typeof fetch;
    await assert.rejects(
      streamTextCompletion('/test', {}, () => {}, 'test'),
      (err: unknown) => err instanceof ApiError && (err as Error).message === 'upstream failure',
    );

    const options = {
      conversationId: 7,
      draft: 'Original',
      expectedActiveLeafId: 3,
      expectedMutationRevision: 9,
      onText: (text: string) => draftTexts.push(text),
    };
    const draftTexts: string[] = [];
    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      assert.deepEqual(JSON.parse(init?.body as string), {
        draft: 'Original',
        expectedActiveLeafId: 3,
        expectedMutationRevision: 9,
      });
      return response('data: {"d":" suffix"}\ndata: {"done":true}');
    }) as unknown as typeof fetch;
    assert.equal(await completeComposerDraft(options), true);
    assert.deepEqual(draftTexts, ['Original suffix']);

    draftTexts.length = 0;
    globalThis.fetch = (async () =>
      response(
        'data: {"d":" partial"}\ndata: {"error":"stale draft"}\n',
      )) as unknown as typeof fetch;
    await assert.rejects(completeComposerDraft(options), /stale draft/);
    assert.deepEqual(draftTexts, ['Original partial', 'Original']);

    draftTexts.length = 0;
    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"d":" cancelled"}\n'));
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          },
        }),
      )) as unknown as typeof fetch;
    const pending = completeComposerDraft({
      ...options,
      onText(text: string) {
        draftTexts.push(text);
        if (text !== options.draft) stopDraftCompletion();
      },
    });
    assert.equal(
      await completeComposerDraft(options),
      false,
      'concurrent draft completion is rejected',
    );
    assert.equal(await pending, false);
    assert.deepEqual(draftTexts, ['Original cancelled', 'Original']);

    // Headers establish the listener; returning done must not wait for events or EOF.
    let progressController!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            progressController = controller;
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as unknown as typeof fetch;
    const progress: number[][] = [];
    const previews: string[] = [];
    const opened = await api.openAvatarRenderProgress(
      'job',
      (value: number, max: number) => progress.push([value, max]),
      (preview: string) => previews.push(preview),
    );
    progressController.enqueue(
      encoder.encode(
        'data: {"value":1,"max":4}\ndata: {"preview":"data:image/png;base64,A"}\ndata: {"done":true}\n',
      ),
    );
    await opened.done;
    assert.deepEqual(progress, [[1, 4]]);
    assert.deepEqual(previews, ['data:image/png;base64,A']);
    assert.equal(cancelled, true, 'done releases the progress stream');

    const expected = { activeLeafId: null, mutationRevision: 42 };
    globalThis.fetch = (async (
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      assert.equal(url, '/api/conversations/7/messages');
      assert.deepEqual(JSON.parse(init?.body as string), {
        content: 'hello',
        expectedActiveLeafId: null,
        expectedMutationRevision: 42,
      });
      return Response.json({ userMessageId: 1, assistantMessageId: 2 });
    }) as unknown as typeof fetch;
    await api.send(7, 'hello', expected);
    globalThis.fetch = (async (
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      assert.equal(url, '/api/messages/8?expectedActiveLeafId=null&expectedMutationRevision=42');
      assert.equal(init?.method, 'DELETE');
      assert.equal(init?.body, undefined);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await api.deleteMessage(8, expected);
    assert.deepEqual(expected, { activeLeafId: null, mutationRevision: 42 });

    let authenticationRequests = 0;
    setAuthenticationRequiredHandler(() => authenticationRequests++);
    globalThis.fetch = (async () =>
      Response.json({ error: 'locked' }, { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(api.conversations(), /locked/);
    assert.equal(authenticationRequests, 1);
    await assert.rejects(api.login('bad'), /locked/);
    assert.equal(
      authenticationRequests,
      1,
      'login errors do not recursively trigger authentication',
    );
    await assert.rejects(
      streamTextCompletion('/test', {}, () => {}, 'test'),
      /locked/,
    );
    assert.equal(
      authenticationRequests,
      1,
      'streaming retains its existing error-only authentication behavior',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ws lifecycle', async () => {
  const { jest } = await import('bun:test');

  type Listener = (event: { persisted?: boolean }) => void;
  const documentListeners = new Map<string, Listener[]>();
  const windowListeners = new Map<string, Listener[]>();

  const fakeDocument = {
    visibilityState: 'visible',
    addEventListener(type: string, listener: Listener) {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
    },
  };
  const fakeWindow = {
    addEventListener(type: string, listener: Listener) {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
    },
  };

  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static readonly instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.CONNECTING;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    readonly url: string;

    constructor(url: string) {
      this.url = url;
      FakeWebSocket.instances.push(this);
    }

    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(): void {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ code: 1000 });
    }
  }

  Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'https:', host: 'tinytavern.test' },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true });

  interface WsModule {
    configureWs(handlers: {
      onEvent: (event: unknown) => void;
      onOpen: () => void;
      onStatus: (connected: boolean) => void;
      onUnauthorized: () => void;
    }): void;
    startWs(): void;
    stopWs(): void;
    subscribe(conversationId: number | null): void;
  }
  // A dynamic path excludes browser code from the server's DOM-free type graph;
  // client tsconfig checks it, and this test supplies runtime browser globals.
  const wsModulePath = '../../client/src/state/ws.ts';
  const { configureWs, startWs, stopWs, subscribe } = (await import(wsModulePath)) as WsModule;
  jest.useFakeTimers();
  const dispatch = (listeners: Map<string, Listener[]>, type: string, event = {}) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };

  const statuses: boolean[] = [];
  let resyncs = 0;
  configureWs({
    onEvent: () => {},
    onOpen: () => {
      resyncs++;
    },
    onStatus: (connected) => statuses.push(connected),
    onUnauthorized: () => {},
  });

  startWs();
  assert.equal(FakeWebSocket.instances.length, 1);
  const first = FakeWebSocket.instances[0]!;
  assert.equal(first.url, 'wss://tinytavern.test/ws');
  first.open();
  subscribe(42);
  assert.deepEqual(
    first.sent.map((payload) => JSON.parse(payload)),
    [{ sub: 42 }],
  );

  // Replace apparently-open sockets on PWA resume without letting the old close
  // callback schedule another replacement.
  fakeDocument.visibilityState = 'visible';
  dispatch(documentListeners, 'visibilitychange');
  jest.advanceTimersByTime(80);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(first.readyState, FakeWebSocket.CLOSED);
  const second = FakeWebSocket.instances[1]!;
  second.open();
  assert.deepEqual(
    second.sent.map((payload) => JSON.parse(payload)),
    [{ sub: 42 }],
  );
  jest.advanceTimersByTime(550);
  assert.equal(FakeWebSocket.instances.length, 2);

  // Coalesce lifecycle events commonly delivered together on network/app resume.
  dispatch(windowListeners, 'online');
  dispatch(windowListeners, 'pageshow', { persisted: true });
  jest.advanceTimersByTime(80);
  assert.equal(FakeWebSocket.instances.length, 3);
  const third = FakeWebSocket.instances[2]!;
  third.open();
  assert.deepEqual(
    third.sent.map((payload) => JSON.parse(payload)),
    [{ sub: 42 }],
  );

  stopWs();
  dispatch(documentListeners, 'visibilitychange');
  jest.advanceTimersByTime(80);
  assert.equal(FakeWebSocket.instances.length, 3);
  assert.equal(statuses.at(-1), false);

  try {
    subscribe(null);
    startWs();
    const initial = FakeWebSocket.instances.at(-1)!;
    initial.open();
    const before = resyncs;
    dispatch(windowListeners, 'focus');
    dispatch(documentListeners, 'resume');
    jest.advanceTimersByTime(50);
    const resumed = FakeWebSocket.instances.at(-1)!;
    assert.notEqual(
      resumed,
      initial,
      'Gallery/jobs resume replaces a stale socket without a chat subscription',
    );
    resumed.open();
    assert.equal(resyncs, before + 1, 'Every page triggers the full data resync');
    assert.equal(resumed.sent.length, 0);
    fakeDocument.visibilityState = 'hidden';
    dispatch(windowListeners, 'focus');
    jest.advanceTimersByTime(50);
    assert.equal(FakeWebSocket.instances.at(-1), resumed);
    fakeDocument.visibilityState = 'visible';
    dispatch(documentListeners, 'resume');
    jest.advanceTimersByTime(50);
    const stuck = FakeWebSocket.instances.at(-1)!;
    jest.advanceTimersByTime(10_000);
    assert.equal(
      stuck.readyState,
      FakeWebSocket.CLOSED,
      'A stalled handshake does not hang indefinitely',
    );
    jest.advanceTimersByTime(500);
    const replacement = FakeWebSocket.instances.at(-1)!;
    assert.notEqual(replacement, stuck);
    replacement.open();
    stuck.onclose?.({ code: 1000 });
    assert.equal(statuses.at(-1), true, 'Late close callbacks cannot disconnect the replacement');
  } finally {
    stopWs();
    jest.useRealTimers();
  }
});
