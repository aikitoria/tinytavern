import type { Settings } from '@minitavern/shared';
import { DEFAULT_SETTINGS } from '@minitavern/shared';
import { route, HttpError } from '../router.ts';
import { getSettings, putSettings } from '../settingsStore.ts';
import { disconnectAllForAuthChange, invalidate } from '../events.ts';
import { requireReference, type EntityTable } from './entityUtils.ts';
import { objectBody, optionalBoolean, optionalNullableId, optionalNumber } from '../validation.ts';
import { discardSpeculativeSwipes } from '../speculation.ts';
import { subscribedConversationIds } from '../events.ts';
import { prepareActiveSwipe } from './conversations.ts';
import { bumpAllConversationRevisions } from '../conversationRevision.ts';
import { broadcastTree } from '../sync.ts';
import { clearSession, setAccessPassword, startSession, validateNewPassword } from '../auth.ts';

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
  const pluginSettings = b.pluginSettings as Settings['pluginSettings'] | undefined;
  if (pluginSettings !== undefined) {
    const isPlainObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!isPlainObject(pluginSettings) || !Object.values(pluginSettings).every(isPlainObject)) {
      throw new HttpError(400, 'pluginSettings must be an object of per-plugin objects');
    }
  }
  const next: Settings = {
    ...DEFAULT_SETTINGS,
    ...current,
    ...Object.fromEntries(Object.entries(ids).filter(([, value]) => value !== undefined)),
    ...(autoExpandThinking === undefined ? {} : { autoExpandThinking }),
    ...(backgroundSwipeGeneration === undefined ? {} : { backgroundSwipeGeneration }),
    ...(parallelBackgroundSwipeGeneration === undefined
      ? {}
      : { parallelBackgroundSwipeGeneration }),
    ...(accessPassword === undefined ? {} : { hasPassword: accessPassword !== null }),
    ...(pluginSettings === undefined ? {} : { pluginSettings }),
    revision: current.revision + 1,
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
    for (const conversationId of subscribedConversationIds()) prepareActiveSwipe(conversationId);
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
