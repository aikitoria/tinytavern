import type { Character, CustomTemplate } from '@minitavern/shared';
import { stmt, toCharacter } from '../db.ts';
import { invalidate } from '../events.ts';
import { buildCharacterCard, isPng, makePlaceholderPng, parseCharacterCard } from '../pngCard.ts';
import { route, HttpError } from '../router.ts';
import type { Ctx } from '../router.ts';
import { optionalBoolean, optionalString, positiveId } from '../validation.ts';
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

defineEntityRoutes<Character>({
  table: 'characters',
  toDto: toCharacter,
  fields: [
    nameField((cur) => cur.name),
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
          steerTemplate: optionalString(t, 'steerTemplate') ?? '',
        };
        return JSON.stringify(custom);
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

route.put(
  '/api/characters/:id/avatar',
  ({ params, raw }: Ctx) => {
    const id = positiveId(params.id);
    rowById('characters', id);
    if (!raw?.length) throw new HttpError(400, 'image body is required');
    const avatar = saveAvatar('character', id, raw);
    stmt('UPDATE characters SET avatar = ? WHERE id = ?').run(avatar, id);
    deleteObsoleteAvatarFiles('character', id);
    invalidate('characters');
    return toCharacter(rowById('characters', id));
  },
  { rawBody: true },
);

route.del('/api/characters/:id/avatar', ({ params }: Ctx) => {
  const id = positiveId(params.id);
  rowById('characters', id);
  deleteAvatarFiles('character', id);
  stmt('UPDATE characters SET avatar = NULL WHERE id = ?').run(id);
  invalidate('characters');
  return toCharacter(rowById('characters', id));
});

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
    const result = stmt(
      `INSERT INTO characters (name, personality, scenario, examples, first_message, custom_prompt, card_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      card.name,
      card.personality,
      card.scenario,
      card.examples,
      card.firstMessage,
      card.systemPrompt,
      JSON.stringify(card.raw),
      Date.now(),
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
    return toCharacter(rowById('characters', id));
  },
  { rawBody: true },
);

/** Export a character as a SillyTavern-compatible V2 PNG card. */
route.get('/api/characters/:id/card', ({ params, res }) => {
  const id = positiveId(params.id);
  const row = rowById('characters', id);
  const character = toCharacter(row);
  const original = row.card_json
    ? (JSON.parse(row.card_json as string) as { data?: Record<string, unknown> })
    : null;
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
      // The normalized current state is authoritative. Falling back to the
      // imported blob would resurrect a system prompt the user explicitly cleared.
      system_prompt: character.customPrompt ?? '',
    },
  };
  let base = readAvatarFile('character', id);
  // Legacy uploads trusted the content-type header, so an old .png file may
  // not actually be one — export with the placeholder instead of a 500.
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
