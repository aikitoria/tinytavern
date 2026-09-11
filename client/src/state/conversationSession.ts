import { batch, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js';
import { produce, reconcile, type SetStoreFunction } from 'solid-js/store';
import type {
  Character,
  Conversation,
  Endpoint,
  GenerationMetrics,
  Message,
  Persona,
  ServerEvent,
  Settings,
  Template,
} from '@tinytavern/shared';
import { api, ApiError } from './api.ts';
import { afterOperationEnd, afterTreeFrame } from './swipeSync.ts';
import { createMessageSelection } from './conversationSelection.ts';
import { createDraftCompletion } from './draftCompletion.ts';
import { createMapSearch } from '../components/tree/mapSearchState.ts';

export interface ConversationState {
  selectedId: number | null;
  viewMode: 'chat' | 'trace' | 'map';
  treeNavigationPending: boolean;
  tree: {
    conversationId: number | null;
    messages: Record<number, Message>;
    activeLeafId: number | null;
    mutationRevision: number;
  };
}
export interface ConversationEnvironment {
  conversations: Conversation[];
  characters: Character[];
  personas: Persona[];
  templates: Template[];
  endpoints: Endpoint[];
  settings: Settings;
  connected: boolean;
  booted: boolean;
}
export interface PendingSwipe {
  /** Unique operation identity; message ids can recur across rapid back-and-forth swipes. */
  token: number;
  conversationId: number;
  /** Active leaf observed when the operation began. */
  sourceLeafId: number | null;
  /** Sibling group the swipe happens in (-1 for root messages). */
  parentKey: number;
  /** The message sliding out. */
  outgoingId: number;
  /** 1 = next sibling (out to the left, in from the right), -1 = previous. */
  dir: 1 | -1;
}

function ownMetrics(metrics: GenerationMetrics): GenerationMetrics {
  return { ...metrics, attempts: metrics.attempts.map((attempt) => ({ ...attempt })) };
}

/** Views can receive the same frame. Copy mutable records, retaining immutable text strings. */
function ownMessage(message: Message): Message {
  return {
    ...message,
    media: message.media.map((asset) => ({ ...asset })),
    genMeta: message.genMeta
      ? {
          ...message.genMeta,
          ...(message.genMeta.generations
            ? { generations: message.genMeta.generations.map(ownMetrics) }
            : {}),
        }
      : null,
  };
}

/** One view's state and operations; shared application collections are read through the host. */
export function createConversationSession(
  state: ConversationState & ConversationEnvironment,
  setState: SetStoreFunction<ConversationState>,
  options: {
    subscribe: (id: number) => void;
    refresh: () => void;
    toast: (message: string) => void;
    conversation?: Accessor<Conversation | null>;
    onSnapshot?: () => void;
    draftCompletion?: ReturnType<typeof createDraftCompletion>;
  },
) {
  const selectedConversation = createMemo(
    () =>
      state.conversations.find((c) => c.id === state.selectedId) ??
      options.conversation?.() ??
      null,
  );

  const selectedCharacter = createMemo(() => {
    const conv = selectedConversation();
    return conv?.characterId != null
      ? (state.characters.find((c) => c.id === conv.characterId) ?? null)
      : null;
  });

  const selectedPersona = createMemo(() => {
    const conv = selectedConversation();
    return conv?.personaId != null
      ? (state.personas.find((p) => p.id === conv.personaId) ?? null)
      : null;
  });

  const personasEnabled = createMemo(() => {
    if (selectedConversation()?.promptMode === 'media') return false;
    const character = selectedCharacter();
    if (character?.customTemplate) return character.customTemplate.usesPersonas;
    const templateId = character?.templateId ?? state.settings.defaultTemplateId;
    const template =
      templateId != null ? state.templates.find((t) => t.id === templateId) : undefined;
    return template?.usesPersonas ?? true;
  });

  /** Root-to-leaf order. */
  const activePath = createMemo<Message[]>(() => {
    const tree = state.tree;
    const path: Message[] = [];
    let cur = tree.activeLeafId;
    while (cur != null) {
      const msg = tree.messages[cur];
      if (!msg) break;
      path.push(msg);
      cur = msg.parentId;
    }
    return path.reverse();
  });

  /** Roots use key -1; children are ordered by id. */
  const childrenByParent = createMemo<Map<number, Message[]>>(() => {
    const map = new Map<number, Message[]>();
    for (const msg of Object.values(state.tree.messages)) {
      const key = msg.parentId ?? -1;
      const list = map.get(key);
      if (list) list.push(msg);
      else map.set(key, [msg]);
    }
    for (const list of map.values()) list.sort((a, b) => a.id - b.id);
    return map;
  });

  function siblingsOf(message: Message): Message[] {
    return childrenByParent().get(message.parentId ?? -1) ?? [];
  }

  const streamingMessage = createMemo<Message | null>(() => {
    for (const msg of activePath()) {
      if (msg.status === 'streaming') return msg;
    }
    return null;
  });

  function handleEvent(ev: ServerEvent): void {
    switch (ev.t) {
      case 'tree':
        if (ev.conversationId === state.selectedId) {
          resyncPendingFor = null;
          options.onSnapshot?.();
          batch(() => {
            setState('tree', 'conversationId', ev.conversationId);
            setState('tree', 'activeLeafId', ev.activeLeafId);
            setState('tree', 'mutationRevision', ev.mutationRevision);
            // Reconcile keeps object identity for unchanged messages so the DOM
            // (and scroll position) survives branch switches.
            setState(
              'tree',
              'messages',
              reconcile(Object.fromEntries(ev.messages.map((m) => [m.id, ownMessage(m)])), {
                key: 'id',
              }),
            );
          });
          consumePendingSwipe(ev.conversationId, ev.activeLeafId);
        }
        break;
      case 'treePatch': {
        // Patches only apply on top of a full snapshot for the same conversation.
        if (
          ev.conversationId !== state.selectedId ||
          state.tree.conversationId !== ev.conversationId
        )
          break;
        const bodies = new Map(ev.messages.map((m) => [m.id, m]));
        // A node we've never seen and no body for means a missed frame — resync.
        if (ev.nodes.some((node) => !bodies.has(node.id) && !state.tree.messages[node.id])) {
          // Repeat subscriptions push snapshots; allow only one outstanding resync.
          if (resyncPendingFor !== ev.conversationId) {
            resyncPendingFor = ev.conversationId;
            resyncTree();
          }
          break;
        }
        batch(() => {
          setState('tree', 'activeLeafId', ev.activeLeafId);
          setState('tree', 'mutationRevision', ev.mutationRevision);
          setState(
            'tree',
            'messages',
            produce((messages) => {
              const alive = new Set(ev.nodes.map((node) => node.id));
              for (const key of Object.keys(messages)) {
                if (!alive.has(Number(key))) delete messages[Number(key)];
              }
              for (const node of ev.nodes) {
                const body = bodies.get(node.id);
                if (body) {
                  const existing = messages[node.id];
                  // The timeline is keyed by reference; preserve identity to retain MessageNode UI state.
                  if (existing) Object.assign(existing, ownMessage(body));
                  else messages[node.id] = ownMessage(body);
                } else {
                  const msg = messages[node.id]!;
                  // parentId too: splice deletions and block moves reparent
                  // messages without resending their bodies.
                  msg.parentId = node.parentId;
                  msg.activeChildId = node.activeChildId;
                  msg.status = node.status;
                  msg.generationKind = node.generationKind;
                  msg.generationToken = node.generationToken;
                }
              }
            }),
          );
        });
        consumePendingSwipe(ev.conversationId, ev.activeLeafId);
        break;
      }
      case 'generationMetrics': {
        const message = state.tree.messages[ev.mid];
        if (
          message?.status !== 'streaming' ||
          message.generationToken !== ev.metrics.generationToken
        )
          break;
        setState(
          'tree',
          'messages',
          ev.mid,
          produce((msg) => {
            msg.genMeta ??= {};
            const generations = (msg.genMeta.generations ??= []);
            // Copies/imports retain measurements but restart conversation revision numbering.
            const index = generations.findLastIndex(
              (entry) =>
                entry.generationToken === ev.metrics.generationToken && entry.elapsedMs == null,
            );
            if (index === -1) generations.push(ownMetrics(ev.metrics));
            else generations[index] = ownMetrics(ev.metrics);
          }),
        );
        break;
      }
      case 'delta': {
        if (!state.tree.messages[ev.mid]) break;
        setState(
          'tree',
          'messages',
          ev.mid,
          produce((msg) => {
            if (ev.d) msg.content += ev.d;
            if (ev.r) msg.reasoning = (msg.reasoning ?? '') + ev.r;
          }),
        );
        break;
      }
      case 'final': {
        // A final for an abandoned conversation (mid-switch) must not toast here.
        if (ev.conversationId !== state.selectedId) break;
        setState('tree', 'mutationRevision', ev.mutationRevision);
        // Speculative swipes retry quietly in the background.
        if (ev.message.status === 'error' && ev.message.generationKind !== 'speculative') {
          options.toast(ev.message.genMeta?.error ?? 'Generation failed');
        }
        if (state.tree.messages[ev.message.id]) {
          // Preserve MessageNode identity and UI state, as in treePatch.
          setState(
            'tree',
            'messages',
            ev.message.id,
            produce((msg) => Object.assign(msg, ownMessage(ev.message))),
          );
        }
        break;
      }
    }
  }
  /** Outstanding gap-triggered resync; cleared by its tree snapshot. */
  let resyncPendingFor: number | null = null;

  /** WS snapshots stay ordered with patches/deltas; a REST fetch could revert an edited body. */
  function resyncTree(): void {
    if (state.selectedId != null) options.subscribe(state.selectedId);
  }

  let disposed = false;
  let navigationToken = 0;

  async function navigateTree(action: () => Promise<unknown>): Promise<boolean> {
    if (disposed || state.treeNavigationPending) return false;
    const token = ++navigationToken;
    const conversationId = state.selectedId;
    const current = () =>
      !disposed && token === navigationToken && conversationId === state.selectedId;
    setState('treeNavigationPending', true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A blackholed fetch must not leave all tree navigation permanently pending.
      await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Request timed out — check your connection.')),
            15000,
          );
        }),
      ]);
      return current();
    } catch (err) {
      if (!current()) return false;
      options.toast(err instanceof Error ? err.message : String(err));
      if (err instanceof ApiError && err.status === 409) resyncTree();
      return false;
    } finally {
      clearTimeout(timer);
      if (current()) setState('treeNavigationPending', false);
    }
  }

  const [pendingSwipe, setPendingSwipe] = createSignal<PendingSwipe | null>(null);
  let swipeToken = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  /** Keep the animation through the branch-change mount, then clear it before unrelated mounts. */
  function consumePendingSwipe(conversationId: number, activeLeafId: number | null): void {
    setPendingSwipe((pending) => afterTreeFrame(pending, conversationId, activeLeafId));
  }

  function clearPendingSwipe(token: number): void {
    setPendingSwipe((pending) => afterOperationEnd(pending, token));
  }

  /** Set to a message id to ask that MessageNode to open its in-place editor (composer ↑ key). */
  const [editRequestId, setEditRequestId] = createSignal<number | null>(null);

  /** pendingSwipe holds the outgoing slide until the incoming sibling mounts. */
  async function swipeToSibling(message: Message, dir: 1 | -1): Promise<void> {
    if (state.treeNavigationPending) return;
    const siblings = siblingsOf(message);
    const idx = siblings.findIndex((m) => m.id === message.id);
    let action: (() => Promise<unknown>) | null = null;
    // Only assistants generate new siblings past the end.
    if (dir === -1 || message.role !== 'assistant') {
      const target = siblings[idx + dir];
      if (target) action = () => api.activate(target.id, state.tree);
    } else {
      action = () => api.advance(message.id, state.tree);
    }
    if (!action) return;
    const token = ++swipeToken;
    setPendingSwipe({
      token,
      conversationId: message.conversationId,
      sourceLeafId: state.tree.activeLeafId,
      parentKey: message.parentId ?? -1,
      outgoingId: message.id,
      dir,
    });
    const ok = await navigateTree(action);
    if (!ok) {
      clearPendingSwipe(token); // spring back, unless a newer swipe has replaced this one
      return;
    }
    // A successful mutation may send its frame to a stale mobile-PWA socket.
    // Reconnect, holding the outgoing slide until the snapshot mounts the branch.
    later(() => {
      if (pendingSwipe()?.token === token) options.refresh();
    }, 750);
    // Spring back if reconnect never supplies the authoritative tree.
    later(() => clearPendingSwipe(token), 5000);
  }

  const selection = createMessageSelection(state, activePath);
  const draftCompletion = options.draftCompletion ?? createDraftCompletion();
  const mapSearch = createMapSearch({ personasEnabled, selectedPersona, selectedCharacter });
  const [touchedId, setTouchedId] = createSignal<number | null>(null);
  const [moreMenuId, setMoreMenuId] = createSignal<number | null>(null);
  function reset() {
    navigationToken++;
    resyncPendingFor = null;
    setState('treeNavigationPending', false);
    setPendingSwipe(null);
    setEditRequestId(null);
    setTouchedId(null);
    setMoreMenuId(null);
    selection.clearMessageSelection();
    draftCompletion.stopDraftCompletion();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }
  onCleanup(() => {
    disposed = true;
    reset();
  });
  return {
    state,
    setState,
    selectedConversation,
    selectedCharacter,
    selectedPersona,
    personasEnabled,
    activePath,
    childrenByParent,
    siblingsOf,
    streamingMessage,
    handleEvent,
    reset,
    navigateTree,
    pendingSwipe,
    setPendingSwipe,
    editRequestId,
    setEditRequestId,
    swipeToSibling,
    ...selection,
    ...draftCompletion,
    ...mapSearch,
    touchedId,
    setTouchedId,
    moreMenuId,
    setMoreMenuId,
  };
}
export type ConversationSession = ReturnType<typeof createConversationSession>;
