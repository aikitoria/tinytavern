import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import {
  DEFAULT_SETTINGS,
  type Conversation,
  type Message,
  type ServerEvent,
} from '@tinytavern/shared';

// Import dynamically so the server test type graph does not pull in browser-only API types.
test('conversation sessions isolate tree streams, edits, selections, swipes and map navigation', async () => {
  const modulePath = '../../client/src/state/conversationSession.ts';
  const { createConversationSession } = await import(modulePath);
  let dispose!: () => void;
  const resyncs: number[] = [];
  const make = (id: number) => {
    const conversation: Conversation = {
      id,
      title: `Conversation ${id}`,
      characterId: null,
      personaId: null,
      endpointId: null,
      speakerName: null,
      scenarioOverride: null,
      activeLeafId: null,
      mutationRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const [state, setState] = createStore({
      selectedId: id,
      viewMode: 'chat' as 'chat' | 'map' | 'trace',
      treeNavigationPending: false,
      tree: {
        conversationId: null as number | null,
        messages: {} as Record<number, Message>,
        activeLeafId: null as number | null,
        mutationRevision: 0,
      },
      conversations: [conversation],
      characters: [],
      personas: [],
      templates: [],
      endpoints: [],
      settings: DEFAULT_SETTINGS,
      connected: true,
      booted: true,
    });
    return createConversationSession(state, setState, {
      subscribe: (id: number) => resyncs.push(id),
      refresh: () => {},
      toast: (error: string) => {
        throw new Error(error);
      },
    });
  };
  const [main, embedded] = createRoot((cleanup) => {
    dispose = cleanup;
    return [make(1), make(2)];
  });
  function message(
    id: number,
    conversationId: number,
    parentId: number | null,
    content: string,
    role: 'user' | 'assistant' = 'assistant',
  ): Message {
    return {
      id,
      conversationId,
      parentId,
      content,
      role,
      reasoning: null,
      status: 'done',
      activeChildId: null,
      model: null,
      name: null,
      genMeta: null,
      generationKind: 'normal',
      generationToken: null,
      media: [],
      activeImage: 0,
      imagePending: false,
      hasImageRender: false,
      createdAt: 1,
    };
  }
  try {
    const first = message(10, 1, null, 'Main chat', 'user');
    const user = message(20, 2, null, 'Initial instruction', 'user');
    const assistant = {
      ...message(21, 2, 20, 'Prompt'),
      status: 'streaming' as const,
      generationToken: 3,
    };
    const snapshot = {
      t: 'tree' as const,
      conversationId: 2,
      messages: [user, assistant],
      activeLeafId: 21,
      mutationRevision: 3,
    };
    main.handleEvent({
      t: 'tree',
      conversationId: 1,
      messages: [first],
      activeLeafId: 10,
      mutationRevision: 1,
    });
    main.handleEvent(snapshot);
    embedded.handleEvent(snapshot);
    for (const session of [main, embedded])
      session.handleEvent({ t: 'delta', mid: 21, d: ' revision' });
    assert.equal(main.state.tree.messages[21], undefined);
    assert.equal(embedded.state.tree.messages[21].content, 'Prompt revision');
    main.startMessageSelection(10);
    embedded.startMessageSelection(20);
    embedded.setEditRequestId(21);
    embedded.setMapSearchQuery('Prompt');
    assert.deepEqual(main.selectedMessageRange().messageIds, [10]);
    assert.deepEqual(embedded.selectedMessageRange().messageIds, [20]);
    assert.equal(main.editRequestId(), null);
    assert.equal(main.mapSearchQuery(), '');
    const identity = embedded.state.tree.messages[21];
    embedded.setPendingSwipe({
      token: 1,
      conversationId: 2,
      sourceLeafId: 21,
      parentKey: 20,
      outgoingId: 21,
      dir: 1,
    });
    const sibling = message(22, 2, 20, 'Another prompt');
    const followup = message(23, 2, 22, 'Follow up', 'user');
    const nodes = [user, assistant, sibling, followup].map(
      ({ id, parentId, activeChildId, status, generationKind, generationToken }) => ({
        id,
        parentId,
        activeChildId,
        status,
        generationKind,
        generationToken,
      }),
    );
    embedded.handleEvent({
      t: 'treePatch',
      conversationId: 2,
      nodes,
      messages: [sibling, followup],
      activeLeafId: 23,
      mutationRevision: 4,
    });
    assert.strictEqual(embedded.state.tree.messages[21], identity);
    assert.deepEqual(
      embedded.activePath().map((m: Message) => m.id),
      [20, 22, 23],
    );
    assert.equal(embedded.pendingSwipe(), null);
    assert.deepEqual(
      main.activePath().map((m: Message) => m.id),
      [10],
    );
    const missing = { ...nodes[0], id: 99 };
    embedded.handleEvent({
      t: 'treePatch',
      conversationId: 2,
      nodes: [...nodes, missing],
      messages: [],
      activeLeafId: 99,
      mutationRevision: 5,
    });
    embedded.handleEvent({
      t: 'treePatch',
      conversationId: 2,
      nodes: [...nodes, missing],
      messages: [],
      activeLeafId: 99,
      mutationRevision: 5,
    });
    assert.deepEqual(resyncs, [2], 'A missed patch resyncs only its own session, once');
    let finish!: () => void;
    const operation = embedded.navigateTree(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    assert.equal(embedded.state.treeNavigationPending, true);
    assert.equal(main.state.treeNavigationPending, false);
    finish();
    assert.equal(await operation, true);
    const abandoned = embedded.navigateTree(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const finishAbandoned = finish;
    embedded.reset();
    const replacement = embedded.navigateTree(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    finishAbandoned();
    assert.equal(await abandoned, false);
    assert.equal(
      embedded.state.treeNavigationPending,
      true,
      'An old operation cannot unlock a newer session operation',
    );
    finish();
    assert.equal(await replacement, true);
  } finally {
    dispose();
  }
});

test('two views of one conversation own their messages and append each streamed chunk once', async () => {
  const modulePath = '../../client/src/state/conversationSession.ts';
  const { createConversationSession } = await import(modulePath);
  const message: Message = {
    id: 1,
    conversationId: 1,
    parentId: null,
    activeChildId: null,
    role: 'assistant',
    content: 'Prompt',
    reasoning: null,
    name: null,
    model: null,
    status: 'streaming',
    generationKind: 'normal',
    generationToken: 1,
    genMeta: { generations: [] },
    media: [],
    activeImage: 0,
    imagePending: false,
    hasImageRender: false,
    createdAt: 1,
  };
  let dispose!: () => void;
  const sessions = createRoot((cleanup) => {
    dispose = cleanup;
    return [0, 1].map(() => {
      const [state, setState] = createStore({
        selectedId: 1,
        viewMode: 'chat' as 'chat' | 'map' | 'trace',
        treeNavigationPending: false,
        tree: {
          conversationId: null as number | null,
          messages: {} as Record<number, Message>,
          activeLeafId: null as number | null,
          mutationRevision: 0,
        },
        conversations: [],
        characters: [],
        personas: [],
        templates: [],
        endpoints: [],
        settings: DEFAULT_SETTINGS,
        connected: true,
        booted: true,
      });
      return createConversationSession(state, setState, {
        subscribe: () => {},
        refresh: () => {},
        toast: (error: string) => assert.fail(error),
      });
    });
  });
  const broadcast = (event: ServerEvent) => {
    const before = structuredClone(event);
    for (const session of sessions) session.handleEvent(event);
    assert.deepEqual(event, before, 'Session writes cannot mutate a shared transport frame');
  };
  const patch = (body: Message): ServerEvent => ({
    t: 'treePatch',
    conversationId: 1,
    activeLeafId: body.id,
    mutationRevision: 1,
    nodes: [body],
    messages: [body],
  });
  try {
    const frames: ServerEvent[] = [
      { t: 'tree', conversationId: 1, activeLeafId: 1, mutationRevision: 1, messages: [message] },
      patch({ ...message, id: 2 }), // Newly inserted patch bodies must also be owned.
      patch({ ...message, id: 2, content: 'Revised' }),
      {
        t: 'final',
        conversationId: 1,
        mutationRevision: 1,
        message: { ...message, id: 2, status: 'done' },
      },
    ];
    for (const frame of frames) {
      broadcast(frame);
      const id = sessions[0].state.tree.activeLeafId!;
      const current = sessions[0].state.tree.messages[id];
      const content = current.content;
      const identities = sessions.map((session) => session.state.tree.messages[id]);
      if (frame.t === 'final') {
        // Continuation changes structure first, retaining the final frame's metadata.
        broadcast({
          t: 'treePatch',
          conversationId: 1,
          activeLeafId: id,
          mutationRevision: 2,
          nodes: [{ ...message, id }],
          messages: [],
        });
      }
      broadcast({
        t: 'generationMetrics',
        mid: id,
        metrics: {
          generationToken: 1,
          model: null,
          continuation: frame.t === 'final',
          speculative: false,
          attempts: [{ firstTokenMs: 1 }],
        },
      });
      broadcast({ t: 'delta', mid: id, d: ' chunk', r: 'reasoning' });
      for (const [index, session] of sessions.entries()) {
        const actual = session.state.tree.messages[id];
        assert.strictEqual(
          actual,
          identities[index],
          'Updates retain each view’s message identity',
        );
        assert.equal(actual.content, content + ' chunk');
        assert.equal(actual.reasoning, 'reasoning');
        assert.equal(actual.genMeta.generations.length, 1);
      }
      assert.notStrictEqual(identities[0], identities[1]);
      assert.notStrictEqual(identities[0].genMeta.generations, identities[1].genMeta.generations);
      assert.notStrictEqual(
        identities[0].genMeta.generations[0].attempts,
        identities[1].genMeta.generations[0].attempts,
      );
    }
  } finally {
    dispose();
  }
});
