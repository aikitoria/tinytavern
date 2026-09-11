import { createSignal, onCleanup } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { Conversation } from '@tinytavern/shared';
import {
  createConversationSession,
  type ConversationState,
  type ConversationEnvironment,
} from './conversationSession.ts';
import { state as app, registerConversationSession, toast } from './store.ts';
import { refreshWs, watchConversation } from './ws.ts';

export function createEmbeddedConversation() {
  const [local, setLocal] = createStore<ConversationState>({
    selectedId: null,
    viewMode: 'chat',
    treeNavigationPending: false,
    tree: { conversationId: null, messages: {}, activeLeafId: null, mutationRevision: 0 },
  });
  const [conversation, setConversation] = createSignal<Conversation | null>(null);
  const owner = {};
  const state: ConversationState & ConversationEnvironment = {
    get selectedId() {
      return local.selectedId;
    },
    get viewMode() {
      return local.viewMode;
    },
    get treeNavigationPending() {
      return local.treeNavigationPending;
    },
    get tree() {
      return local.tree;
    },
    get conversations() {
      return app.conversations;
    },
    get characters() {
      return app.characters;
    },
    get personas() {
      return app.personas;
    },
    get templates() {
      return app.templates;
    },
    get endpoints() {
      return app.endpoints;
    },
    get settings() {
      return app.settings;
    },
    get connected() {
      return app.connected;
    },
    get booted() {
      return app.booted;
    },
  };
  const session = createConversationSession(state, setLocal, {
    conversation,
    subscribe: (id) => watchConversation(owner, id),
    refresh: refreshWs,
    toast,
  });
  const unregister = registerConversationSession(session);
  onCleanup(() => {
    unregister();
    watchConversation(owner, null);
  });
  function select(next: Conversation, reset = false) {
    setConversation(next);
    if (local.selectedId === next.id && !reset) return;
    setLocal({
      selectedId: next.id,
      treeNavigationPending: false,
      tree: { conversationId: null, messages: {}, activeLeafId: null, mutationRevision: 0 },
    });
    session.reset();
    watchConversation(owner, next.id);
  }
  return { session, select };
}
