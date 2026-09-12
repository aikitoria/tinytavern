import { settingsEpoch, mediaLibraryVersions, mediaLibraryCollections } from '../settings/mediaLibrarySnapshot.ts';
import { stmt, transaction } from '../db/db.ts';
import { importMediaLibraries } from '../settings/mediaEntities.ts';
import { applyMediaSettingsChanges, validateMediaSettingsChanges } from '../settings/mediaSettingsBatch.ts';
import { parseComfyUrl, validateWorkflowSelection } from '../media/mediaSettings.ts';
import { requireMediaWorkflow } from '../media/mediaWorkflows.ts';
import type { MediaLibraryVersions, SettingsPreferences } from '@tinytavern/shared';
import { settingsPreferences, MEDIA_PROMPT_SETTINGS_KEYS, mediaPromptSettingsKey } from '@tinytavern/shared';
import { route, HttpError, type Ctx } from '../http/router.ts';
import {
  getSettings,
  getSettingsPreferences,
  invalidateSettingsCache,
  putSettings,
  SETTINGS_REFERENCE_TABLES,
  type SettingsReferenceKey,
} from '../settings/settingsStore.ts';
import { disconnectAllForAuthChange, invalidate } from '../realtime/events.ts';
import { requireReference } from './shared/entityUtils.ts';
import { objectBody, optionalBoolean, optionalNullableId, optionalNumber, optionalString } from '../http/validation.ts';
import { discardSpeculativeSwipes, prepareSubscribedSwipes } from '../generation/speculation.ts';
import { subscribedConversationIds } from '../realtime/events.ts';
import { bumpAllConversationRevisions } from '../conversations/conversationRevision.ts';
import { broadcastTree } from '../realtime/sync.ts';
import { clearSession, setAccessPassword, startSession, validateNewPassword } from '../http/auth.ts';
import { parseImageGenerationSettings } from '../media/imageSettings.ts';
import {
  parseMediaRendering,
  parseMediaPrompts,
  parseMediaFavorites,
  supportsMediaFavorite,
} from '../media/mediaSettings.ts';

route.get('/api/settings', () => getSettings());
function knownSettingsVersions(req: Request): Partial<MediaLibraryVersions> {
  const query = new URL(req.url!, 'http://localhost').searchParams;
  let known = {};
  if (query.get('epoch') === settingsEpoch) {
    try {
      known = objectBody(JSON.parse(query.get('versions') ?? '{}'));
    } catch {
      throw new HttpError(400, 'Invalid media library versions');
    }
  }
  return known;
}

function settingsSnapshot(known: Partial<MediaLibraryVersions>) {
  const versions = mediaLibraryVersions();
  return {
    epoch: settingsEpoch,
    preferences: getSettingsPreferences(),
    versions,
    collections: mediaLibraryCollections(versions, known),
  };
}
route.get('/api/settings/snapshot', ({ req }) => settingsSnapshot(knownSettingsVersions(req)));

/** Portable library imports are projected once after native IDs and selections have been resolved. */
function importSettingsLibraries(b: Record<string, unknown>): SettingsPreferences {
  const current = getSettings();
  const next = { ...current };
  const rendering = parseMediaRendering(b.mediaRendering);
  if (rendering) next.mediaRendering = rendering;
  for (const key of MEDIA_PROMPT_SETTINGS_KEYS) {
    const prompts = parseMediaPrompts(b[key], key);
    if (prompts) next[key] = prompts;
  }
  const image = b.imageGeneration === undefined ? undefined : objectBody(b.imageGeneration);
  const imageGeneration = parseImageGenerationSettings(
    image === undefined
      ? undefined
      : Object.fromEntries(Object.entries(image).filter(([key]) => key !== 'avatarPromptId')),
  );
  if (imageGeneration) next.imageGeneration = { ...current.imageGeneration, ...imageGeneration };
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
        if (b[key] === undefined)
          throw new HttpError(400, `${workflow.name}: choose a compatible ${chat ? 'chat' : 'gallery'} prompt preset`);
        result[field] = null;
      }
      return result;
    }),
  };
  // Remove only favorites whose referenced entity was explicitly deleted in this update.
  next.mediaFavorites = next.mediaFavorites.filter((favorite) => {
    const preset = next.mediaChatPrompts.presets.find((item) => item.id === favorite.presetId);
    const workflow = next.mediaRendering.workflows.find((item) => item.id === favorite.workflowId);
    if (!preset && b.mediaChatPrompts !== undefined && b.mediaFavorites === undefined) return false;
    if (!workflow && b.mediaRendering !== undefined && b.mediaFavorites === undefined) return false;
    if (!preset || !('chatPrompt' in preset) || !supportsMediaFavorite(workflow)) {
      throw new HttpError(
        400,
        `${favorite.name}: favorites require a chat prompt preset and a configured workflow with a prompt and no media inputs`,
      );
    }
    return true;
  });
  importMediaLibraries(next);
  return getSettingsPreferences(settingsPreferences(next));
}

function updateSettings({ req, headers, body }: Ctx, importing = false) {
  try {
    const known = new URL(req.url!).searchParams.get('snapshot') === '1' ? knownSettingsVersions(req) : null;
    return transaction(() => {
      const b = { ...objectBody(body) };
      const previous = getSettingsPreferences();
      let current = previous;
      const expectedRevision = optionalNumber(b, 'expectedRevision');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
        invalidate('settings');
        throw new HttpError(409, 'global settings changed on another device; review and retry');
      }
      const assigned = b.mediaChanges === undefined ? {} : applyMediaSettingsChanges(b.mediaChanges);
      if (importing) {
        const imported = importSettingsLibraries(b);
        for (const key of ['mediaRendering', 'mediaChatPrompts', 'mediaStandalonePrompts'] as const) {
          if (b[key] !== undefined) b[key] = imported[key];
        }
        if (b.imageGeneration !== undefined) {
          const image = objectBody(b.imageGeneration);
          b.imageGeneration = {
            ...imported.imageGeneration,
            ...(Object.hasOwn(image, 'avatarPromptId') ? { avatarPromptId: image.avatarPromptId } : {}),
          };
        }
        delete b.mediaFavorites;
        current = imported;
      } else if (b.mediaChanges !== undefined) {
        current = getSettingsPreferences();
      }
      const resolve = (table: keyof typeof assigned, value: unknown) =>
        typeof value === 'string' ? (assigned[table]?.[value] ?? value) : value;
      const next: SettingsPreferences = { ...current, revision: previous.revision + 1 };
      const referenceKeys = Object.keys(SETTINGS_REFERENCE_TABLES) as SettingsReferenceKey[];
      const ids = Object.fromEntries(referenceKeys.map((key) => [key, optionalNullableId(b, key)])) as Record<
        SettingsReferenceKey,
        number | null | undefined
      >;
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
        (!Number.isInteger(galleryThumbnailSize) || galleryThumbnailSize < 64 || galleryThumbnailSize > 2048)
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
      const imageBody = b.imageGeneration === undefined ? undefined : objectBody(b.imageGeneration);
      const avatarPromptId = imageBody?.avatarPromptId;
      const imageGeneration = parseImageGenerationSettings(
        imageBody === undefined
          ? undefined
          : Object.fromEntries(Object.entries(imageBody).filter(([key]) => key !== 'avatarPromptId')),
      );
      let mediaRendering: SettingsPreferences['mediaRendering'] | undefined;
      if (b.mediaRendering !== undefined) {
        const rendering = objectBody(b.mediaRendering);
        for (const key of Object.keys(rendering)) {
          if (
            ![
              'comfyUrl',
              'jobTimeoutSeconds',
              'defaultWorkflowId',
              'avatarWorkflowId',
              'descriptionWorkflowId',
            ].includes(key)
          )
            throw new HttpError(400, 'Media libraries must be changed through entity operations');
        }
        mediaRendering = { ...current.mediaRendering };
        if (rendering.comfyUrl !== undefined) mediaRendering.comfyUrl = parseComfyUrl(rendering.comfyUrl);
        if (rendering.jobTimeoutSeconds !== undefined) {
          const timeout = rendering.jobTimeoutSeconds;
          if (!Number.isInteger(timeout) || (timeout !== 0 && (Number(timeout) < 60 || Number(timeout) > 86400)))
            throw new HttpError(400, 'Invalid job timeout');
          mediaRendering.jobTimeoutSeconds = Number(timeout);
        }
        for (const purpose of ['default', 'avatar', 'description'] as const) {
          const key = `${purpose}WorkflowId` as const;
          if (rendering[key] === undefined) continue;
          const id = resolve('media_workflows', rendering[key]);
          if (id !== null && typeof id !== 'string') throw new HttpError(400, 'Invalid workflow ID');
          if (id !== null) validateWorkflowSelection(requireMediaWorkflow(id), purpose);
          mediaRendering[key] = id;
        }
      }
      if ('mediaPrompts' in b) throw new HttpError(400, 'Chat and gallery prompts must be saved separately');
      for (const key of MEDIA_PROMPT_SETTINGS_KEYS) {
        if (b[key] === undefined) continue;
        const value = objectBody(b[key]);
        if (Object.keys(value).some((field) => field !== 'defaultPresetId'))
          throw new HttpError(400, 'Prompt libraries must be changed through entity operations');
        const id = resolve(
          key === 'mediaChatPrompts' ? 'media_chat_prompts' : 'media_standalone_prompts',
          value.defaultPresetId,
        );
        const table = key === 'mediaChatPrompts' ? 'media_chat_prompts' : 'media_standalone_prompts';
        if (
          id !== null &&
          (typeof id !== 'string' || !stmt(`SELECT id FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id))
        )
          throw new HttpError(400, 'Invalid prompt preset');
        next[key] = { ...current[key], defaultPresetId: id as string | null };
      }
      if (imageBody?.promptPresets !== undefined)
        throw new HttpError(400, 'Avatar presets must be changed through entity operations');
      if (avatarPromptId !== undefined) {
        const id = resolve('avatar_prompts', avatarPromptId);
        if (
          id !== null &&
          (typeof id !== 'string' || !stmt('SELECT id FROM avatar_prompts WHERE id = ? AND deleted_at IS NULL').get(id))
        ) {
          throw new HttpError(400, 'Invalid avatar prompt preset');
        }
        next.imageGeneration = { ...next.imageGeneration, avatarPromptId: id as string | null };
      }
      if (accessPassword !== undefined) next.hasPassword = accessPassword !== null;
      if (imageGeneration !== undefined) next.imageGeneration = { ...next.imageGeneration, ...imageGeneration };
      if (mediaRendering !== undefined) next.mediaRendering = mediaRendering;
      if (b.mediaFavorites !== undefined) {
        throw new HttpError(400, 'Favorites must be changed through entity operations');
      }
      putSettings(next);
      validateMediaSettingsChanges(b.mediaChanges, assigned);
      if (accessPassword !== undefined) {
        setAccessPassword(accessPassword as string | null);
        if (accessPassword === null) clearSession(req, headers);
        else startSession(req, headers);
      }
      const generationContextChanged =
        previous.activeEndpointId !== next.activeEndpointId ||
        previous.defaultPresetId !== next.defaultPresetId ||
        previous.defaultTemplateId !== next.defaultTemplateId;
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
      if (known !== null) {
        return { ...settingsSnapshot(known), assigned };
      }
      const settings = getSettings();
      return b.mediaChanges === undefined ? settings : { settings, assigned };
    });
  } catch (error) {
    // A rejected batch may have populated the cache inside its rolled-back transaction.
    invalidateSettingsCache();
    throw error;
  }
}
route.put('/api/settings', (ctx) => updateSettings(ctx));
route.post('/api/settings/import', (ctx) => updateSettings(ctx, true));
