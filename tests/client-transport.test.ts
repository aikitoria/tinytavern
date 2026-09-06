import assert from 'node:assert/strict';

// Dynamic paths keep browser-only types out of the server typecheck.
const apiPath = '../client/src/state/api.ts';
const draftPath = '../client/src/state/draftCompletion.ts';
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
  globalThis.fetch = async () =>
    response('data: {"d":"A😀"}\r\n\r\ndata: {"d":"B"}\ndata: {"done":true}');
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

  globalThis.fetch = async () => response('data: {"d":"partial"}\n');
  await assert.rejects(
    streamTextCompletion('/test', {}, () => {}, 'test'),
    /ended before completion/,
  );
  globalThis.fetch = async () => response('data: {"error":"upstream failure"}\n');
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
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(init?.body as string), {
      draft: 'Original',
      expectedActiveLeafId: 3,
      expectedMutationRevision: 9,
    });
    return response('data: {"d":" suffix"}\ndata: {"done":true}');
  };
  assert.equal(await completeComposerDraft(options), true);
  assert.deepEqual(draftTexts, ['Original suffix']);

  draftTexts.length = 0;
  globalThis.fetch = async () =>
    response('data: {"d":" partial"}\ndata: {"error":"stale draft"}\n');
  await assert.rejects(completeComposerDraft(options), /stale draft/);
  assert.deepEqual(draftTexts, ['Original partial', 'Original']);

  draftTexts.length = 0;
  globalThis.fetch = async (_url, init) =>
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
    );
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
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          progressController = controller;
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
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
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/conversations/7/messages');
    assert.deepEqual(JSON.parse(init?.body as string), {
      content: 'hello',
      expectedActiveLeafId: null,
      expectedMutationRevision: 42,
    });
    return Response.json({ userMessageId: 1, assistantMessageId: 2 });
  };
  await api.send(7, 'hello', expected);
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/messages/8?expectedActiveLeafId=null&expectedMutationRevision=42');
    assert.equal(init?.method, 'DELETE');
    assert.equal(init?.body, undefined);
    return new Response(null, { status: 204 });
  };
  await api.deleteMessage(8, expected);
  assert.deepEqual(expected, { activeLeafId: null, mutationRevision: 42 });

  let authenticationRequests = 0;
  setAuthenticationRequiredHandler(() => authenticationRequests++);
  globalThis.fetch = async () => Response.json({ error: 'locked' }, { status: 401 });
  await assert.rejects(api.conversations(), /locked/);
  assert.equal(authenticationRequests, 1);
  await assert.rejects(api.login('bad'), /locked/);
  assert.equal(authenticationRequests, 1, 'login errors do not recursively trigger authentication');
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

console.log('client transport and draft lifecycle tests passed');
