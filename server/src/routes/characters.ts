import { publicAvatar } from '../mediaUrls.ts';
import { defineAvatarRoutes } from './avatarRoutes.ts';
import {
  namedItem,
  DEFAULT_STEER_TEMPLATE,
  DEFAULT_SPEAKER_HANDOFF_TEMPLATE,
  type Character,
  type CustomTemplate,
} from '@tinytavern/shared';
import { stmt, toCharacter } from '../db.ts';
import { invalidate } from '../events.ts';
import { buildCharacterCard, isPng, makePlaceholderPng, parseCharacterCard } from '../pngCard.ts';
import { route, HttpError } from '../router.ts';
import type { Ctx } from '../router.ts';
import {
  optionalBoolean,
  optionalNullableString,
  optionalString,
  positiveId,
} from '../validation.ts';
import type { JsonObject } from '../validation.ts';
import {
  copyAvatarFiles,
  deleteAvatarFiles,
  deleteObsoleteAvatarFiles,
  readAvatarFile,
  saveAvatar,
} from './avatarStore.ts';
import {
  defineEntityRoutes,
  nameField,
  nullableTextField,
  refIdField,
  textField,
} from './entityRoutes.ts';
import { rowById } from './entityUtils.ts';

function parseCustomTemplate(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'customTemplate must be an object or null');
  }
  const t = raw as JsonObject;
  const custom: CustomTemplate = {
    content: optionalString(t, 'content') ?? '',
    userPrologue: optionalString(t, 'userPrologue') ?? '',
    reasoningPrefill: optionalString(t, 'reasoningPrefill') ?? '',
    messagePrefill: optionalString(t, 'messagePrefill') ?? '',
    prefixNames: optionalBoolean(t, 'prefixNames') ?? false,
    usesPersonas: optionalBoolean(t, 'usesPersonas') ?? true,
    steerTemplate: optionalString(t, 'steerTemplate') ?? DEFAULT_STEER_TEMPLATE,
    speakerHandoffTemplate:
      optionalString(t, 'speakerHandoffTemplate') ?? DEFAULT_SPEAKER_HANDOFF_TEMPLATE,
  };
  return JSON.stringify(custom);
}

defineEntityRoutes<Character>({
  table: 'characters',
  toDto: toCharacter,
  toPublic: publicAvatar,
  fields: [
    nameField((cur) => cur.name),
    {
      column: 'chat_name',
      value: (body, current) => {
        const value = optionalNullableString(body, 'chatName');
        return value === undefined ? (current?.chatName ?? null) : value?.trim() || null;
      },
    },
    refIdField('folderId', 'folder_id', 'character_folders', (cur) => cur.folderId),
    textField('personality', 'personality', (cur) => cur.personality),
    textField('scenario', 'scenario', (cur) => cur.scenario),
    textField('examples', 'examples', (cur) => cur.examples),
    textField('firstMessage', 'first_message', (cur) => cur.firstMessage),
    refIdField('presetId', 'preset_id', 'presets', (cur) => cur.presetId),
    nullableTextField('customPrompt', 'custom_prompt', (cur) => cur.customPrompt),
    refIdField('templateId', 'template_id', 'templates', (cur) => cur.templateId),
    {
      column: 'disable_background_swipe_generation',
      value: (b, cur) =>
        Number(
          optionalBoolean(b, 'disableBackgroundSwipeGeneration') ??
            cur?.disableBackgroundSwipeGeneration ??
            false,
        ),
    },
    {
      column: 'custom_template',
      value: (b, cur) => {
        const raw = b.customTemplate;
        if (raw === undefined)
          return cur?.customTemplate ? JSON.stringify(cur.customTemplate) : null;
        return parseCustomTemplate(raw);
      },
    },
  ],
  invalidateOnDelete: ['conversations'],
  onDelete: (id) => deleteAvatarFiles('character', id),
  onDuplicate: (sourceId, newId) => {
    // Also clears a stale avatar URL when the source's file is missing.
    const avatar = copyAvatarFiles('character', sourceId, newId);
    stmt('UPDATE characters SET avatar = ? WHERE id = ?').run(avatar, newId);
  },
});

defineAvatarRoutes('character', (row) => publicAvatar(toCharacter(row)));

function cardObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

route.post(
  '/api/characters/import-card',
  ({ raw }: Ctx) => {
    if (!raw?.length) throw new HttpError(400, 'PNG body is required');
    let card: ReturnType<typeof parseCharacterCard>;
    try {
      card = parseCharacterCard(raw);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'invalid character card');
    }
    const data = cardObject(cardObject(card.raw).data);
    const extension = cardObject(cardObject(data.extensions).tinytavern);
    const reference = (table: 'presets' | 'templates' | 'character_folders', name: unknown) =>
      namedItem(
        stmt(`SELECT id, name FROM ${table}`)
          .all()
          .map((row) => ({ id: Number(row.id), name: String(row.name) })),
        name,
      )?.id ?? null;
    const customTemplate =
      extension.customTemplate === undefined ? null : parseCustomTemplate(extension.customTemplate);
    const disableBackground =
      optionalBoolean(extension, 'disableBackgroundSwipeGeneration') ?? false;
    const result = stmt(
      `INSERT INTO characters (name, chat_name, personality, scenario, examples, first_message, custom_prompt, card_json, created_at, preset_id, template_id, folder_id, custom_template, disable_background_swipe_generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      card.name,
      card.chatName,
      card.personality,
      card.scenario,
      card.examples,
      card.firstMessage,
      card.systemPrompt,
      JSON.stringify(card.raw),
      Date.now(),
      reference('presets', extension.presetName),
      reference('templates', extension.templateName),
      reference('character_folders', extension.folderName),
      customTemplate,
      Number(disableBackground),
    );
    const id = Number(result.lastInsertRowid);
    let avatar: string;
    try {
      avatar = saveAvatar('character', id, raw);
    } catch (err) {
      stmt('DELETE FROM characters WHERE id = ?').run(id);
      throw err;
    }
    stmt('UPDATE characters SET avatar = ? WHERE id = ?').run(avatar, id);
    deleteObsoleteAvatarFiles('character', id);
    invalidate('characters');
    return publicAvatar(toCharacter(rowById('characters', id)));
  },
  { rawBody: true },
);

route.get('/api/characters/:id/card', ({ params, res }) => {
  const id = positiveId(params.id);
  const row = rowById('characters', id);
  const character = toCharacter(row);
  const original = row.card_json
    ? (JSON.parse(row.card_json as string) as { data?: Record<string, unknown> })
    : null;
  const extensions = cardObject(original?.data?.extensions);
  const ownExtension = cardObject(extensions.tinytavern);
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      ...(original?.data ?? {}),
      name: character.name,
      description: character.personality,
      personality: '',
      scenario: character.scenario,
      mes_example: character.examples,
      first_mes: character.firstMessage,
      // Falling back to the imported blob would resurrect an explicitly cleared prompt.
      system_prompt: character.customPrompt ?? '',
      extensions: {
        ...extensions,
        tinytavern: {
          ...ownExtension,
          chatName: character.chatName,
          presetName:
            character.presetId === null
              ? null
              : (stmt('SELECT name FROM presets WHERE id = ?').get(character.presetId)?.name ??
                null),
          templateName:
            character.templateId === null
              ? null
              : (stmt('SELECT name FROM templates WHERE id = ?').get(character.templateId)?.name ??
                null),
          folderName:
            character.folderId === null
              ? null
              : (stmt('SELECT name FROM character_folders WHERE id = ?').get(character.folderId)
                  ?.name ?? null),
          customTemplate: character.customTemplate,
          disableBackgroundSwipeGeneration: character.disableBackgroundSwipeGeneration,
        },
      },
    },
  };
  let base = readAvatarFile('character', id);
  // Legacy uploads trusted Content-Type; invalid PNGs need the placeholder.
  if (base && !isPng(base)) base = null;
  const png = buildCharacterCard(base ?? makePlaceholderPng(), card);
  res
    .writeHead(200, {
      'content-type': 'image/png',
      'content-disposition': `attachment; filename="${character.name.replace(/[^\w.-]+/g, '_')}.card.png"`,
      'content-length': png.length,
    })
    .end(png);
});
