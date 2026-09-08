import { createSignal } from 'solid-js';
import { MEDIA_OPERATIONS, type MediaOperation } from '@tinytavern/shared';
import type { ModalKind } from './store.ts';

export interface MediaPageLocation {
  operation: MediaOperation;
  jobId: string | null;
  contextConversationId: number | null;
  returnModal: ModalKind;
  returnHash?: string;
  showJobs: boolean;
}

export interface PageLocation {
  chatId: number | null;
  modal: ModalKind;
  viewMode?: 'map' | 'trace';
  galleryId?: number;
  query?: string;
  character?: string;
  sort?: string;
  settingsTab?: string;
  settingsEntity?: number | 'new' | 'default';
  settingsDetail?: boolean;
  media?: MediaPageLocation;
}

const positiveId = (value: string | null | undefined) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export function parsePageLocation(hash: string): PageLocation {
  const [path, query] = hash.replace(/^#/, '').split('?');
  let segments: string[];
  try {
    segments = (path ?? '').split('/').map(decodeURIComponent);
  } catch {
    return { chatId: null, modal: null };
  }
  const [chat, page, detail, entity] = segments;
  const params = new URLSearchParams(query);
  const result: PageLocation = { chatId: positiveId(chat), modal: null };
  const view = params.get('view');
  if (view === 'map' || view === 'trace') result.viewMode = view;
  if (page === 'gallery') {
    result.modal = 'gallery';
    result.galleryId = positiveId(detail) ?? undefined;
    result.query = params.get('q') ?? undefined;
    result.character = params.get('character') ?? undefined;
    result.sort = params.get('sort') ?? undefined;
  } else if (page === 'settings') {
    result.modal = 'settings';
    result.settingsTab = detail || 'general';
    result.settingsEntity =
      entity === 'new' || entity === 'default' ? entity : (positiveId(entity) ?? undefined);
    result.settingsDetail = params.get('detail') === '1';
  } else if (page === 'conversation') {
    result.modal = 'conversation';
  } else if (page === 'map' || page === 'trace') {
    result.viewMode = page;
  } else if (page === 'media') {
    const operation = MEDIA_OPERATIONS.find((item) => item.id === detail);
    if (operation) {
      result.modal = 'media-tools';
      const returnHash = params.get('return') ?? undefined;
      const returnPage = returnHash?.split('?')[0]?.split('/')[1];
      result.media = {
        operation: operation.id,
        jobId: entity || null,
        contextConversationId: positiveId(params.get('context')),
        returnModal:
          returnPage === 'gallery' || returnPage === 'settings' || returnPage === 'conversation'
            ? returnPage
            : null,
        returnHash,
        showJobs: params.get('jobs') === '1',
      };
    }
  }
  return result;
}

export function formatPageLocation(page: PageLocation): string {
  const parts = [page.chatId === null ? '' : String(page.chatId)];
  const params = new URLSearchParams();
  if (page.modal === 'gallery') {
    parts.push('gallery');
    if (page.galleryId) parts.push(String(page.galleryId));
    if (page.query) params.set('q', page.query);
    if (page.character && page.character !== 'all') params.set('character', page.character);
    if (page.sort) params.set('sort', page.sort);
  } else if (page.modal === 'settings') {
    parts.push('settings', page.settingsTab ?? 'general');
    if (page.settingsEntity !== undefined) parts.push(String(page.settingsEntity));
    if (page.settingsDetail) params.set('detail', '1');
  } else if (page.modal === 'media-tools' && page.media) {
    parts.push('media', page.media.operation);
    if (page.media.jobId) parts.push(page.media.jobId);
    if (page.media.contextConversationId)
      params.set('context', String(page.media.contextConversationId));
    if (page.media.returnHash) params.set('return', page.media.returnHash);
    if (page.media.showJobs) params.set('jobs', '1');
  } else if (page.modal === 'conversation') {
    parts.push('conversation');
  } else if (page.viewMode) {
    parts.push(page.viewMode);
  }
  if (page.modal && page.viewMode) params.set('view', page.viewMode);
  const query = params.toString();
  return '#' + parts.map(encodeURIComponent).join('/') + (query ? '?' + query : '');
}

export function readPageLocation(): PageLocation {
  return parsePageLocation(location.hash);
}

let applyingPage = false;
let currentHash = typeof location === 'undefined' ? '#' : location.hash;
let historyIndex = 0;
let restoreBeforeGuard: (() => void) | undefined;
let approvedHistoryIndex: number | undefined;
let navigationGuard: ((action: () => void) => void) | undefined;
const [pageRevision, setPageRevision] = createSignal(1);
export { pageRevision };

export function guardPageNavigation(guard: (action: () => void) => void): () => void {
  navigationGuard = guard;
  return () => {
    if (navigationGuard === guard) navigationGuard = undefined;
  };
}

export function writePageLocation(page: PageLocation, push = false): void {
  if (applyingPage) return;
  const hash = formatPageLocation(page);
  if (hash !== location.hash) {
    approvedHistoryIndex = undefined;
    restoreBeforeGuard = undefined;
    if (push) {
      historyIndex++;
      history.pushState({ tinytavernPageIndex: historyIndex }, '', hash);
    } else history.replaceState({ ...history.state, tinytavernPageIndex: historyIndex }, '', hash);
  }
  currentHash = hash;
}

export function rememberPage(modal: ModalKind): void {
  const current = readPageLocation();
  writePageLocation({ chatId: current.chatId, viewMode: current.viewMode, modal }, true);
}

export function rememberMediaPage(media: MediaPageLocation): void {
  const current = readPageLocation();
  writePageLocation({
    chatId: current.chatId,
    viewMode: current.viewMode,
    modal: 'media-tools',
    media,
  });
}

export function applyPageLocation(page: PageLocation, apply: () => void): void {
  applyingPage = true;
  try {
    history.replaceState(
      { ...history.state, tinytavernPageIndex: historyIndex },
      '',
      formatPageLocation(page),
    );
    currentHash = location.hash;
    apply();
    setPageRevision((value) => value + 1);
  } finally {
    applyingPage = false;
  }
}

export function installPageNavigation(apply: (page: PageLocation) => void): void {
  historyIndex = history.state?.tinytavernPageIndex ?? 0;
  history.replaceState({ ...history.state, tinytavernPageIndex: historyIndex }, '');
  window.addEventListener('popstate', (event) => {
    const targetIndex = event.state?.tinytavernPageIndex;
    if (typeof targetIndex !== 'number') {
      // A hash entered outside the app starts a new tracked navigation sequence.
      restoreBeforeGuard = undefined;
      approvedHistoryIndex = undefined;
      historyIndex = 0;
      apply(readPageLocation());
      return;
    }
    if (restoreBeforeGuard) {
      if (targetIndex !== historyIndex) {
        history.go(historyIndex - targetIndex);
        return;
      }
      const guard = restoreBeforeGuard;
      restoreBeforeGuard = undefined;
      guard();
      return;
    }
    const approved = approvedHistoryIndex === targetIndex;
    approvedHistoryIndex = undefined;
    if (navigationGuard && !approved && targetIndex !== historyIndex) {
      const guard = navigationGuard;
      const originHash = currentHash;
      // Return to the untouched entry before asking. Cancel then leaves both the
      // editor and Back/Forward history intact; approval repeats this traversal.
      restoreBeforeGuard = () =>
        guard(() => {
          if (navigationGuard !== guard || currentHash !== originHash) return;
          approvedHistoryIndex = targetIndex;
          history.go(targetIndex - historyIndex);
        });
      history.go(historyIndex - targetIndex);
      return;
    }
    historyIndex = targetIndex;
    apply(readPageLocation());
  });
}
