import type { Settings } from '@tinytavern/shared';
import {
  DEFAULT_SETTINGS,
  MEDIA_PROMPT_SETTINGS_KEYS,
  mediaPromptSettingsKey,
} from '@tinytavern/shared';
import { route, HttpError } from '../http/router.ts';
import {
  getSettings,
  putSettings,
  SETTINGS_REFERENCE_TABLES,
  type SettingsReferenceKey,
} from '../settings/settingsStore.ts';
import { disconnectAllForAuthChange, invalidate } from '../realtime/events.ts';
import { requireReference } from './shared/entityUtils.ts';
import {
  objectBody,
  optionalBoolean,
  optionalNullableId,
  optionalNumber,
  optionalString,
} from '../http/validation.ts';
import { discardSpeculativeSwipes, prepareSubscribedSwipes } from '../generation/speculation.ts';
import { subscribedConversationIds } from '../realtime/events.ts';
import { bumpAllConversationRevisions } from '../conversations/conversationRevision.ts';
import { broadcastTree } from '../realtime/sync.ts';
import {
  clearSession,
  setAccessPassword,
  startSession,
  validateNewPassword,
} from '../http/auth.ts';
import { parseImageGenerationSettings } from '../media/imageSettings.ts';
import {
  parseMediaRendering,
  parseMediaPrompts,
  parseMediaFavorites,
  supportsMediaFavorite,
} from '../media/mediaSettings.ts';

route.get('/api/settings', () => getSettings());

route.put('/api/settings', ({ req, headers, body }) => {
  const b = objectBody(body);
  const current = getSettings();
  const expectedRevision = optionalNumber(b, 'expectedRevision');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
    invalidate('settings');
    throw new HttpError(409, 'global settings changed on another device; review and retry');
  }
  const next: Settings = { ...DEFAULT_SETTINGS, ...current, revision: current.revision + 1 };
  const referenceKeys = Object.keys(SETTINGS_REFERENCE_TABLES) as SettingsReferenceKey[];
  const ids = Object.fromEntries(
    referenceKeys.map((key) => [key, optionalNullableId(b, key)]),
  ) as Record<SettingsReferenceKey, number | null | undefined>;
  for (const key of referenceKeys) {
    requireReference(SETTINGS_REFERENCE_TABLES[key], ids[key], key);
    if (ids[key] !== undefined) next[key] = ids[key];
  }
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
    next[key] = value;
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
  if (galleryThumbnailSize !== undefined) next.galleryThumbnailSize = galleryThumbnailSize;
  for (const key of [
    'autoExpandThinking',
    'backgroundSwipeGeneration',
    'parallelBackgroundSwipeGeneration',
  ] as const) {
    const value = optionalBoolean(b, key);
    if (value !== undefined) next[key] = value;
  }
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
  if (accessPassword !== undefined) next.hasPassword = accessPassword !== null;
  if (imageGeneration !== undefined)
    next.imageGeneration = { ...current.imageGeneration, ...imageGeneration };
  if (mediaRendering !== undefined) next.mediaRendering = mediaRendering;
  Object.assign(next, mediaPrompts);
  next.mediaFavorites = parseMediaFavorites(b.mediaFavorites) ?? current.mediaFavorites;
  next.mediaRendering = {
    ...next.mediaRendering,
    workflows: next.mediaRendering.workflows.map((workflow) => {
      const result = { ...workflow };
      for (const field of ['standalonePromptPresetId', 'chatPromptPresetId'] as const) {
        const selected = workflow[field];
        if (selected === null) continue;
        const chat = field === 'chatPromptPresetId';
        const key = mediaPromptSettingsKey(chat);
        const preset = next[key].presets.find((item) => item.id === selected);
        if (preset) continue;
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
  // Remove only favorites whose referenced entity was explicitly deleted in this update.
  next.mediaFavorites = next.mediaFavorites.filter((favorite) => {
    const preset = next.mediaChatPrompts.presets.find((item) => item.id === favorite.presetId);
    const workflow = next.mediaRendering.workflows.find((item) => item.id === favorite.workflowId);
    if (!preset && 'mediaChatPrompts' in mediaPrompts && b.mediaFavorites === undefined)
      return false;
    if (!workflow && mediaRendering !== undefined && b.mediaFavorites === undefined) return false;
    if (!preset || !('chatPrompt' in preset) || !supportsMediaFavorite(workflow)) {
      throw new HttpError(
        400,
        `${favorite.name}: favorites require a chat prompt preset and a configured workflow with a prompt and no media inputs`,
      );
    }
    return true;
  });
  putSettings(next);
  if (accessPassword !== undefined) {
    setAccessPassword(accessPassword as string | null);
    if (accessPassword === null) clearSession(req, headers);
    else startSession(req, headers);
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
