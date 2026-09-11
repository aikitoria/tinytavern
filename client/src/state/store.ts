import { mainDraftCompletion } from './draftCompletion.ts';
import { dialogStack } from './dialogStack.ts';
import {
  pageStack,
  paneLocation,
  readPageLocation,
  returnToPageLocation,
  writePageLocation,
  navigatePageWithGuards,
} from './pageLocation.ts';
import { createMemo, createRoot, createSignal, batch } from 'solid-js';
import { createStore, produce, reconcile, type SetStoreFunction } from 'solid-js/store';
import type {
  Character,
  EntityFolder,
  Conversation,
  Endpoint,
  GalleryItem,
  InvalidateEntity,
  Message,
  MediaJob,
  MediaAsset,
  Persona,
  Preset,
  ServerEvent,
  Settings,
  Template,
} from '@tinytavern/shared';
import { DEFAULT_SETTINGS, mediaJobActive, mergeMediaProgress } from '@tinytavern/shared';
import { api } from './api.ts';
import { refreshWs, subscribe } from './ws.ts';
import { isCurrentSettingsRevision, SuccessfulFetchSequence, upsertById } from './sync.ts';
import {
  createConversationSession,
  type ConversationSession,
  type ConversationState,
} from './conversationSession.ts';

export type ModalKind =
  'settings' | 'conversation' | 'gallery' | 'media-tools' | 'media-jobs' | null;

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
  characterFolders: EntityFolder[];
  endpointFolders: EntityFolder[];
  personaFolders: EntityFolder[];
  templateFolders: EntityFolder[];
  presetFolders: EntityFolder[];
  presets: Preset[];
  templates: Template[];
  personas: Persona[];
  endpoints: Endpoint[];
  gallery: GalleryItem[];
  galleryFolders: EntityFolder[];
  /** Client-local live cards for gallery renders; final items are server-owned. */
  mediaJobs: Record<number, MediaJob>;
  settings: Settings;
  connected: boolean;
  booted: boolean;
  selectedId: number | null;
  sidebarOpen: boolean;
  groupByCharacter: boolean;
  modal: ModalKind;
  /** 'trace' replaces the timeline with the assembled upstream request;
   * 'map' shows the conversation tree as a zoomable 2D map. */
  viewMode: 'chat' | 'trace' | 'map';
  treeNavigationPending: boolean;
  toasts: { id: number; text: string; kind: ToastKind }[];
  tree: TreeState;
}

export const [state, setState] = createStore<AppState>({
  conversations: [],
  characters: [],
  characterFolders: [],
  endpointFolders: [],
  personaFolders: [],
  templateFolders: [],
  presetFolders: [],
  presets: [],
  templates: [],
  personas: [],
  endpoints: [],
  gallery: [],
  galleryFolders: [],
  mediaJobs: {},
  settings: { ...DEFAULT_SETTINGS },
  connected: false,
  booted: false,
  selectedId: null,
  sidebarOpen: false,
  groupByCharacter: loadGroupByCharacter(),
  modal: null,
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

export const activeMediaJobCount = globalMemo(() => {
  let count = 0;
  for (const job of Object.values(state.mediaJobs)) {
    if (!job.temporary && mediaJobActive(job.state)) count++;
  }
  return count;
});

export const mediaJobsByMessage = globalMemo(() => {
  const jobs = new Map<number, MediaJob>();
  for (const job of Object.values(state.mediaJobs)) {
    if (job.messageId === null) {
      continue;
    }
    const previous = jobs.get(job.messageId);
    if (!previous || previous.createdAt < job.createdAt) {
      jobs.set(job.messageId, job);
    }
  }
  return jobs;
});

export const mainConversationSession = createRoot(() =>
  createConversationSession(state, setState as unknown as SetStoreFunction<ConversationState>, {
    draftCompletion: mainDraftCompletion,
    subscribe,
    refresh: refreshWs,
    toast,
    onSnapshot: () => setInitialTreeLoaded(true),
  }),
);
export const {
  selectedConversation,
  selectedCharacter,
  selectedPersona,
  personasEnabled,
  activePath,
  childrenByParent,
  siblingsOf,
  streamingMessage,
  navigateTree,
  pendingSwipe,
  setPendingSwipe,
  editRequestId,
  setEditRequestId,
  swipeToSibling,
  messageSelection,
  startMessageSelection,
  extendMessageSelection,
  clearMessageSelection,
  selectedMessageRange,
  messageSelectionActive,
  messageIsSelected,
  mapSearchQuery,
  setMapSearchQuery,
  matchesMapSearch,
  mapSearchResults,
  setMapSearchResults,
  mapSearchTarget,
  setMapSearchTarget,
  navigateMapSearch,
} = mainConversationSession;
export type { PendingSwipe } from './conversationSession.ts';
const conversationSessions = new Set<ConversationSession>([mainConversationSession]);
export function registerConversationSession(session: ConversationSession): () => void {
  conversationSessions.add(session);
  return () => {
    conversationSessions.delete(session);
  };
}

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

const thumbnailUpdates = new Map<number, { thumbnail: string; revision: number }>();
function applyThumbnails(assets: MediaAsset[] = []): void {
  for (const asset of assets) {
    const update = thumbnailUpdates.get(asset.id);
    if (update && update.revision > asset.thumbnailRevision) {
      asset.thumbnail = update.thumbnail;
      asset.thumbnailRevision = update.revision;
    }
  }
}

export const [galleryRevision, setGalleryRevision] = createSignal(0);
export const [galleryFoldersLoaded, setGalleryFoldersLoaded] = createSignal(false);

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
  gallery: loader('gallery', api.gallery, (items) => {
    // Ordered snapshots are the sole gallery authority. Write responses may arrive
    // after a later move or deletion and must never be merged back into this list.
    for (const item of items) if (item.media) applyThumbnails([item.media]);
    setState('gallery', reconcile(items, { key: 'id' }));
    setGalleryRevision((revision) => revision + 1);
  }),
  characters: loader('characters', api.characters.list, (data) =>
    setState('characters', reconcile(data, { key: 'id' })),
  ),
  presetFolders: loader('presetFolders', api.entityFolders.presets.list, (data) =>
    setState('presetFolders', reconcile(data, { key: 'id' })),
  ),
  templateFolders: loader('templateFolders', api.entityFolders.templates.list, (data) =>
    setState('templateFolders', reconcile(data, { key: 'id' })),
  ),
  personaFolders: loader('personaFolders', api.entityFolders.personas.list, (data) =>
    setState('personaFolders', reconcile(data, { key: 'id' })),
  ),
  endpointFolders: loader('endpointFolders', api.entityFolders.endpoints.list, (data) =>
    setState('endpointFolders', reconcile(data, { key: 'id' })),
  ),
  characterFolders: loader('characterFolders', api.entityFolders.characters.list, (data) =>
    setState('characterFolders', reconcile(data, { key: 'id' })),
  ),
  galleryFolders: loader('galleryFolders', api.entityFolders.gallery.list, (data) => {
    batch(() => {
      setState('galleryFolders', reconcile(data, { key: 'id' }));
      setGalleryFoldersLoaded(true);
    });
  }),
  presets: loader('presets', api.presets.list, (data) =>
    setState('presets', reconcile(data, { key: 'id' })),
  ),
  templates: loader('templates', api.templates.list, (data) =>
    setState('templates', reconcile(data, { key: 'id' })),
  ),
  personas: loader('personas', api.personas.list, (data) =>
    setState('personas', reconcile(data, { key: 'id' })),
  ),
  endpoints: loader('endpoints', api.endpoints.list, (data) =>
    setState('endpoints', reconcile(data, { key: 'id' })),
  ),
  settings: loader('settings', api.settings, (data) => {
    if (isCurrentSettingsRevision(state.settings.revision, data.revision)) {
      setState('settings', data);
    }
  }),
};

export async function loadAll(): Promise<void> {
  const refreshes = [...Object.values(loaders), refreshMediaJobs];
  await Promise.all(refreshes.map((load) => load().catch(console.error)));
  if (!selectionRestored && conversationsLoaded) restoreConversationSelection();
  setState('booted', true);
}

let mediaEventSequence = 0;
const mediaJobEvents = new Map<number, number>();
// Job IDs are never reused. Late HTTP responses must not restore a deleted job.
const deletedMediaJobs = new Set<number>();
/** Absence from an active-job snapshot is temporary; only deletion events prove removal. */
export function mediaJobWasDeleted(id: number): boolean {
  return deletedMediaJobs.has(id);
}
const mediaFetches = new SuccessfulFetchSequence<string>();
let activeJobSnapshot = new Set<number>();
let activeJobSnapshotSequence = 0;

export function applyMediaJob(job: MediaJob): void {
  if (deletedMediaJobs.has(job.id)) return;
  applyThumbnails(job.assets);
  applyThumbnails(job.outputs);
  const current = state.mediaJobs[job.id];
  if (current && current.revision > job.revision) {
    return;
  }
  mediaJobEvents.set(job.id, ++mediaEventSequence);
  let incoming = job;
  if (current?.revision === job.revision && job.state === 'preparing') {
    const prompt = current.prompt.length > job.prompt.length ? current.prompt : job.prompt;
    let reasoning = job.reasoning;
    if (prompt) {
      reasoning = undefined;
    } else if ((current.reasoning?.length ?? 0) > (job.reasoning?.length ?? 0)) {
      reasoning = current.reasoning;
    }
    incoming = { ...job, prompt, reasoning, progress: current.progress ?? job.progress };
  }
  setState('mediaJobs', job.id, reconcile(incoming));
}

export async function refreshMediaJobs(): Promise<void> {
  const sequence = mediaFetches.start('jobs');
  const began = mediaEventSequence;
  const recent = await api.mediaJobs();
  if (!mediaFetches.accept('jobs', sequence)) {
    return;
  }
  const jobs: Record<number, MediaJob> = {};
  const oldest = recent.at(-1);
  // Active jobs arrive in the ordered WS snapshot. A history page cannot disprove their
  // existence, nor establish whether already loaded history beyond its oldest row was deleted.
  for (const current of Object.values(state.mediaJobs)) {
    if (
      mediaJobActive(current.state) ||
      (recent.length === 100 &&
        oldest &&
        (current.createdAt < oldest.createdAt ||
          (current.createdAt === oldest.createdAt && current.id < oldest.id)))
    )
      jobs[current.id] = current;
  }
  for (const job of recent) {
    if (
      mediaJobActive(job.state) &&
      activeJobSnapshotSequence > began &&
      !activeJobSnapshot.has(job.id)
    )
      continue;
    applyThumbnails(job.assets);
    applyThumbnails(job.outputs);
    if (!deletedMediaJobs.has(job.id)) jobs[job.id] = job;
  }
  for (const [id, event] of mediaJobEvents) {
    if (event > began) {
      const current = state.mediaJobs[id];
      if (current) {
        jobs[id] = current;
      } else {
        delete jobs[id];
      }
    } else {
      mediaJobEvents.delete(id);
    }
  }
  setState('mediaJobs', reconcile(jobs));
}

export function handleServerEvent(ev: ServerEvent): void {
  switch (ev.t) {
    case 'mediaThumbnails': {
      for (const item of ev.items) {
        const previous = thumbnailUpdates.get(item.id);
        if (!previous || item.revision > previous.revision) thumbnailUpdates.set(item.id, item);
      }
      batch(() => {
        setState(
          'gallery',
          produce((items) => {
            for (const item of items) if (item.media) applyThumbnails([item.media]);
          }),
        );
        setState(
          'mediaJobs',
          produce((jobs) => {
            for (const job of Object.values(jobs)) {
              applyThumbnails(job.assets);
              applyThumbnails(job.outputs);
            }
          }),
        );
        for (const session of conversationSessions)
          session.setState(
            'tree',
            'messages',
            produce((messages) => {
              for (const message of Object.values(messages)) applyThumbnails(message.media);
            }),
          );
      });
      break;
    }
    case 'mediaJobs': {
      activeJobSnapshot = new Set(ev.jobs.map((job) => job.id));
      activeJobSnapshotSequence = ++mediaEventSequence;
      batch(() => {
        for (const job of Object.values(state.mediaJobs)) {
          if (mediaJobActive(job.state) && !activeJobSnapshot.has(job.id)) {
            mediaJobEvents.set(job.id, ++mediaEventSequence);
            setState(
              'mediaJobs',
              produce((jobs) => {
                delete jobs[job.id];
              }),
            );
          }
        }
        for (const job of ev.jobs) applyMediaJob(job);
      });
      break;
    }
    case 'mediaJob':
      applyMediaJob(ev.job);
      break;
    case 'mediaJobDeleted':
      deletedMediaJobs.add(ev.id);
      mediaJobEvents.set(ev.id, ++mediaEventSequence);
      setState(
        'mediaJobs',
        produce((jobs) => {
          delete jobs[ev.id];
        }),
      );
      break;
    case 'mediaJobProgress': {
      const job = state.mediaJobs[ev.id];
      if (job && mediaJobActive(job.state)) {
        mediaJobEvents.set(ev.id, ++mediaEventSequence);
        batch(() => {
          setState(
            'mediaJobs',
            ev.id,
            'progress',
            reconcile(mergeMediaProgress(job.progress, ev.progress)),
          );
          if (ev.reasoning !== undefined) {
            setState('mediaJobs', ev.id, 'reasoning', ev.reasoning);
            for (const session of conversationSessions)
              if (job.messageId !== null && session.state.tree.messages[job.messageId]) {
                session.setState(
                  'tree',
                  'messages',
                  job.messageId,
                  'reasoning',
                  ev.reasoning || null,
                );
              }
          }
          if (ev.prompt !== undefined) {
            setState('mediaJobs', ev.id, 'prompt', ev.prompt);
            for (const session of conversationSessions)
              if (job.messageId !== null && session.state.tree.messages[job.messageId]) {
                session.setState('tree', 'messages', job.messageId, 'content', ev.prompt);
              }
          }
        });
      }
      break;
    }
    case 'hello':
      break;
    case 'invalidate':
      loaders[ev.entity]().catch(console.error);
      break;
    default:
      if (ev.t === 'tree' || ev.t === 'treePatch')
        for (const message of ev.messages) applyThumbnails(message.media);
      for (const session of conversationSessions) session.handleEvent(ev);
  }
}

export function selectConversation(id: number | null): void {
  if (
    state.conversations.some(
      (conversation) => conversation.id === id && conversation.promptMode === 'media',
    )
  )
    id = null;
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
  mainConversationSession.reset();
  subscribe(id);
  persistSelectedConversation(id);
  writePageLocation({ ...readPageLocation(), chatId: id, viewMode: undefined });
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
    // A newly created/duplicated chat becomes the root page, not a child of its editor.
    batch(() => {
      const page = { chatId: conv.id, modal: null };
      dialogStack.restore(page);
      setState('modal', null);
      selectConversation(conv.id);
      writePageLocation(page);
    });
  }
}

export function applySettings(next: Settings): boolean {
  if (!isCurrentSettingsRevision(state.settings.revision, next.revision)) return false;
  setState('settings', next);
  return true;
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
  const exists = (id: number) =>
    state.conversations.some(
      (conversation) => conversation.id === id && conversation.promptMode !== 'media',
    );
  const page = readPageLocation();
  const hashId = page.chatId;
  let storedId = 0;
  try {
    storedId = Number(localStorage.getItem(LAST_CONVERSATION_KEY));
  } catch {
    /* Ignore unavailable storage. */
  }
  let id: number | null = null;
  if (hashId !== null && exists(hashId)) {
    id = hashId;
  } else if (
    !location.hash.includes('/') &&
    Number.isInteger(storedId) &&
    storedId > 0 &&
    exists(storedId)
  ) {
    id = storedId;
  }
  selectConversation(id);
  writePageLocation({ ...page, chatId: id });
}

export function openDialog(
  page: import('./pageLocation.ts').PageLocation,
  session?: import('../media/navigation.ts').MediaToolSession,
): void {
  if (page.modal === 'settings') {
    const existing = dialogStack.frames().find((frame) => frame.page.modal === 'settings');
    if (existing) {
      const target =
        page.settingsTab === undefined ? existing.page : { ...page, stack: existing.page.stack };
      navigatePageWithGuards(target, () =>
        batch(() => {
          dialogStack.restore(target);
          setState('modal', 'settings');
          writePageLocation(target, true);
        }),
      );
      return;
    }
  }
  const from = readPageLocation();
  const next = { ...page, stack: pageStack(from).map(paneLocation) };
  batch(() => {
    dialogStack.push(next, from, session);
    setState('modal', page.modal);
    writePageLocation(next, true);
  });
}

export function openModal(modal: ModalKind): void {
  if (modal === null) {
    returnToPageLocation(dialogStack.parent(), () =>
      batch(() => {
        const page = dialogStack.pop();
        setState('modal', page.modal);
        writePageLocation(page);
      }),
    );
  } else {
    const current = readPageLocation();
    openDialog({ chatId: current.chatId, viewMode: current.viewMode, modal });
  }
}

export function openCharacterSettings(characterId: number): void {
  openDialog({
    chatId: state.selectedId,
    modal: 'settings',
    settingsTab: 'characters',
    settingsEntity: characterId,
    settingsDetail: true,
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
