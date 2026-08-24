import type {
  Character,
  CharacterFolder,
  Conversation,
  Endpoint,
  Message,
  Persona,
  Preset,
  Settings,
  Template,
} from '@minitavern/shared';

interface RequestOptions {
  rawBody?: BodyInit;
  contentType?: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
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
    let message = `${res.status}`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      /* keep status */
    }
    if (res.status === 401 && !url.startsWith('/api/auth/')) onAuthenticationRequired?.();
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Error-message extraction shared by the non-JSON (SSE / binary) endpoints. */
async function errorFromResponse(res: Response): Promise<ApiError> {
  let message = `${res.status}`;
  try {
    const json = (await res.json()) as { error?: string };
    if (json.error) message = json.error;
  } catch {
    /* keep status */
  }
  return new ApiError(res.status, message);
}

/** Reads the avatar prompt SSE stream ({d} deltas, {error}, {done}), invoking
 * onDelta per token and resolving with the assembled text. */
async function streamAvatarPrompt(
  kind: 'character' | 'persona',
  id: number,
  prompt: string,
  context: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(
    `/api/${kind === 'character' ? 'characters' : 'personas'}/${id}/avatar/prompt`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, context }),
      signal: signal ?? null,
    },
  );
  if (!res.ok || !res.body) throw await errorFromResponse(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let completed = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = JSON.parse(line.slice(5)) as { d?: string; error?: string; done?: boolean };
      if (payload.error) throw new ApiError(502, payload.error);
      if (payload.done) completed = true;
      if (payload.d) {
        text += payload.d;
        onDelta(payload.d);
      }
    }
  }
  if (!completed) throw new ApiError(502, 'avatar prompt stream ended before completion');
  return text;
}

/** Stateless avatar render: prompt + workflow in, image bytes out. */
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

/** Opens the job-scoped avatar-render progress stream. Resolving means the
 * server registered this listener, so the render can start without racing its
 * first sampler events. */
async function openAvatarRenderProgress(
  jobId: string,
  onProgress: (value: number, max: number) => void,
  onPreview: (dataUrl: string) => void,
  signal?: AbortSignal,
): Promise<{ done: Promise<void> }> {
  const res = await fetch(`/api/avatar/render-progress/${encodeURIComponent(jobId)}`, {
    signal: signal ?? null,
  });
  if (!res.ok || !res.body) throw await errorFromResponse(res);
  const done = (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = JSON.parse(line.slice(5)) as {
          value?: unknown;
          max?: unknown;
          preview?: unknown;
          done?: boolean;
        };
        if (
          typeof payload.value === 'number' &&
          typeof payload.max === 'number' &&
          payload.max > 0
        ) {
          onProgress(payload.value, payload.max);
        }
        if (typeof payload.preview === 'string' && payload.preview.startsWith('data:image/')) {
          onPreview(payload.preview);
        }
        if (payload.done) return;
      }
    }
  })();
  return { done };
}

export const api = {
  authStatus: () =>
    request<{ required: boolean; authenticated: boolean }>('GET', '/api/auth/status'),
  login: (password: string) =>
    request<{ authenticated: boolean }>('POST', '/api/auth/login', { password }),
  logout: () => request<{ authenticated: boolean }>('POST', '/api/auth/logout'),

  conversations: () => request<Conversation[]>('GET', '/api/conversations'),
  deleteAllConversations: () => request<{ deleted: number }>('DELETE', '/api/conversations'),
  createConversation: (characterId: number | null) =>
    request<Conversation>('POST', '/api/conversations', { characterId }),
  patchConversation: (
    id: number,
    patch: Partial<Conversation>,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<Conversation>('PATCH', `/api/conversations/${id}`, {
      ...patch,
      expectedActiveLeafId,
      expectedMutationRevision,
    }),
  deleteConversation: (
    id: number,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<void>(
      'DELETE',
      `/api/conversations/${id}?expectedActiveLeafId=${expectedActiveLeafId ?? 'null'}&expectedMutationRevision=${expectedMutationRevision}`,
    ),
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
  send: (
    conversationId: number,
    content: string,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<{ userMessageId: number; assistantMessageId: number }>(
      'POST',
      `/api/conversations/${conversationId}/messages`,
      { content, expectedActiveLeafId, expectedMutationRevision },
    ),
  deleteTail: (
    conversationId: number,
    count: number,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<{ activeLeafId: number | null; deletedSiblingRoots: number }>(
      'POST',
      `/api/conversations/${conversationId}/delete-tail`,
      { count, expectedActiveLeafId, expectedMutationRevision },
    ),
  toolGenerate: (
    conversationId: number,
    prompt: string,
    label: string,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
    image?: { workflow: string; comfyUrl: string },
  ) =>
    request<{ toolMessageId: number; activeLeafId: number }>(
      'POST',
      `/api/conversations/${conversationId}/tool`,
      {
        prompt,
        label,
        expectedActiveLeafId,
        expectedMutationRevision,
        ...(image ? { image } : {}),
      },
    ),

  moveMessage: (
    messageId: number,
    direction: 'up' | 'down',
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<{ activeLeafId: number | null }>('POST', `/api/messages/${messageId}/move`, {
      direction,
      expectedActiveLeafId,
      expectedMutationRevision,
    }),
  duplicateMessage: (
    messageId: number,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<{ messageId: number; activeLeafId: number }>(
      'POST',
      `/api/messages/${messageId}/duplicate`,
      { expectedActiveLeafId, expectedMutationRevision },
    ),
  renderImage: (
    messageId: number,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
    currentConfig?: { workflow: string; comfyUrl: string },
  ) =>
    request<{ rendering: boolean }>('POST', `/api/messages/${messageId}/render-image`, {
      ...currentConfig,
      expectedActiveLeafId,
      expectedMutationRevision,
    }),
  setActiveImage: (
    messageId: number,
    index: number,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<void>('POST', `/api/messages/${messageId}/active-image`, {
      index,
      expectedActiveLeafId,
      expectedMutationRevision,
    }),
  deleteImage: (
    messageId: number,
    index: number,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<Message>('POST', `/api/messages/${messageId}/delete-image`, {
      index,
      expectedActiveLeafId,
      expectedMutationRevision,
    }),

  editMessage: (
    messageId: number,
    content: string,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<unknown>('PATCH', `/api/messages/${messageId}`, {
      content,
      expectedActiveLeafId,
      expectedMutationRevision,
    }),
  editBranch: (
    messageId: number,
    content: string,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<{ messageId: number }>('POST', `/api/messages/${messageId}/edit-branch`, {
      content,
      expectedActiveLeafId,
      expectedMutationRevision,
    }),
  activate: (
    messageId: number,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<{ activeLeafId: number }>('POST', `/api/messages/${messageId}/activate`, {
      expectedActiveLeafId,
      expectedMutationRevision,
    }),
  advance: (
    messageId: number,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<{ activeLeafId: number; assistantMessageId: number | null }>(
      'POST',
      `/api/messages/${messageId}/advance`,
      { expectedActiveLeafId, expectedMutationRevision },
    ),
  regenerate: (
    messageId: number,
    instruction: string,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
    image?: { workflow: string; comfyUrl: string },
  ) =>
    request<{ activeLeafId: number; assistantMessageId: number }>(
      'POST',
      `/api/messages/${messageId}/regenerate`,
      { instruction, expectedActiveLeafId, expectedMutationRevision, image },
    ),
  deleteMessage: (
    messageId: number,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<void>(
      'DELETE',
      `/api/messages/${messageId}?expectedActiveLeafId=${expectedActiveLeafId ?? 'null'}&expectedMutationRevision=${expectedMutationRevision}`,
    ),
  deleteSwipe: (
    messageId: number,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<{ activeLeafId: number | null }>(
      'DELETE',
      `/api/messages/${messageId}/swipe?expectedActiveLeafId=${expectedActiveLeafId ?? 'null'}&expectedMutationRevision=${expectedMutationRevision}`,
    ),
  resume: (
    messageId: number,
    expectedActiveLeafId: number | null,
    expectedMutationRevision: number,
  ) =>
    request<{ assistantMessageId: number }>('POST', `/api/messages/${messageId}/continue`, {
      expectedActiveLeafId,
      expectedMutationRevision,
    }),
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
    request<Endpoint>('PATCH', `/api/endpoints/${id}`, data),
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
