import type {
  Character,
  CharacterFolder,
  Conversation,
  Endpoint,
  GalleryItem,
  Message,
  Persona,
  Preset,
  Settings,
  Template,
} from '@tinytavern/shared';
import { readSseData } from '@tinytavern/shared';
import { prepareEndpointPatch } from './endpointSync.ts';

interface RequestOptions {
  rawBody?: BodyInit;
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

/** Streams {d}/{error}/{done} SSE events and returns the assembled text. */
export async function streamTextCompletion(
  url: string,
  body: Record<string, unknown>,
  onDelta: (delta: string, text: string) => void,
  streamLabel: string,
  signal?: AbortSignal,
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
    const payload = JSON.parse(data) as { d?: unknown; error?: unknown; done?: unknown };
    if (typeof payload.error === 'string' && payload.error) throw new ApiError(502, payload.error);
    if (payload.done === true) completed = true;
    if (typeof payload.d === 'string' && payload.d) {
      text += payload.d;
      onDelta(payload.d, text);
    }
  });
  if (!completed) throw new ApiError(502, `${streamLabel} stream ended before completion`);
  return text;
}

const streamAvatarPrompt = (
  kind: 'character' | 'persona',
  id: number,
  prompt: string,
  context: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
) =>
  streamTextCompletion(
    `/api/${kind === 'character' ? 'characters' : 'personas'}/${id}/avatar/prompt`,
    { prompt, context },
    onDelta,
    'avatar prompt',
    signal,
  );

const streamGalleryPromptRevision = (
  id: number,
  prompt: string,
  instruction: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
) =>
  streamTextCompletion(
    `/api/gallery/${id}/revise-prompt`,
    { prompt, instruction },
    onDelta,
    'gallery prompt revision',
    signal,
  );

async function renderAvatar(
  body: {
    prompt: string;
    image: { workflow: string; comfyUrl: string };
    jobId?: string;
  },
  signal?: AbortSignal,
): Promise<Blob> {
  const res = await fetch('/api/avatar/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res.blob();
}

/** Resolves after listener registration so rendering cannot race its first event. */
async function openRenderProgress(
  url: string,
  jobId: string,
  onProgress: (value: number, max: number) => void,
  onPreview: (dataUrl: string) => void,
  signal?: AbortSignal,
): Promise<{ done: Promise<void> }> {
  const res = await fetch(`${url}/${encodeURIComponent(jobId)}`, {
    signal: signal ?? null,
  });
  if (!res.ok || !res.body) throw await errorFromResponse(res);
  const done = readSseData(res.body, (data) => {
    const payload = JSON.parse(data) as {
      value?: unknown;
      max?: unknown;
      preview?: unknown;
      done?: unknown;
    };
    if (typeof payload.value === 'number' && typeof payload.max === 'number' && payload.max > 0) {
      onProgress(payload.value, payload.max);
    }
    if (typeof payload.preview === 'string' && payload.preview.startsWith('data:image/')) {
      onPreview(payload.preview);
    }
    if (payload.done === true) return false;
  });
  return { done };
}

const openAvatarRenderProgress = (
  jobId: string,
  onProgress: (value: number, max: number) => void,
  onPreview: (dataUrl: string) => void,
  signal?: AbortSignal,
) => openRenderProgress('/api/avatar/render-progress', jobId, onProgress, onPreview, signal);

const openGalleryRenderProgress = (
  jobId: string,
  onProgress: (value: number, max: number) => void,
  onPreview: (dataUrl: string) => void,
  signal?: AbortSignal,
) => openRenderProgress('/api/gallery/render-progress', jobId, onProgress, onPreview, signal);

export const api = {
  authStatus: () =>
    request<{ required: boolean; authenticated: boolean }>('GET', '/api/auth/status'),
  login: (password: string) =>
    request<{ authenticated: boolean }>('POST', '/api/auth/login', { password }),
  logout: () => request<{ authenticated: boolean }>('POST', '/api/auth/logout'),

  conversations: () => request<Conversation[]>('GET', '/api/conversations'),
  gallery: () => request<GalleryItem[]>('GET', '/api/gallery'),
  saveGalleryImage: (messageId: number, index: number) =>
    request<{ item: GalleryItem; created: boolean }>('POST', '/api/gallery', {
      messageId,
      index,
    }),
  streamGalleryPromptRevision,
  renderGalleryImage: (
    id: number,
    jobId: string,
    prompt: string,
    currentConfig?: { workflow: string; comfyUrl: string },
  ) =>
    request<GalleryItem>('POST', `/api/gallery/${id}/render-image`, {
      ...currentConfig,
      jobId,
      prompt,
    }),
  openGalleryRenderProgress,
  deleteGalleryItem: (id: number) => request<void>('DELETE', `/api/gallery/${id}`),
  deleteGalleryItems: (ids: number[]) =>
    request<{ deleted: number }>('POST', '/api/gallery/bulk-delete', { ids }),
  deleteAllConversations: () => request<{ deleted: number }>('DELETE', '/api/conversations'),
  createConversation: (characterId: number | null) =>
    request<Conversation>('POST', '/api/conversations', { characterId }),
  patchConversation: (id: number, patch: Partial<Conversation>, expected: MutationState) =>
    mutationRequest<Conversation>('PATCH', `/api/conversations/${id}`, expected, {
      ...patch,
    }),
  deleteConversation: (id: number, expected: MutationState) =>
    mutationRequest<void>('DELETE', `/api/conversations/${id}`, expected),
  duplicateConversation: (id: number) =>
    request<Conversation>('POST', `/api/conversations/${id}/duplicate`),
  branchConversation: (messageId: number) =>
    request<Conversation>('POST', `/api/messages/${messageId}/branch-conversation`),
  search: (q: string) =>
    request<{ conversation: Conversation; snippet: string | null }[]>(
      'GET',
      `/api/search?q=${encodeURIComponent(q)}`,
    ),
  trace: (id: number) =>
    request<{
      messages: { role: string; content: string; reasoning_content?: string }[];
      reasoningPrefill: string | null;
      messagePrefill: string | null;
      namePrefill: string | null;
    }>('GET', `/api/conversations/${id}/trace`),
  send: (conversationId: number, content: string, expected: MutationState) =>
    mutationRequest<{ userMessageId: number; assistantMessageId: number }>(
      'POST',
      `/api/conversations/${conversationId}/messages`,
      expected,
      { content },
    ),
  deleteTail: (conversationId: number, count: number, expected: MutationState) =>
    mutationRequest<{ activeLeafId: number | null; deletedSiblingRoots: number }>(
      'POST',
      `/api/conversations/${conversationId}/delete-tail`,
      expected,
      { count },
    ),
  toolGenerate: (
    conversationId: number,
    prompt: string,
    label: string,
    expected: MutationState,
    image?: { workflow: string; comfyUrl: string },
  ) =>
    mutationRequest<{ toolMessageId: number; activeLeafId: number }>(
      'POST',
      `/api/conversations/${conversationId}/tool`,
      expected,
      {
        prompt,
        label,
        ...(image ? { image } : {}),
      },
    ),

  moveMessage: (messageId: number, direction: 'up' | 'down', expected: MutationState) =>
    mutationRequest<{ activeLeafId: number | null }>(
      'POST',
      `/api/messages/${messageId}/move`,
      expected,
      {
        direction,
      },
    ),
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
  duplicateMessage: (messageId: number, expected: MutationState) =>
    mutationRequest<{ messageId: number; activeLeafId: number }>(
      'POST',
      `/api/messages/${messageId}/duplicate`,
      expected,
    ),
  renderImage: (
    messageId: number,
    expected: MutationState,
    currentConfig?: { workflow: string; comfyUrl: string },
  ) =>
    mutationRequest<{ rendering: boolean }>(
      'POST',
      `/api/messages/${messageId}/render-image`,
      expected,
      {
        ...currentConfig,
      },
    ),
  setActiveImage: (messageId: number, index: number, expected: MutationState) =>
    mutationRequest<void>('POST', `/api/messages/${messageId}/active-image`, expected, {
      index,
    }),
  deleteImage: (messageId: number, index: number, expected: MutationState) =>
    mutationRequest<Message>('POST', `/api/messages/${messageId}/delete-image`, expected, {
      index,
    }),

  editMessage: (messageId: number, content: string, expected: MutationState) =>
    mutationRequest<unknown>('PATCH', `/api/messages/${messageId}`, expected, {
      content,
    }),
  editBranch: (messageId: number, content: string, expected: MutationState) =>
    mutationRequest<{ messageId: number }>(
      'POST',
      `/api/messages/${messageId}/edit-branch`,
      expected,
      {
        content,
      },
    ),
  activate: (messageId: number, expected: MutationState) =>
    mutationRequest<{ activeLeafId: number }>(
      'POST',
      `/api/messages/${messageId}/activate`,
      expected,
    ),
  advance: (messageId: number, expected: MutationState) =>
    mutationRequest<{ activeLeafId: number; assistantMessageId: number | null }>(
      'POST',
      `/api/messages/${messageId}/advance`,
      expected,
    ),
  regenerate: (
    messageId: number,
    instruction: string,
    expected: MutationState,
    image?: { workflow: string; comfyUrl: string },
  ) =>
    mutationRequest<{ activeLeafId: number; assistantMessageId: number }>(
      'POST',
      `/api/messages/${messageId}/regenerate`,
      expected,
      { instruction, image },
    ),
  deleteMessage: (messageId: number, expected: MutationState) =>
    mutationRequest<void>('DELETE', `/api/messages/${messageId}`, expected),
  deleteSwipe: (messageId: number, expected: MutationState) =>
    mutationRequest<{ activeLeafId: number | null }>(
      'DELETE',
      `/api/messages/${messageId}/swipe`,
      expected,
    ),
  resume: (messageId: number, expected: MutationState) =>
    mutationRequest<{ assistantMessageId: number }>(
      'POST',
      `/api/messages/${messageId}/continue`,
      expected,
    ),
  stopGeneration: (messageId: number, expectedGenerationToken: number) =>
    request<{ stopped: boolean }>('POST', `/api/generations/${messageId}/stop`, {
      expectedGenerationToken,
    }),

  characters: () => request<Character[]>('GET', '/api/characters'),
  createCharacter: (data: Partial<Character>) =>
    request<Character>('POST', '/api/characters', data),
  patchCharacter: (id: number, data: Partial<Character>) =>
    request<Character>('PATCH', `/api/characters/${id}`, data),
  deleteCharacter: (id: number) => request<void>('DELETE', `/api/characters/${id}`),
  duplicateCharacter: (id: number) => request<Character>('POST', `/api/characters/${id}/duplicate`),
  uploadCharacterAvatar: (id: number, file: File) =>
    request<Character>('PUT', `/api/characters/${id}/avatar`, undefined, {
      rawBody: file,
      contentType: file.type,
    }),
  deleteCharacterAvatar: (id: number) =>
    request<Character>('DELETE', `/api/characters/${id}/avatar`),
  importCard: (file: File) =>
    request<Character>('POST', '/api/characters/import-card', undefined, {
      rawBody: file,
      contentType: 'application/octet-stream',
    }),

  characterFolders: () => request<CharacterFolder[]>('GET', '/api/character-folders'),
  createCharacterFolder: (name: string) =>
    request<CharacterFolder>('POST', '/api/character-folders', { name }),
  patchCharacterFolder: (id: number, name: string) =>
    request<CharacterFolder>('PATCH', `/api/character-folders/${id}`, { name }),
  deleteCharacterFolder: (id: number) => request<void>('DELETE', `/api/character-folders/${id}`),

  templates: () => request<Template[]>('GET', '/api/templates'),
  createTemplate: (data: Partial<Template>) => request<Template>('POST', '/api/templates', data),
  patchTemplate: (id: number, data: Partial<Template>) =>
    request<Template>('PATCH', `/api/templates/${id}`, data),
  deleteTemplate: (id: number) => request<void>('DELETE', `/api/templates/${id}`),
  duplicateTemplate: (id: number) => request<Template>('POST', `/api/templates/${id}/duplicate`),

  presets: () => request<Preset[]>('GET', '/api/presets'),
  createPreset: (data: Partial<Preset>) => request<Preset>('POST', '/api/presets', data),
  patchPreset: (id: number, data: Partial<Preset>) =>
    request<Preset>('PATCH', `/api/presets/${id}`, data),
  deletePreset: (id: number) => request<void>('DELETE', `/api/presets/${id}`),
  duplicatePreset: (id: number) => request<Preset>('POST', `/api/presets/${id}/duplicate`),

  personas: () => request<Persona[]>('GET', '/api/personas'),
  createPersona: (data: Partial<Persona>) => request<Persona>('POST', '/api/personas', data),
  patchPersona: (id: number, data: Partial<Persona>) =>
    request<Persona>('PATCH', `/api/personas/${id}`, data),
  deletePersona: (id: number) => request<void>('DELETE', `/api/personas/${id}`),
  duplicatePersona: (id: number) => request<Persona>('POST', `/api/personas/${id}/duplicate`),
  uploadPersonaAvatar: (id: number, file: File) =>
    request<Persona>('PUT', `/api/personas/${id}/avatar`, undefined, {
      rawBody: file,
      contentType: file.type,
    }),
  deletePersonaAvatar: (id: number) => request<Persona>('DELETE', `/api/personas/${id}/avatar`),

  streamAvatarPrompt,
  renderAvatar,
  openAvatarRenderProgress,

  endpoints: () => request<Endpoint[]>('GET', '/api/endpoints'),
  createEndpoint: (data: Partial<Endpoint>) => request<Endpoint>('POST', '/api/endpoints', data),
  patchEndpoint: (id: number, data: Partial<Endpoint>) =>
    request<Endpoint>(
      'PATCH',
      `/api/endpoints/${id}`,
      // Replace genParams after dirty-field reduction so clearing its last entry persists.
      prepareEndpointPatch(data),
    ),
  deleteEndpoint: (id: number) => request<void>('DELETE', `/api/endpoints/${id}`),
  duplicateEndpoint: (id: number) => request<Endpoint>('POST', `/api/endpoints/${id}/duplicate`),
  fetchModels: (id: number) => request<string[]>('GET', `/api/endpoints/${id}/models`),

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
