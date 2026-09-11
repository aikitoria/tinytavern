import { mockFetch, controlledStream, byteResponse } from '../support/streams.ts';
import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('pending prompt trace preserves history and replaces only its editable tail', async () => {
  const { prepareChatMessages, preparePromptTrace } = await import('@tinytavern/shared');
  const prompt = {
    messages: [
      { role: 'system' as const, content: 'System' },
      { role: 'user' as const, content: 'Earlier user message' },
    ],
    reasoningPrefill: 'Global reasoning\nTemplate reasoning',
    messagePrefill: '',
    namePrefill: null,
    speakerHandoff: 'Reply as Guest.',
  };
  const original = structuredClone(prompt);
  const first = prepareChatMessages(prompt, { prefillMode: 'none', pendingMessage: ' first ' });
  const second = prepareChatMessages(prompt, { prefillMode: 'none', pendingMessage: 'second' });
  assert.strictEqual(first.messages[0], prompt.messages[0]);
  assert.strictEqual(
    second.messages[0],
    first.messages[0],
    'Keystrokes retain the committed history DOM',
  );
  assert.equal(
    first.messages[1]!.content,
    'Earlier user message\n\nfirst\n<system_instruction>\nReply as Guest.\n</system_instruction>',
  );
  assert.equal(
    second.messages[1]!.content,
    'Earlier user message\n\nsecond\n<system_instruction>\nReply as Guest.\n</system_instruction>',
  );
  assert.equal(second.pendingMessageIndex, 1);
  assert.equal(second.prefillMessageIndex, 2);
  assert.deepEqual(second.messages[2], {
    role: 'assistant',
    content: '',
    reasoning_content: 'Global reasoning\nTemplate reasoning',
  });
  const disabled = prepareChatMessages(prompt, {
    prefillMode: 'disabled',
    pendingMessage: 'third',
  });
  assert.equal(
    disabled.messages[1]!.content,
    'Earlier user message\n\nthird\n<system_instruction>\nReply as Guest.\n</system_instruction>',
  );
  assert.equal(disabled.prefillMessageIndex, null);
  assert.deepEqual(prompt, original);
  const historicalAssistant = {
    role: 'assistant' as const,
    content: 'Previous reply',
    reasoning_content: 'Previous reasoning',
  };
  const trace = {
    ...prompt,
    messages: [...prompt.messages, historicalAssistant],
    prefillMode: 'none' as const,
    userMessagePrefix: 'User: ',
  };
  const withoutDraft = preparePromptTrace(trace, '  ');
  assert.strictEqual(withoutDraft.messages.at(-1), historicalAssistant);
  assert.equal(
    withoutDraft.prefillMessageIndex,
    null,
    'Historical replies are never relabeled or extended with a new prefill',
  );
  const withDraft = preparePromptTrace(trace, 'Next message');
  assert.strictEqual(withDraft.messages[2], historicalAssistant);
  assert.deepEqual(withDraft.messages[3], {
    role: 'user',
    content: 'User: Next message\n<system_instruction>\nReply as Guest.\n</system_instruction>',
  });
  assert.equal(withDraft.prefillMessageIndex, 4);
  assert.equal(withDraft.messages[4]!.reasoning_content, prompt.reasoningPrefill);
  const awaitingReply = preparePromptTrace({ ...trace, messages: prompt.messages }, '');
  assert.equal(awaitingReply.prefillMessageIndex, 2);
  const live = { ...trace, stream: { messageId: 12, generationToken: 34, namePrefix: '' } };
  const streaming = preparePromptTrace(live, 'Draft for the next turn');
  assert.strictEqual(
    streaming.messages,
    live.messages,
    'Live history never acquires another seed or an unsent draft',
  );
  assert.equal(streaming.prefillMessageIndex, null);
  assert.equal(streaming.pendingMessageIndex, null);
});

test('client sync', async () => {
  const { prepareEndpointPatch } = await import('../../client/src/state/endpointSync.ts');

  const { SuccessfulFetchSequence } = await import('../../client/src/state/sync.ts');

  const sequence = new SuccessfulFetchSequence<string>();
  const first = sequence.start('settings');
  sequence.start('settings'); // fails: it must not suppress the first success
  assert.equal(sequence.accept('settings', first), true);
  const third = sequence.start('settings');
  const fourth = sequence.start('settings');
  assert.equal(sequence.accept('settings', fourth), true);
  assert.equal(sequence.accept('settings', third), false);

  assert.deepEqual(prepareEndpointPatch({ genParams: {} }), {
    genParams: {},
    replaceGenParams: true,
  });
  assert.deepEqual(prepareEndpointPatch({ name: 'renamed' }), { name: 'renamed' });
});

test('settings submission', async () => {
  const { createRoot, createSignal } = await import('solid-js');

  const { createSettingsNavigation, createSettingsSubmission } =
    await import('../../client/src/state/settingsSubmission.ts');

  const { changedFields, sameValue } = await import('../../client/src/state/editorSync.ts');

  type Values = { title: string; enabled: boolean };
  type Saved = { revision: number; values: Values };
  const [remote, setRemote] = createSignal<Saved>({
    revision: 3,
    values: { title: 'Original', enabled: false },
  });
  let draft = { ...remote().values };
  let baseline = draft;
  let password = '';
  let error = '';
  let validationError = false;
  const requests: { values: Partial<Values>; password: string; revision: number }[] = [];
  let resolve!: (saved: Saved) => void;
  let reject!: (error: Error) => void;
  let dispose!: () => void;
  const form = createRoot((cleanup) => {
    dispose = cleanup;
    return createSettingsSubmission({
      revision: () => remote().revision,
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
        // A late response cannot overwrite a newer WebSocket invalidation.
        if (saved.revision >= remote().revision) setRemote(saved);
        baseline = snapshot.values;
        if (password === snapshot.password) password = '';
      },
      discard: () => {
        draft = { ...remote().values };
        baseline = draft;
        password = '';
      },
      onError: (message) => {
        error = message;
      },
    });
  });

  try {
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
    assert.equal(
      password,
      'newer-password',
      'Discard cannot reset a draft while it is being saved',
    );
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
    setRemote({ revision: 6, values: { title: 'Remote edit', enabled: false } });
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
    assert.deepEqual(draft, remote().values);
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
    assert.deepEqual(draft, remote().values);

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

    setRemote({ revision: 10, values: { title: 'Pristine refresh', enabled: false } });
    assert.equal(draft.title, 'Pristine refresh', 'Browser Solid effects refresh a clean draft');
    for (const [revision, newerEdit] of [
      [11, false],
      [13, true],
    ] as const) {
      draft = { ...draft, title: 'Submitted' };
      const pending = form.save();
      assert.equal(requests.at(-1)!.revision, revision - 1, 'Use the refreshed revision');
      if (newerEdit) draft = { ...draft, title: 'Newer local edit' };
      setRemote({
        revision: revision + 1,
        values: { title: 'Newer remote value', enabled: false },
      });
      assert.equal(
        draft.title,
        newerEdit ? 'Newer local edit' : 'Submitted',
        'A pending save holds its draft through invalidation',
      );
      resolve({ revision, values: { title: 'Submitted', enabled: false } });
      assert.equal(await pending, !newerEdit);
      assert.equal(remote().revision, revision + 1, 'The late response cannot revert remote state');
      assert.equal(
        draft.title,
        newerEdit ? 'Newer local edit' : 'Newer remote value',
        'Save completion refreshes only a clean draft',
      );
      assert.equal(form.isDirty(), newerEdit);
    }
    const conflicted = form.save();
    assert.equal(
      requests.at(-1)!.revision,
      13,
      'A preserved local edit keeps its baseline revision',
    );
    reject(Object.assign(new Error('Conflict'), { status: 409 }));
    assert.equal(await conflicted, false);
    assert.equal(draft.title, 'Newer local edit');
    form.discard();
    assert.equal(draft.title, 'Newer remote value');
  } finally {
    dispose();
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

  try {
    mockFetch(() => byteResponse('data: {"d":"A😀"}\r\n\r\ndata: {"d":"B"}\ndata: {"done":true}'));
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

    mockFetch(() => byteResponse('data: {"d":"partial"}\n'));
    await assert.rejects(
      streamTextCompletion('/test', {}, () => {}, 'test'),
      /ended before completion/,
    );
    mockFetch(() => byteResponse('data: {"error":"upstream failure"}\n'));
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
    mockFetch((_url, init) => {
      assert.deepEqual(JSON.parse(init?.body as string), {
        draft: 'Original',
        expectedActiveLeafId: 3,
        expectedMutationRevision: 9,
      });
      return byteResponse('data: {"d":" suffix"}\ndata: {"done":true}');
    });
    assert.equal(await completeComposerDraft(options), true);
    assert.deepEqual(draftTexts, ['Original suffix']);

    draftTexts.length = 0;
    mockFetch(() => byteResponse('data: {"d":" partial"}\ndata: {"error":"stale draft"}\n'));
    await assert.rejects(completeComposerDraft(options), /stale draft/);
    assert.deepEqual(draftTexts, ['Original partial', 'Original']);

    draftTexts.length = 0;
    mockFetch((_url, init) => {
      const stream = controlledStream(init?.signal);
      stream.write('data: {"d":" cancelled"}\n');
      return new Response(stream.body);
    });
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

    const expected = { activeLeafId: null, mutationRevision: 42 };
    mockFetch((url, init) => {
      assert.equal(url, '/api/conversations/7/messages');
      assert.deepEqual(JSON.parse(init?.body as string), {
        content: 'hello',
        expectedActiveLeafId: null,
        expectedMutationRevision: 42,
      });
      return Response.json({ userMessageId: 1, assistantMessageId: 2 });
    });
    await api.send(7, expected, { content: 'hello' });
    mockFetch((url, init) => {
      assert.equal(url, '/api/messages/8?expectedActiveLeafId=null&expectedMutationRevision=42');
      assert.equal(init?.method, 'DELETE');
      assert.equal(init?.body, undefined);
      return new Response(null, { status: 204 });
    });
    await api.deleteMessage(8, expected);
    assert.deepEqual(expected, { activeLeafId: null, mutationRevision: 42 });

    let authenticationRequests = 0;
    setAuthenticationRequiredHandler(() => authenticationRequests++);
    mockFetch(() => Response.json({ error: 'locked' }, { status: 401 }));
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
    watchConversation(owner: object, conversationId: number | null): void;
  }
  // A dynamic path excludes browser code from the server's DOM-free type graph;
  // client tsconfig checks it, and this test supplies runtime browser globals.
  const wsModulePath = '../../client/src/state/ws.ts';
  const { configureWs, startWs, stopWs, subscribe, watchConversation } = (await import(
    wsModulePath
  )) as WsModule;
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

  const mediaOwner = {};
  watchConversation(mediaOwner, 73);
  assert.deepEqual(JSON.parse(third.sent.at(-1)!), { subs: [42, 73], resync: 73 });
  const duplicateOwner = {};
  watchConversation(duplicateOwner, 73);
  assert.deepEqual(JSON.parse(third.sent.at(-1)!), { subs: [42, 73], resync: 73 });
  watchConversation(mediaOwner, null);
  assert.deepEqual(JSON.parse(third.sent.at(-1)!), { subs: [42, 73] });
  watchConversation(duplicateOwner, null);
  assert.deepEqual(JSON.parse(third.sent.at(-1)!), { sub: 42 });
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
