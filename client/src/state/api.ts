import { ENTITY_FOLDERS, type FolderEntity, type EntityFolder } from '@tinytavern/shared';
import {
  DEFAULT_SETTINGS,
  transferDocument,
  type TransferEntity,
  type SettingsTransferDocument,
} from '@tinytavern/shared';
import type { MediaImageConfig } from '@tinytavern/shared';
import type {
  Character,
  Conversation,
  Endpoint,
  GalleryItem,
  ImageDescriptionProgress,
  Message,
  MediaAssetInput,
  MediaResultDetails,
  MediaJob,
  MediaJobDraft,
  Persona,
  Preset,
  PromptTrace,
  Settings,
  Template,
} from '@tinytavern/shared';
import { readSseData } from '@tinytavern/shared';
import { prepareEndpointPatch } from './endpointSync.ts';

interface RequestOptions {
  rawBody?: RequestInit['body'];
  contentType?: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let onAuthenticationRequired: (() => void) | null = null;

export function setAuthenticationRequiredHandler(handler: () => void): void {
  onAuthenticationRequired = handler;
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  const hasRawBody = options?.rawBody !== undefined;
  const hasJsonBody = body !== undefined;
  const res = await fetch(url, {
    method,
    headers:
      hasRawBody || hasJsonBody
        ? { 'content-type': options?.contentType ?? 'application/json' }
        : {},
    body: hasRawBody ? options.rawBody : hasJsonBody ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const error = await errorFromResponse(res);
    if (res.status === 401 && !url.startsWith('/api/auth/')) onAuthenticationRequired?.();
    throw error;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Read at dispatch time from the authoritative tree or conversation snapshot. */
type MutationState = Pick<Conversation, 'activeLeafId' | 'mutationRevision'>;

function mutationRequest<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  expected: MutationState,
  body?: Record<string, unknown>,
): Promise<T> {
  if (method === 'DELETE') {
    return request<T>(
      method,
      `${url}?expectedActiveLeafId=${expected.activeLeafId ?? 'null'}&expectedMutationRevision=${expected.mutationRevision}`,
    );
  }
  body ??= {};
  body.expectedActiveLeafId = expected.activeLeafId;
  body.expectedMutationRevision = expected.mutationRevision;
  return request<T>(method, url, body);
}

type GuardedMutation<T, B> = undefined extends B
  ? (id: number, expected: MutationState, body?: B) => Promise<T>
  : (id: number, expected: MutationState, body: B) => Promise<T>;

/** Every tree mutation reads the same guards immediately before dispatch. */
function mutation<T, B extends object | undefined = undefined>(
  resource: 'messages' | 'conversations',
  suffix = '',
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
): GuardedMutation<T, B> {
  const base = `/api/${resource}/`;
  const tail = suffix ? `/${suffix}` : '';
  return ((id: number, expected: MutationState, body?: B) =>
    mutationRequest<T>(
      method,
      `${base}${id}${tail}`,
      expected,
      body ? { ...body } : undefined,
    )) as GuardedMutation<T, B>;
}

type ContentBody = { content: string };
type ImageIndexBody = { index: number };
type ActiveLeafResult = { activeLeafId: number | null };

async function errorFromResponse(res: Response): Promise<ApiError> {
  let message = `${res.status}`;
  try {
    const json = (await res.json()) as { error?: unknown };
    if (typeof json.error === 'string' && json.error) message = json.error;
  } catch {
    /* keep status */
  }
  return new ApiError(res.status, message);
}

/** Streams prompt content and optional transient reasoning separately. */
export async function streamTextCompletion(
  url: string,
  body: Record<string, unknown>,
  onDelta: (delta: string, text: string) => void,
  streamLabel: string,
  signal?: AbortSignal,
  onReasoning?: (delta: string) => void,
): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
  if (!res.ok || !res.body) throw await errorFromResponse(res);
  let text = '';
  let completed = false;
  await readSseData(res.body, (data) => {
    const payload = JSON.parse(data) as {
      d?: unknown;
      r?: unknown;
      error?: unknown;
      done?: unknown;
    };
    if (typeof payload.error === 'string' && payload.error) throw new ApiError(502, payload.error);
    if (payload.done === true) completed = true;
    if (!text && typeof payload.r === 'string' && payload.r) onReasoning?.(payload.r);
    if (typeof payload.d === 'string' && payload.d) {
      text += payload.d;
      onDelta(payload.d, text);
    }
  });
  if (!completed) throw new ApiError(502, `${streamLabel} stream ended before completion`);
  return text;
}

/** Resource methods share transport; DTOs and endpoint-specific transforms stay typed. */
function resource<T>(name: string, preparePatch: (data: Partial<T>) => unknown = (data) => data) {
  const url = `/api/${name}`;
  return {
    list: () => request<T[]>('GET', url),
    create: (data: Partial<T>) => request<T>('POST', url, data),
    patch: (id: number, data: Partial<T>) =>
      request<T>('PATCH', `${url}/${id}`, preparePatch(data)),
    remove: (id: number) => request<void>('DELETE', `${url}/${id}`),
  };
}
function entity<T>(name: string, preparePatch?: (data: Partial<T>) => unknown) {
  return {
    ...resource<T>(name, preparePatch),
    duplicate: (id: number) => request<T>('POST', `/api/${name}/${id}/duplicate`),
  };
}
function avatarEntity<T>(name: string) {
  return {
    ...entity<T>(name),
    useAvatarAsset: (id: number, assetId: number) =>
      request<T>('POST', `/api/${name}/${id}/avatar`, { assetId }),
    uploadAvatar: (id: number, file: File) =>
      request<T>('PUT', `/api/${name}/${id}/avatar`, undefined, {
        rawBody: file,
        contentType: file.type,
      }),
    deleteAvatar: (id: number) => request<T>('DELETE', `/api/${name}/${id}/avatar`),
  };
}

export const api = {
  exportEntityPage: (type: TransferEntity) =>
    request<{ document: SettingsTransferDocument; snapshot: string }>(
      'GET',
      `/api/${type}/settings-export`,
    ),
  exportEntityRecord: (type: TransferEntity, id: number) =>
    request<Record<string, unknown>>('GET', `/api/${type}/${id}/settings-export`),
  importEntityPage: (type: TransferEntity, data: unknown, expectedSnapshot: string) =>
    request<unknown[]>('POST', `/api/${type}/settings-import`, {
      document: transferDocument(`page:${type}`, data),
      expectedSnapshot,
    }),
  mediaJobs: (before?: Pick<MediaJob, 'createdAt' | 'id'>) => {
    const query = before ? `?before=${encodeURIComponent(`${before.createdAt}:${before.id}`)}` : '';
    return request<MediaJob[]>('GET', `/api/media/jobs${query}`);
  },
  mediaJob: (id: number) => request<MediaJob>('GET', `/api/media/jobs/${id}`),
  runMediaFavorite: (
    id: string,
    conversationId: number,
    tree: MutationState,
    requestKey: string,
    instruction = '',
  ) =>
    request<MediaJob>('POST', `/api/media/favorites/${encodeURIComponent(id)}/run`, {
      contextConversationId: conversationId,
      requestKey,
      instruction,
      expectedActiveLeafId: tree.activeLeafId,
      expectedMutationRevision: tree.mutationRevision,
    }),
  createMediaJob: (draft: MediaJobDraft, requestKey: string) =>
    request<MediaJob>('POST', '/api/media/jobs', { ...draft, requestKey }),
  mediaAssetInputs: (assetId: number) =>
    request<MediaAssetInput[]>('GET', `/api/media/assets/${assetId}/inputs`),
  mediaAssetResultDetails: (assetId: number) =>
    request<MediaResultDetails>('GET', `/api/media/assets/${assetId}/details`),
  rerunMediaAsset: (assetId: number, requestKey: string, options: Partial<MediaJobDraft> = {}) =>
    request<MediaJob>('POST', `/api/media/assets/${assetId}/rerun`, { ...options, requestKey }),
  editMediaJob: (job: MediaJob, draft: Partial<MediaJobDraft>) =>
    request<MediaJob>('PATCH', `/api/media/jobs/${job.id}`, {
      ...draft,
      expectedRevision: job.revision,
    }),
  mediaJobAction: (
    job: MediaJob,
    action: 'prepare' | 'render' | 'cancel' | 'retry-retrieval',
    options: {
      autoRender?: boolean;
      expectedActiveLeafId?: number | null;
      expectedMutationRevision?: number;
    } = {},
  ) =>
    request<MediaJob>('POST', `/api/media/jobs/${job.id}/${action}`, {
      ...options,
      expectedRevision: job.revision,
    }),
  mediaVariations: (jobId: number, draftId?: number | null) =>
    request<MediaJob[]>(
      'GET',
      draftId ? `/api/media/drafts/${draftId}/variations` : `/api/media/jobs/${jobId}/variations`,
    ),
  selectMediaVariation: (job: MediaJob, assetId: number, expectedDraftRevision: number) =>
    request<MediaJob>('POST', `/api/media/jobs/${job.id}/select`, {
      assetId,
      expectedDraftRevision,
      expectedRevision: job.revision,
    }),
  acceptMediaVariation: (
    job: MediaJob,
    assetId: number | null,
    expectedDraftRevision: number,
    tree: MutationState,
  ) =>
    request<MediaJob>('POST', `/api/media/jobs/${job.id}/accept`, {
      assetId,
      expectedDraftRevision,
      expectedRevision: job.revision,
      expectedActiveLeafId: tree.activeLeafId,
      expectedMutationRevision: tree.mutationRevision,
    }),
  discardMediaDraft: (job: MediaJob, expectedDraftRevision: number, onlyUnstarted = false) =>
    request('POST', `/api/media/jobs/${job.id}/discard`, {
      expectedDraftRevision,
      expectedRevision: job.revision,
      onlyUnstarted,
    }),
  rerunMediaJob: (job: MediaJob, requestKey: string, options: Partial<MediaJobDraft> = {}) =>
    request<MediaJob>('POST', `/api/media/jobs/${job.id}/rerun`, {
      ...options,
      expectedRevision: job.revision,
      requestKey,
    }),
  deleteMediaJob: (job: MediaJob) =>
    request('DELETE', `/api/media/jobs/${job.id}?expectedRevision=${job.revision}`),
  authStatus: () =>
    request<{ required: boolean; authenticated: boolean }>('GET', '/api/auth/status'),
  login: (password: string) =>
    request<{ authenticated: boolean }>('POST', '/api/auth/login', { password }),
  logout: () => request<{ authenticated: boolean }>('POST', '/api/auth/logout'),

  conversations: () => request<Conversation[]>('GET', '/api/conversations'),
  gallery: () => request<GalleryItem[]>('GET', '/api/gallery'),
  uploadGalleryImage: (file: File, characterId: number | null, characterName?: string) => {
    const query = new URLSearchParams();
    if (characterId != null) query.set('characterId', String(characterId));
    else if (characterName) query.set('characterName', characterName);
    return request<GalleryItem>('POST', `/api/gallery/upload?${query}`, undefined, {
      rawBody: file,
      contentType: file.type || 'application/octet-stream',
    });
  },
  saveGalleryImage: (messageId: number, index: number) =>
    request<{ item: GalleryItem; created: boolean }>('POST', '/api/gallery', {
      messageId,
      index,
    }),
  generateGalleryPrompt: async (
    id: number,
    workflowId: string,
    signal: AbortSignal,
    onProgress: (progress: ImageDescriptionProgress) => void,
  ): Promise<string> => {
    const res = await fetch(`/api/gallery/${id}/describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId }),
      signal,
    });
    if (!res.ok || !res.body) throw await errorFromResponse(res);
    let prompt = '';
    let completed = false;
    await readSseData(res.body, (data) => {
      const payload = JSON.parse(data) as {
        progress?: ImageDescriptionProgress;
        d?: string;
        done?: boolean;
        error?: string;
      };
      if (payload.error) throw new ApiError(502, payload.error);
      if (payload.progress) onProgress(payload.progress);
      if (payload.d !== undefined) prompt += payload.d;
      if (payload.done) completed = true;
    });
    if (!completed || !prompt.trim())
      throw new ApiError(502, 'Prompt generation ended without a result');
    return prompt;
  },
  updateGalleryItem: (
    id: number,
    value: { prompt: string; characterIds: number[] },
    expected: { prompt: string; characterIds: number[] },
  ) =>
    request<GalleryItem>('PATCH', `/api/gallery/${id}`, {
      ...value,
      expectedPrompt: expected.prompt,
      expectedCharacterIds: expected.characterIds,
    }),
  deleteGalleryItem: (id: number) => request<void>('DELETE', `/api/gallery/${id}`),
  deleteGalleryItems: (ids: number[]) =>
    request<{ deleted: number }>('POST', '/api/gallery/bulk-delete', { ids }),
  deleteAllConversations: () => request<{ deleted: number }>('DELETE', '/api/conversations'),
  deleteAllCharacters: () => request<{ deleted: number }>('DELETE', '/api/characters'),
  resetSettings: (expectedRevision: number): Promise<Settings> =>
    api.putSettings(
      {
        ...DEFAULT_SETTINGS,
        imageGeneration: { ...DEFAULT_SETTINGS.imageGeneration, promptPresets: {} },
      },
      expectedRevision,
    ),
  createConversation: (characterId: number | null) =>
    request<Conversation>('POST', '/api/conversations', { characterId }),
  patchConversation: mutation<Conversation, Partial<Conversation>>('conversations', '', 'PATCH'),
  deleteConversation: mutation<void>('conversations', '', 'DELETE'),
  duplicateConversation: (id: number) =>
    request<Conversation>('POST', `/api/conversations/${id}/duplicate`),
  branchConversation: (messageId: number) =>
    request<Conversation>('POST', `/api/messages/${messageId}/branch-conversation`),
  search: (q: string) =>
    request<{ conversation: Conversation; snippet: string | null }[]>(
      'GET',
      `/api/search?q=${encodeURIComponent(q)}`,
    ),
  trace: (id: number) => request<PromptTrace>('GET', `/api/conversations/${id}/trace`),
  send: mutation<{ userMessageId: number; assistantMessageId: number }, ContentBody>(
    'conversations',
    'messages',
  ),
  deleteTail: mutation<ActiveLeafResult & { deletedSiblingRoots: number }, { count: number }>(
    'conversations',
    'delete-tail',
  ),
  toolGenerate: mutation<
    { toolMessageId: number; activeLeafId: number },
    { prompt: string; label: string; image?: MediaImageConfig }
  >('conversations', 'tool'),
  moveMessage: mutation<ActiveLeafResult, { direction: 'up' | 'down' }>('messages', 'move'),
  moveMessageRange: (
    messageIds: number[],
    direction: 'up' | 'down',
    steps: number,
    expected: MutationState,
  ) =>
    mutationRequest<{ activeLeafId: number | null; movedSteps: number }>(
      'POST',
      '/api/message-ranges/move',
      expected,
      {
        messageIds,
        direction,
        steps,
      },
    ),
  deleteMessageRange: (messageIds: number[], expected: MutationState) =>
    mutationRequest<{ activeLeafId: number | null }>(
      'POST',
      '/api/message-ranges/delete',
      expected,
      {
        messageIds,
      },
    ),
  duplicateMessage: mutation<{ messageId: number; activeLeafId: number }>('messages', 'duplicate'),
  renderImage: mutation<{ rendering: boolean }, MediaImageConfig | undefined>(
    'messages',
    'render-image',
  ),
  setActiveImage: mutation<void, ImageIndexBody>('messages', 'active-image'),
  deleteImage: mutation<Message, ImageIndexBody>('messages', 'delete-image'),
  editMessage: mutation<unknown, ContentBody>('messages', '', 'PATCH'),
  editBranch: mutation<{ messageId: number }, ContentBody>('messages', 'edit-branch'),
  activate: mutation<{ activeLeafId: number }>('messages', 'activate'),
  advance: mutation<{ activeLeafId: number; assistantMessageId: number | null }>(
    'messages',
    'advance',
  ),
  regenerate: mutation<
    { activeLeafId: number; assistantMessageId: number },
    { instruction: string; image?: MediaImageConfig }
  >('messages', 'regenerate'),
  deleteMessage: mutation<void>('messages', '', 'DELETE'),
  deleteSwipe: mutation<ActiveLeafResult>('messages', 'swipe', 'DELETE'),
  resume: mutation<{ assistantMessageId: number }>('messages', 'continue'),
  stopGeneration: (messageId: number, expectedGenerationToken: number) =>
    request<{ stopped: boolean }>('POST', `/api/generations/${messageId}/stop`, {
      expectedGenerationToken,
    }),

  characters: {
    ...avatarEntity<Character>('characters'),
    importCard: (file: File) =>
      request<Character>('POST', '/api/characters/import-card', undefined, {
        rawBody: file,
        contentType: 'application/octet-stream',
      }),
  },
  entityFolders: Object.fromEntries(
    Object.entries(ENTITY_FOLDERS).map(([entity, { path }]) => [
      entity,
      resource<EntityFolder>(path),
    ]),
  ) as Record<FolderEntity, ReturnType<typeof resource<EntityFolder>>>,
  templates: entity<Template>('templates'),
  presets: entity<Preset>('presets'),
  personas: {
    ...avatarEntity<Persona>('personas'),
    import: async (data: unknown, targetId: number | null) =>
      (
        await request<Persona[]>('POST', '/api/personas/settings-import', {
          document: transferDocument('entity:personas', data),
          targetId,
        })
      )[0]!,
  },
  // Replace genParams after dirty-field reduction so clearing its last entry persists.
  endpoints: {
    ...entity<Endpoint>('endpoints', prepareEndpointPatch),
    models: (id: number) => request<string[]>('GET', `/api/endpoints/${id}/models`),
  },

  settings: () => request<Settings>('GET', '/api/settings'),
  putSettings: (
    settings: Partial<Settings>,
    expectedRevision: number,
    accessPassword?: string | null,
  ) =>
    request<Settings>('PUT', '/api/settings', {
      ...settings,
      expectedRevision,
      ...(accessPassword === undefined ? {} : { accessPassword }),
    }),
};
