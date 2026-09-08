import type { Settings } from '@tinytavern/shared';
import {
  DEFAULT_SETTINGS,
  MEDIA_PROMPT_SETTINGS_KEYS,
  mediaPromptSettingsKey,
} from '@tinytavern/shared';
import { route, HttpError } from '../router.ts';
import { getSettings, putSettings } from '../settingsStore.ts';
import { disconnectAllForAuthChange, invalidate } from '../events.ts';
import { requireReference, type EntityTable } from './entityUtils.ts';
import {
  objectBody,
  optionalBoolean,
  optionalNullableId,
  optionalNumber,
  optionalString,
} from '../validation.ts';
import { discardSpeculativeSwipes, prepareSubscribedSwipes } from '../speculation.ts';
import { subscribedConversationIds } from '../events.ts';
import { bumpAllConversationRevisions } from '../conversationRevision.ts';
import { broadcastTree } from '../sync.ts';
import { clearSession, setAccessPassword, startSession, validateNewPassword } from '../auth.ts';
import { parseImageGenerationSettings } from '../imageSettings.ts';
import { parseMediaRendering, parseMediaPrompts } from '../mediaSettings.ts';

route.get('/api/settings', () => getSettings());

route.put('/api/settings', ({ req, res, body }) => {
  const b = objectBody(body);
  const current = getSettings();
  const expectedRevision = optionalNumber(b, 'expectedRevision');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
    invalidate('settings');
    throw new HttpError(409, 'global settings changed on another device; review and retry');
  }
  const ids = {
    defaultPresetId: optionalNullableId(b, 'defaultPresetId'),
    activeEndpointId: optionalNullableId(b, 'activeEndpointId'),
    defaultPersonaId: optionalNullableId(b, 'defaultPersonaId'),
    defaultTemplateId: optionalNullableId(b, 'defaultTemplateId'),
  };
  const tables: Record<keyof typeof ids, EntityTable> = {
    defaultPresetId: 'presets',
    activeEndpointId: 'endpoints',
    defaultPersonaId: 'personas',
    defaultTemplateId: 'templates',
  };
  for (const key of Object.keys(ids) as (keyof typeof ids)[]) {
    requireReference(tables[key], ids[key], key);
  }
  const promptSettings: Partial<Pick<Settings, 'titlePrompt' | 'draftCompletionPrompt'>> = {};
  for (const key of ['titlePrompt', 'draftCompletionPrompt'] as const) {
    const value = optionalString(b, key);
    if (value === undefined) continue;
    if (!value.trim()) throw new HttpError(400, `${key} is required`);
    if (key === 'draftCompletionPrompt' && !value.toLowerCase().includes('{{draft}}')) {
      throw new HttpError(400, 'draftCompletionPrompt must include {{draft}}');
    }
    if (key === 'titlePrompt' && /\{\{(?:userMessage|assistantMessage)\}\}/i.test(value)) {
      throw new HttpError(
        400,
        'The title instruction uses the full chat context; remove the standalone message macros.',
      );
    }
    promptSettings[key] = value;
  }
  const galleryThumbnailSize = optionalNumber(b, 'galleryThumbnailSize');
  if (
    galleryThumbnailSize !== undefined &&
    (!Number.isInteger(galleryThumbnailSize) ||
      galleryThumbnailSize < 64 ||
      galleryThumbnailSize > 2048)
  ) {
    throw new HttpError(400, 'Thumbnail size must be a whole number between 64 and 2048 pixels');
  }
  const autoExpandThinking = optionalBoolean(b, 'autoExpandThinking');
  const backgroundSwipeGeneration = optionalBoolean(b, 'backgroundSwipeGeneration');
  const parallelBackgroundSwipeGeneration = optionalBoolean(b, 'parallelBackgroundSwipeGeneration');
  const accessPassword = b.accessPassword;
  if (accessPassword !== undefined) {
    try {
      validateNewPassword(accessPassword);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  }
  const imageGeneration = parseImageGenerationSettings(b.imageGeneration);
  const mediaRendering = parseMediaRendering(b.mediaRendering);
  if ('mediaPrompts' in b)
    throw new HttpError(400, 'Chat and gallery prompts must be saved separately');
  const mediaPrompts = Object.fromEntries(
    MEDIA_PROMPT_SETTINGS_KEYS.filter((key) => b[key] !== undefined).map((key) => [
      key,
      parseMediaPrompts(b[key], key),
    ]),
  );
  const next: Settings = {
    ...DEFAULT_SETTINGS,
    ...current,
    ...promptSettings,
    ...Object.fromEntries(Object.entries(ids).filter(([, value]) => value !== undefined)),
    ...(autoExpandThinking === undefined ? {} : { autoExpandThinking }),
    ...(galleryThumbnailSize === undefined ? {} : { galleryThumbnailSize }),
    ...(backgroundSwipeGeneration === undefined ? {} : { backgroundSwipeGeneration }),
    ...(parallelBackgroundSwipeGeneration === undefined
      ? {}
      : { parallelBackgroundSwipeGeneration }),
    ...(accessPassword === undefined ? {} : { hasPassword: accessPassword !== null }),
    ...(imageGeneration === undefined
      ? {}
      : { imageGeneration: { ...current.imageGeneration, ...imageGeneration } }),
    ...(mediaRendering === undefined ? {} : { mediaRendering }),
    ...mediaPrompts,
    revision: current.revision + 1,
  };
  next.mediaRendering = {
    ...next.mediaRendering,
    workflows: next.mediaRendering.workflows.map((workflow) => {
      const result = { ...workflow };
      for (const field of ['galleryPromptPresetId', 'chatPromptPresetId'] as const) {
        const selected = workflow[field];
        if (selected === null) continue;
        const chat = field === 'chatPromptPresetId';
        const key = mediaPromptSettingsKey(workflow.operation, chat);
        const preset = next[key].presets.find(
          (item) => item.id === selected && item.operation === workflow.operation,
        );
        if (preset && (!chat || workflow.operation.startsWith('video'))) continue;
        if (!(key in mediaPrompts))
          throw new HttpError(
            400,
            `${workflow.name}: choose a compatible ${chat ? 'chat' : 'gallery'} prompt preset`,
          );
        result[field] = null;
      }
      return result;
    }),
  };
  putSettings(next);
  if (accessPassword !== undefined) {
    setAccessPassword(accessPassword as string | null);
    if (accessPassword === null) clearSession(req, res);
    else startSession(req, res);
  }
  const generationContextChanged =
    current.activeEndpointId !== next.activeEndpointId ||
    current.defaultPresetId !== next.defaultPresetId ||
    current.defaultTemplateId !== next.defaultTemplateId;
  if (
    generationContextChanged ||
    (current.backgroundSwipeGeneration && !next.backgroundSwipeGeneration) ||
    (current.parallelBackgroundSwipeGeneration && !next.parallelBackgroundSwipeGeneration)
  ) {
    discardSpeculativeSwipes();
  }
  if (generationContextChanged) {
    bumpAllConversationRevisions();
    for (const conversationId of subscribedConversationIds()) broadcastTree(conversationId);
  }
  if (
    next.backgroundSwipeGeneration &&
    (!current.backgroundSwipeGeneration ||
      (!current.parallelBackgroundSwipeGeneration && next.parallelBackgroundSwipeGeneration))
  ) {
    prepareSubscribedSwipes();
  }
  if (accessPassword === undefined) invalidate('settings');
  else {
    // Let the PUT response (and its replacement cookie) reach the initiating
    // browser before peers are told to reauthenticate.
    setImmediate(() => {
      invalidate('settings');
      disconnectAllForAuthChange();
    });
  }
  return next;
});
