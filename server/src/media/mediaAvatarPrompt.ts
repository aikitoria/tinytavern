import {
  characterChatName,
  DEFAULT_AVATAR_CONTEXT,
  DEFAULT_AVATAR_PROMPT,
  type MediaAvatarContext,
  type StandalonePromptTemplate,
} from '@tinytavern/shared';
import { stmt } from '../db/db.ts';
import { HttpError } from '../http/router.ts';
import { requireObject, positiveId } from '../http/validation.ts';
import { getPersona } from '../generation/prompt.ts';
import { getSettings } from '../settings/settingsStore.ts';

export function parseAvatarContext(value: unknown): MediaAvatarContext | null {
  if (value === null) return null;
  const raw = requireObject(value, 'avatar context');
  if (raw.kind !== 'character' && raw.kind !== 'persona')
    throw new HttpError(400, 'Invalid avatar context');
  const context: MediaAvatarContext = {
    kind: raw.kind,
    id: positiveId(String(raw.id), 'avatar ID'),
  };
  avatarEntity(context);
  return context;
}

function avatarEntity(context: MediaAvatarContext) {
  const table = context.kind === 'character' ? 'characters' : 'personas';
  const entity = stmt(`SELECT * FROM ${table} WHERE id = ?`).get(context.id);
  if (!entity) throw new HttpError(404, 'Avatar entity not found');
  return entity;
}

/** Only context differs: the media worker owns completion policy, streaming and rendering. */
export function avatarPrompt(context: MediaAvatarContext): {
  template: StandalonePromptTemplate;
  values: Record<string, string>;
} {
  const row = avatarEntity(context);
  const settings = getSettings();
  const selection = settings.imageGeneration.promptPresets?.avatar;
  const preset = selection?.active
    ? selection.presets.find((item) => item.name === selection.active)
    : undefined;
  if (selection?.active && !preset?.context?.trim())
    throw new HttpError(400, 'Select an avatar preset with a user message template');
  return {
    template: {
      systemPrompt: preset?.prompt ?? DEFAULT_AVATAR_PROMPT,
      userMessage: preset?.context ?? DEFAULT_AVATAR_CONTEXT,
      reasoningPrefill: '',
      messagePrefill: '',
    },
    values:
      context.kind === 'character'
        ? {
            name: String(row.name),
            char: characterChatName({
              name: String(row.name),
              chatName: row.chat_name as string | null,
            }),
            user: getPersona(settings.defaultPersonaId)?.name ?? 'User',
            description: String(row.personality),
            personality: String(row.personality),
            scenario: String(row.scenario),
            firstmessage: String(row.first_message),
          }
        : {
            name: String(row.name),
            char: '',
            user: String(row.name),
            description: String(row.description),
            personality: '',
            scenario: '',
            firstmessage: '',
          },
  };
}
