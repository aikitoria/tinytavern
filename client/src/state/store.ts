import { createMemo, createRoot, createSignal, batch } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import type {
  Character,
  CharacterFolder,
  Conversation,
  Endpoint,
  GalleryItem,
  InvalidateEntity,
  Message,
  Persona,
  Preset,
  ServerEvent,
  Settings,
  Template,
} from '@tinytavern/shared';
import { DEFAULT_SETTINGS } from '@tinytavern/shared';
import { api, ApiError } from './api.ts';
import { refreshWs, subscribe } from './ws.ts';
import {
  applyImageProgress,
  retainPendingImageProgress,
  type ImageProgressState,
} from './imageProgressSync.ts';
import { isCurrentSettingsRevision, SuccessfulFetchSequence, upsertById } from './sync.ts';
import { afterOperationEnd, afterTreeFrame } from './swipeSync.ts';

export type ModalKind = 'settings' | 'conversation' | 'gallery' | null;

export interface GalleryRenderState {
  jobId: string;
  sourceItemId: number;
  characterId: number | null;
  characterName: string;
  prompt: string;
  preview?: string;
  value?: number;
  max?: number;
}

const GROUP_BY_CHARACTER_KEY = 'tinytavern.groupByCharacter';

function loadGroupByCharacter(): boolean {
  try {
    return localStorage.getItem(GROUP_BY_CHARACTER_KEY) === '1';
  } catch {
    /* Storage may be unavailable in hardened/private browser contexts. */
    return false;
  }
}

interface TreeState {
  conversationId: number | null;
  messages: Record<number, Message>;
  activeLeafId: number | null;
  mutationRevision: number;
}

interface AppState {
  conversations: Conversation[];
  characters: Character[];
  characterFolders: CharacterFolder[];
  presets: Preset[];
  templates: Template[];
  personas: Persona[];
  endpoints: Endpoint[];
  gallery: GalleryItem[];
  /** Client-local live cards for gallery renders; final items are server-owned. */
  galleryRenders: GalleryRenderState[];
  settings: Settings;
  connected: boolean;
  booted: boolean;
  selectedId: number | null;
  sidebarOpen: boolean;
  groupByCharacter: boolean;
  modal: ModalKind;
  settingsCharacterId: number | null;
  /** 'trace' replaces the timeline with the assembled upstream request;
   * 'tree'/'map' show the conversation tree as an outline / zoomable 2D map. */
  viewMode: 'chat' | 'trace' | 'tree' | 'map';
  treeNavigationPending: boolean;
  toasts: { id: number; text: string; kind: ToastKind }[];
  tree: TreeState;
}

export const [state, setState] = createStore<AppState>({
  conversations: [],
  characters: [],
  characterFolders: [],
  presets: [],
  templates: [],
  personas: [],
  endpoints: [],
  gallery: [],
  galleryRenders: [],
  settings: { ...DEFAULT_SETTINGS },
  connected: false,
  booted: false,
  selectedId: null,
  sidebarOpen: false,
  groupByCharacter: loadGroupByCharacter(),
  modal: null,
  settingsCharacterId: null,
  viewMode: 'chat',
  treeNavigationPending: false,
  toasts: [],
  tree: { conversationId: null, messages: {}, activeLeafId: null, mutationRevision: 0 },
});

let toastCounter = 0;
export type ToastKind = 'error' | 'warning' | 'info' | 'success';

export function toast(text: string, kind: ToastKind = 'error'): void {
  const id = ++toastCounter;
  setState('toasts', (toasts) => [...toasts, { id, text, kind }]);
  setTimeout(() => setState('toasts', (toasts) => toasts.filter((t) => t.id !== id)), 4500);
}

/** App-lifetime root avoids Solid's warning about unowned computations; never disposed. */
const globalMemo = <T>(fn: () => T) => createRoot(() => createMemo(fn));

export const selectedConversation = globalMemo(
  () => state.conversations.find((c) => c.id === state.selectedId) ?? null,
);

export const selectedCharacter = globalMemo(() => {
  const conv = selectedConversation();
  return conv?.characterId != null
    ? (state.characters.find((c) => c.id === conv.characterId) ?? null)
    : null;
});

export const selectedPersona = globalMemo(() => {
  const conv = selectedConversation();
  return conv?.personaId != null
    ? (state.personas.find((p) => p.id === conv.personaId) ?? null)
    : null;
});

export const personasEnabled = globalMemo(() => {
  const character = selectedCharacter();
  if (character?.customTemplate) return character.customTemplate.usesPersonas;
  const templateId = character?.templateId ?? state.settings.defaultTemplateId;
  const template =
    templateId != null ? state.templates.find((t) => t.id === templateId) : undefined;
  return template?.usesPersonas ?? true;
});

/** Root-to-leaf order. */
export const activePath = globalMemo<Message[]>(() => {
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
export const childrenByParent = globalMemo<Map<number, Message[]>>(() => {
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

export function siblingsOf(message: Message): Message[] {
  return childrenByParent().get(message.parentId ?? -1) ?? [];
}

export const streamingMessage = globalMemo<Message | null>(() => {
  for (const msg of activePath()) {
    if (msg.status === 'streaming') return msg;
  }
  return null;
});

const LAST_CONVERSATION_KEY = 'tinytavern.lastConversationId';
let conversationsLoaded = false;
let selectionRestored = false;
/** The boot cover waits only for the initial restored tree. */
const [initialTreeLoaded, setInitialTreeLoaded] = createSignal(false);

function persistSelectedConversation(id: number | null): void {
  try {
    if (id == null) localStorage.removeItem(LAST_CONVERSATION_KEY);
    else localStorage.setItem(LAST_CONVERSATION_KEY, String(id));
  } catch {
    /* Storage may be unavailable in hardened/private browser contexts. */
  }
}

// Overlapping refetches can resolve out of order; reject stale responses per entity.
const fetchSeq = new SuccessfulFetchSequence<InvalidateEntity>();

// Delete invalidations can beat the HTTP response; don't mistake local deletes for peer deletes.
const locallyDeletingConversationIds = new Set<number>();
let locallyDeletingAllConversations = false;

function loader<T>(
  entity: InvalidateEntity,
  fetch: () => Promise<T>,
  apply: (data: T) => void,
): () => Promise<void> {
  return async () => {
    const seq = fetchSeq.start(entity);
    const data = await fetch();
    // Only a later successful request makes this response stale.
    if (!fetchSeq.accept(entity, seq)) return;
    apply(data);
  };
}

const loaders: Record<InvalidateEntity, () => Promise<void>> = {
  conversations: loader('conversations', api.conversations, (conversations) => {
    conversationsLoaded = true;
    setState('conversations', reconcile(conversations, { key: 'id' }));
    if (
      selectionRestored &&
      state.selectedId != null &&
      !conversations.some((conversation) => conversation.id === state.selectedId)
    ) {
      const deletedId = state.selectedId;
      selectConversation(null);
      if (!locallyDeletingAllConversations && !locallyDeletingConversationIds.has(deletedId)) {
        toast('This conversation was deleted on another device.', 'warning');
      }
    }
  }),
  gallery: loader('gallery', api.gallery, (data) =>
    setState('gallery', reconcile(data, { key: 'id' })),
  ),
  characters: loader('characters', api.characters, (data) =>
    setState('characters', reconcile(data, { key: 'id' })),
  ),
  characterFolders: loader('characterFolders', api.characterFolders, (data) =>
    setState('characterFolders', reconcile(data, { key: 'id' })),
  ),
  presets: loader('presets', api.presets, (data) =>
    setState('presets', reconcile(data, { key: 'id' })),
  ),
  templates: loader('templates', api.templates, (data) =>
    setState('templates', reconcile(data, { key: 'id' })),
  ),
  personas: loader('personas', api.personas, (data) =>
    setState('personas', reconcile(data, { key: 'id' })),
  ),
  endpoints: loader('endpoints', api.endpoints, (data) =>
    setState('endpoints', reconcile(data, { key: 'id' })),
  ),
  settings: loader('settings', api.settings, (data) => {
    if (isCurrentSettingsRevision(state.settings.revision, data.revision)) {
      setState('settings', data);
    }
  }),
};

export async function loadAll(): Promise<void> {
  await Promise.all(Object.values(loaders).map((load) => load().catch(console.error)));
  if (!selectionRestored && conversationsLoaded) restoreConversationSelection();
  setState('booted', true);
}

export function handleServerEvent(ev: ServerEvent): void {
  switch (ev.t) {
    case 'hello':
      break;
    case 'invalidate':
      loaders[ev.entity]().catch(console.error);
      break;
    case 'tree':
      if (ev.conversationId === state.selectedId) {
        resyncPendingFor = null;
        setInitialTreeLoaded(true);
        batch(() => {
          setState('tree', 'conversationId', ev.conversationId);
          setState('tree', 'activeLeafId', ev.activeLeafId);
          setState('tree', 'mutationRevision', ev.mutationRevision);
          // Reconcile keeps object identity for unchanged messages so the DOM
          // (and scroll position) survives branch switches.
          setState(
            'tree',
            'messages',
            reconcile(Object.fromEntries(ev.messages.map((m) => [m.id, m])), { key: 'id' }),
          );
        });
        consumePendingSwipe(ev.conversationId, ev.activeLeafId);
        // Renders completed while disconnected must not leave stale progress for the next render.
        setImageProgress((progress) => retainPendingImageProgress(progress, state.tree.messages));
      }
      break;
    case 'treePatch': {
      // Patches only apply on top of a full snapshot for the same conversation.
      if (ev.conversationId !== state.selectedId || state.tree.conversationId !== ev.conversationId)
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
                if (existing) Object.assign(existing, body);
                else messages[node.id] = body;
                if (!body.imagePending) clearImageProgress(node.id);
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
      setImageProgress((progress) => retainPendingImageProgress(progress, state.tree.messages));
      consumePendingSwipe(ev.conversationId, ev.activeLeafId);
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
        toast(ev.message.genMeta?.error ?? 'Generation failed');
      }
      if (state.tree.messages[ev.message.id]) {
        // Preserve MessageNode identity and UI state, as in treePatch.
        setState(
          'tree',
          'messages',
          ev.message.id,
          produce((msg) => Object.assign(msg, ev.message)),
        );
      }
      if (!ev.message.imagePending || !state.tree.messages[ev.message.id]) {
        clearImageProgress(ev.message.id);
      }
      break;
    }
    case 'imageProgress':
      if (ev.conversationId !== state.selectedId) break;
      setImageProgress((progress) =>
        applyImageProgress(progress, state.tree.messages, ev.mid, {
          ...(ev.value === undefined ? {} : { value: ev.value }),
          ...(ev.max === undefined ? {} : { max: ev.max }),
          ...(ev.preview === undefined ? {} : { preview: ev.preview }),
        }),
      );
      break;
  }
}

/** Per-message image render progress (ephemeral; only read while imagePending). */
export const [imageProgress, setImageProgress] = createSignal<ImageProgressState>({});

/** Prevent a later render from showing the previous render's progress. */
function clearImageProgress(mid: number): void {
  setImageProgress((progress) => {
    if (!(mid in progress)) return progress;
    const next = { ...progress };
    delete next[mid];
    return next;
  });
}

/** Outstanding gap-triggered resync; cleared by its tree snapshot. */
let resyncPendingFor: number | null = null;

/** WS snapshots stay ordered with patches/deltas; a REST fetch could revert an edited body. */
function resyncTree(): void {
  if (state.selectedId != null) subscribe(state.selectedId);
}

export function selectConversation(id: number | null): void {
  if (id === state.selectedId) {
    setState('sidebarOpen', false); // mobile: still dismiss the sidebar
    return;
  }
  batch(() => {
    setState('selectedId', id);
    setState('sidebarOpen', false);
    setState('viewMode', 'chat');
    // A null conversationId marks loading until the snapshot arrives.
    setState('tree', {
      conversationId: null,
      messages: {},
      activeLeafId: null,
      mutationRevision: 0,
    });
  });
  // Prevent the previous conversation's swipe animation from leaking into new nodes.
  setPendingSwipe(null);
  setImageProgress({});
  subscribe(id);
  persistSelectedConversation(id);
  history.replaceState(null, '', id != null ? `#${id}` : '#');
}

export async function navigateTree(action: () => Promise<unknown>): Promise<boolean> {
  if (state.treeNavigationPending) return false;
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
    return true;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    if (err instanceof ApiError && err.status === 409) resyncTree();
    return false;
  } finally {
    clearTimeout(timer);
    setState('treeNavigationPending', false);
  }
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

export const [pendingSwipe, setPendingSwipe] = createSignal<PendingSwipe | null>(null);
let swipeToken = 0;

/** Keep the animation through the branch-change mount, then clear it before unrelated mounts. */
function consumePendingSwipe(conversationId: number, activeLeafId: number | null): void {
  setPendingSwipe((pending) => afterTreeFrame(pending, conversationId, activeLeafId));
}

function clearPendingSwipe(token: number): void {
  setPendingSwipe((pending) => afterOperationEnd(pending, token));
}

/** Set to a message id to ask that MessageNode to open its in-place editor (composer ↑ key). */
export const [editRequestId, setEditRequestId] = createSignal<number | null>(null);

/** pendingSwipe holds the outgoing slide until the incoming sibling mounts. */
export async function swipeToSibling(message: Message, dir: 1 | -1): Promise<void> {
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
  setTimeout(() => {
    if (pendingSwipe()?.token === token) refreshWs();
  }, 750);
  // Spring back if reconnect never supplies the authoritative tree.
  setTimeout(() => clearPendingSwipe(token), 5000);
}

export async function newConversation(characterId: number | null): Promise<void> {
  await openCreatedConversation(await api.createConversation(characterId));
}

async function openCreatedConversation(conv: Conversation): Promise<void> {
  // Invalidation GETs can beat this POST; upsert, then refetch for ordering and peer deletions.
  setState('conversations', (list) => upsertById(list, conv));
  let verified = false;
  try {
    await loaders.conversations();
    verified = true;
  } catch (err) {
    console.error(err);
  }
  if (!verified || state.conversations.some((conversation) => conversation.id === conv.id)) {
    selectConversation(conv.id);
  }
}

export function applySettings(next: Settings): boolean {
  if (!isCurrentSettingsRevision(state.settings.revision, next.revision)) return false;
  setState('settings', next);
  return true;
}

/** The invalidation GET may arrive before or after this write response. */
export function applyGalleryItem(item: GalleryItem): void {
  setState('gallery', (items) =>
    upsertById(items, item).sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id),
  );
}

export async function deleteConversation(id: number): Promise<void> {
  locallyDeletingConversationIds.add(id);
  try {
    const conversation = state.conversations.find((candidate) => candidate.id === id);
    if (!conversation) throw new Error(`conversation ${id} not found`);
    const selected = state.tree.conversationId === id;
    await api.deleteConversation(id, selected ? state.tree : conversation);
    if (state.selectedId === id) selectConversation(null);
  } finally {
    locallyDeletingConversationIds.delete(id);
  }
}

export async function deleteAllConversations(): Promise<number> {
  locallyDeletingAllConversations = true;
  try {
    const result = await api.deleteAllConversations();
    if (state.selectedId != null) selectConversation(null);
    setState('conversations', []);
    return result.deleted;
  } finally {
    locallyDeletingAllConversations = false;
  }
}

export async function duplicateConversation(id: number): Promise<void> {
  await openCreatedConversation(await api.duplicateConversation(id));
}

/** Copy only the selected message and its ancestry into a new linear conversation. */
export async function branchConversation(messageId: number): Promise<void> {
  await openCreatedConversation(await api.branchConversation(messageId));
}

export function restoreConversationSelection(): void {
  selectionRestored = true;
  const exists = (id: number) => state.conversations.some((conversation) => conversation.id === id);
  const hashId = Number(location.hash.slice(1));
  let storedId = 0;
  try {
    storedId = Number(localStorage.getItem(LAST_CONVERSATION_KEY));
  } catch {
    /* Ignore unavailable storage. */
  }
  const id =
    Number.isSafeInteger(hashId) && hashId > 0 && exists(hashId)
      ? hashId
      : Number.isSafeInteger(storedId) && storedId > 0 && exists(storedId)
        ? storedId
        : null;
  selectConversation(id);
}

export function openModal(modal: ModalKind): void {
  batch(() => {
    setState('settingsCharacterId', null);
    setState('modal', modal);
  });
}

export function openCharacterSettings(characterId: number): void {
  batch(() => {
    setState('settingsCharacterId', characterId);
    setState('modal', 'settings');
  });
}

export function toggleSidebar(): void {
  setState('sidebarOpen', (open) => !open);
}

/** Match app.css so mobile controls are mounted only in the mobile layout. */
const mobileQuery = matchMedia('(max-width: 767px), (pointer: coarse) and (max-width: 1024px)');
const [isMobileLayout, setIsMobileLayout] = createSignal(mobileQuery.matches);
mobileQuery.addEventListener('change', (e) => setIsMobileLayout(e.matches));
export { isMobileLayout };

/** Also closes the mobile header; desktop ignores the sidebar's open state. */
export function closeSidebar(): void {
  setState('sidebarOpen', false);
}

export function toggleGroupByCharacter(): void {
  setState('groupByCharacter', (on) => !on);
  try {
    localStorage.setItem(GROUP_BY_CHARACTER_KEY, state.groupByCharacter ? '1' : '0');
  } catch {
    /* Storage may be unavailable in hardened/private browser contexts. */
  }
}

/** True until the initial server state (and the hash-selected tree, if any) has arrived. */
export const booting = globalMemo(
  () =>
    !state.booted ||
    (!initialTreeLoaded() &&
      state.selectedId != null &&
      state.tree.conversationId !== state.selectedId),
);
