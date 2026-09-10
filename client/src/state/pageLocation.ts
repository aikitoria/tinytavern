import { dialogStack } from './dialogStack.ts';
import type { ModalKind } from './store.ts';

export interface MediaPageLocation {
  workflowId: string | null;
  jobId: number | null;
  previewJobId?: number;
  assetId?: number;
  contextConversationId: number | null;
  galleryFolderId?: number | null;
}

export interface PageLocation {
  chatId: number | null;
  modal: ModalKind;
  viewMode?: 'map' | 'trace';
  galleryId?: number;
  galleryFolder?: number | 'root';
  query?: string;
  character?: string;
  sort?: string;
  settingsTab?: string;
  settingsEntity?: number | string;
  settingsDetail?: boolean;
  media?: MediaPageLocation;
  stack?: PageLocation[];
}

const positiveId = (value: string | null | undefined) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const SETTINGS_TAB_ALIASES: Readonly<Record<string, string>> = {
  presets: 'system-prompts',
  templates: 'chat-templates',
  endpoints: 'model-connections',
  'media-rendering': 'generation-settings',
  'chat-prompt-revision': 'generation-settings',
  'prompt-revision': 'generation-settings',
  'avatar-prompts': 'generation-settings',
  'media-chat-prompts': 'chat-media-prompts',
  'media-standalone-prompts': 'standalone-media-prompts',
  'media-favorites': 'generation-settings',
  'toolbar-favorites': 'generation-settings',
};
const settingsTabName = (name = 'general') =>
  Object.hasOwn(SETTINGS_TAB_ALIASES, name) ? SETTINGS_TAB_ALIASES[name]! : name;

function parsePane(hash: string): PageLocation {
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
    if (params.has('folder'))
      result.galleryFolder =
        params.get('folder') === 'root' ? 'root' : (positiveId(params.get('folder')) ?? undefined);
    result.query = params.get('q') ?? undefined;
    result.character = params.get('character') ?? undefined;
    result.sort = params.get('sort') ?? undefined;
  } else if (page === 'settings') {
    result.modal = 'settings';
    result.settingsTab = settingsTabName(detail || 'general');
    result.settingsEntity =
      entity === 'new' ||
      entity === 'default' ||
      ['workflows', 'chat-media-prompts', 'standalone-media-prompts'].includes(result.settingsTab)
        ? entity
        : (positiveId(entity) ?? undefined);
    result.settingsDetail = params.get('detail') === '1';
  } else if (page === 'conversation') {
    result.modal = 'conversation';
  } else if (page === 'map' || page === 'trace') {
    result.viewMode = page;
  } else if (page === 'jobs') {
    result.modal = 'media-jobs';
  } else if (page === 'media' && detail === 'job' && positiveId(entity)) {
    result.modal = 'media-tools';
    // The workflow and context are resolved from the saved job, never from its URL.
    result.media = {
      workflowId: null,
      jobId: positiveId(entity),
      previewJobId: positiveId(params.get('preview')) ?? undefined,
      assetId: positiveId(params.get('asset')) ?? undefined,
      contextConversationId: null,
    };
  } else if (page === 'media') {
    if (detail) {
      if (params.get('jobs') === '1') result.modal = 'media-jobs';
      else {
        result.modal = 'media-tools';
        result.media = {
          workflowId: detail === 'generate' ? params.get('workflow') : null,
          jobId: positiveId(entity),
          contextConversationId: positiveId(params.get('context')),
          galleryFolderId: positiveId(params.get('folder')),
        };
      }
    }
  }
  return result;
}

function formatPane(page: PageLocation): string {
  const parts = [page.chatId === null ? '' : String(page.chatId)];
  const params = new URLSearchParams();
  if (page.modal === 'gallery') {
    parts.push('gallery');
    if (page.galleryId) parts.push(String(page.galleryId));
    if (page.galleryFolder !== undefined) params.set('folder', String(page.galleryFolder));
    if (page.query) params.set('q', page.query);
    if (page.character && page.character !== 'all') params.set('character', page.character);
    if (page.sort) params.set('sort', page.sort);
  } else if (page.modal === 'settings') {
    parts.push('settings', settingsTabName(page.settingsTab));
    if (page.settingsEntity !== undefined) parts.push(String(page.settingsEntity));
    if (page.settingsDetail) params.set('detail', '1');
  } else if (page.modal === 'media-jobs') {
    parts.push('jobs');
  } else if (page.modal === 'media-tools' && page.media) {
    if (page.media.jobId) {
      parts.push('media', 'job', String(page.media.jobId));
      if (page.media.previewJobId && page.media.previewJobId !== page.media.jobId)
        params.set('preview', String(page.media.previewJobId));
      if (page.media.assetId) params.set('asset', String(page.media.assetId));
    } else {
      parts.push('media', 'generate');
      if (page.media.workflowId) params.set('workflow', page.media.workflowId);
    }
    if (!page.media.jobId && page.media.contextConversationId)
      params.set('context', String(page.media.contextConversationId));
    if (!page.media.jobId && page.media.galleryFolderId)
      params.set('folder', String(page.media.galleryFolderId));
  } else if (page.modal === 'conversation') {
    parts.push('conversation');
  } else if (page.viewMode) {
    parts.push(page.viewMode);
  }
  if (page.modal && page.viewMode) params.set('view', page.viewMode);
  const query = params.toString();
  return '#' + parts.map(encodeURIComponent).join('/') + (query ? '?' + query : '');
}

/** Strip ancestor metadata before placing a pane in the flat URL stack. */
export function paneLocation(page: PageLocation): PageLocation {
  const { stack: _stack, ...pane } = page;
  return pane;
}

export function pageStack(page: PageLocation): PageLocation[] {
  const pages = [...(page.stack ?? []).map(paneLocation), paneLocation(page)];
  if (pages[0]!.modal) pages.unshift({ chatId: page.chatId, viewMode: page.viewMode, modal: null });
  return pages.map((pane, index) => (index ? { ...pane, stack: pages.slice(0, index) } : pane));
}

/** The +/ separator cannot collide with encoded path IDs or query values (including spaces). */
export function parsePageLocation(hash: string): PageLocation {
  const parts = hash.split('+/');
  const first = parsePane(parts[0]!);
  const pages = pageStack(first).map(paneLocation);
  if (parts.length > 1) {
    for (const part of parts.slice(1)) {
      const pane = parsePane(`#${first.chatId ?? ''}/${part}`);
      if (!pane.modal) continue;
      pages.push({ ...pane, viewMode: first.viewMode });
    }
  } else {
    // Read previously shared links, but always write the explicit pane-stack format.
    let parent = new URLSearchParams(hash.split('?')[1]).get('return');
    if (parent) {
      pages.splice(0, pages.length, first);
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        const legacy = parsePane(parent);
        pages.unshift(legacy);
        parent = new URLSearchParams(parent.split('?')[1]).get('return');
      }
      if (pages[0]!.modal)
        pages.unshift({ chatId: first.chatId, viewMode: first.viewMode, modal: null });
    }
  }
  // Settings has one panel; old nested links select the last requested settings editor.
  // Revisiting Jobs or the same saved job unwinds to the original pane.
  const unique: PageLocation[] = [];
  for (const pane of pages) {
    const jobId = pane.media?.jobId;
    const existing = unique.findIndex((item) =>
      pane.modal === 'settings'
        ? item.modal === 'settings'
        : pane.modal === 'media-jobs'
          ? item.modal === 'media-jobs'
          : jobId != null && item.media?.jobId === jobId,
    );
    if (existing >= 0 && pane.modal === 'settings')
      unique.splice(existing, unique.length - existing, pane);
    else if (existing >= 0) unique.splice(existing + 1);
    else unique.push(pane);
  }
  const top = unique.at(-1)!;
  return unique.length > 1 ? { ...top, stack: unique.slice(0, -1) } : top;
}

export function formatPageLocation(page: PageLocation): string {
  return (
    '#' +
    pageStack(page)
      .map((pane, index) =>
        index
          ? formatPane({ ...pane, chatId: null, viewMode: undefined }).slice(2)
          : formatPane(pane).slice(1),
      )
      .join('+/')
  );
}

export function readPageLocation(): PageLocation {
  return parsePageLocation(location.hash);
}

let applyingPage = false;
let currentHash = typeof location === 'undefined' ? '#' : location.hash;
let historyIndex = 0;
const historyPages = new Map<number, string>();
let restoreBeforeGuard: (() => void) | undefined;
let approvedHistoryIndex: number | undefined;
let uiBackHistory = false;
const navigationGuards: {
  guard: (action: () => void) => void;
  applies?: (target: PageLocation) => boolean;
}[] = [];

export function guardPageNavigation(
  guard: (action: () => void) => void,
  applies?: (target: PageLocation) => boolean,
): () => void {
  const entry = { guard, applies };
  navigationGuards.push(entry);
  return () => {
    const index = navigationGuards.indexOf(entry);
    if (index >= 0) navigationGuards.splice(index, 1);
  };
}

/** Reusing an existing pane can remove several children; guard each removed editor first. */
export function navigatePageWithGuards(target: PageLocation, action: () => void): void {
  const guards = navigationGuards
    .filter((entry) => !entry.applies || entry.applies(target))
    .reverse();
  const originHash = currentHash;
  const originFrame = dialogStack.top();
  const originIndex = historyIndex;
  let index = 0;
  const next = () => {
    if (
      historyIndex !== originIndex ||
      dialogStack.top() !== originFrame ||
      (!originFrame && currentHash !== originHash) ||
      guards.some((entry) => !navigationGuards.includes(entry))
    )
      return;
    const entry = guards[index++];
    if (entry) entry.guard(next);
    else action();
  };
  next();
}

export function writePageLocation(page: PageLocation, push = false): void {
  if (applyingPage) return;
  page = dialogStack.remember(page);
  const hash = formatPageLocation(page);
  if (hash !== location.hash) {
    approvedHistoryIndex = undefined;
    restoreBeforeGuard = undefined;
    if (push) {
      for (const index of historyPages.keys()) if (index > historyIndex) historyPages.delete(index);
      historyIndex++;
      history.pushState(
        { tinytavernPageIndex: historyIndex, ...(uiBackHistory && { tinytavernUiBack: true }) },
        '',
        hash,
      );
    } else history.replaceState({ ...history.state, tinytavernPageIndex: historyIndex }, '', hash);
  }
  currentHash = hash;
  historyPages.set(historyIndex, hash);
}

/** UI Back traverses to its parent entry; a reloaded/deep-linked pane replaces itself. */
export function returnToPageLocation(page: PageLocation, fallback: () => void): void {
  const hash = formatPageLocation(page);
  for (let index = historyIndex - 1; index >= 0; index--) {
    if (historyPages.get(index) !== hash) continue;
    approvedHistoryIndex = index; // The pane's Back handler has already run its leave guard.
    history.go(index - historyIndex);
    return;
  }
  fallback();
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
    historyPages.set(historyIndex, currentHash);
  } finally {
    applyingPage = false;
  }
}

export function installPageNavigation(
  apply: (page: PageLocation) => void,
  backAction?: () => (() => void) | undefined,
): void {
  uiBackHistory = Boolean(backAction);
  if (backAction && !history.state?.tinytavernUiBack) {
    // Keep one same-document entry behind the initial page so system Back can
    // close local UI even in a freshly launched PWA or a reloaded deep link.
    history.replaceState(
      { ...history.state, tinytavernPageIndex: -1, tinytavernBackBoundary: true },
      '',
    );
    const { tinytavernBackBoundary: _boundary, ...state } = history.state;
    history.pushState(
      { ...state, tinytavernPageIndex: 0, tinytavernUiBack: true },
      '',
      location.hash,
    );
  }
  historyIndex = history.state?.tinytavernPageIndex ?? 0;
  history.replaceState({ ...history.state, tinytavernPageIndex: historyIndex }, '');
  historyPages.set(historyIndex, location.hash);
  let leavingThroughBoundary = false;
  window.addEventListener('popstate', (event) => {
    let targetIndex = event.state?.tinytavernPageIndex;
    if (typeof targetIndex !== 'number') {
      // Native hash navigation creates an entry without our state. Track it before
      // restoring the origin so it follows the same Save / Discard / Cancel path.
      targetIndex = historyIndex + 1;
      history.replaceState(
        {
          ...history.state,
          tinytavernPageIndex: targetIndex,
          ...(uiBackHistory && { tinytavernUiBack: true }),
        },
        '',
      );
      for (const index of historyPages.keys()) if (index > historyIndex) historyPages.delete(index);
      historyPages.set(targetIndex, location.hash);
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
    if (event.state?.tinytavernBackBoundary && leavingThroughBoundary) {
      leavingThroughBoundary = false;
      history.go(1);
      return;
    }
    leavingThroughBoundary = false;
    if (!approved && targetIndex < historyIndex) {
      const action = backAction?.();
      if (action) {
        // popstate cannot be cancelled. Restore the untouched entry before
        // invoking the UI handler so menus and cancelled guards retain the URL,
        // mounted editor and Forward history. UI Back traversals are preapproved.
        restoreBeforeGuard = () => {
          if (backAction?.() === action) action();
        };
        history.go(historyIndex - targetIndex);
        return;
      }
    }
    if (event.state?.tinytavernBackBoundary) {
      // Nothing can close: let Back leave the app without an extra button press.
      leavingThroughBoundary = true;
      history.go(-1);
      return;
    }
    const guards = navigationGuards
      .filter((entry) => !entry.applies || entry.applies(readPageLocation()))
      .reverse();
    if (guards.length && !approved && targetIndex !== historyIndex) {
      const guard = (action: () => void) => {
        let index = 0;
        const next = () => {
          const entry = guards[index++];
          if (entry) entry.guard(next);
          else action();
        };
        next();
      };
      const originHash = currentHash;
      // Return to the untouched entry before asking. Cancel then leaves both the
      // editor and Back/Forward history intact; approval repeats this traversal.
      restoreBeforeGuard = () =>
        guard(() => {
          if (
            guards.some((entry) => !navigationGuards.includes(entry)) ||
            currentHash !== originHash
          )
            return;
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
