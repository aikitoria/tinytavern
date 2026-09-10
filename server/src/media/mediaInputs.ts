import {
  MAX_MEDIA_INPUTS,
  mediaInputSlots,
  type MediaJobInputSnapshot,
  type MediaWorkflow,
} from '@tinytavern/shared';
import { mediaAssetForPath, stmt } from '../db/db.ts';
import { requireObject, optionalNullableId } from '../http/validation.ts';
import { HttpError } from '../http/router.ts';
import { readAvatarFile } from '../characters/avatarStore.ts';
import { rasterImageFormat, saveImage } from './images.ts';
import { getSettings } from '../settings/settingsStore.ts';
import { setMediaCharacters } from './mediaCharacters.ts';

/** Caller holds the job mutation transaction and cleans copiedPaths if that transaction fails. */
export function fillAutomaticMediaInputs(
  workflow: MediaWorkflow,
  inputs: MediaJobInputSnapshot[],
  raw: unknown,
  conversationId: number | null,
  copiedPaths: string[],
  capture: (value: unknown) => MediaJobInputSnapshot[],
): MediaJobInputSnapshot[] {
  const context = requireObject(raw, 'input context');
  const selected = context.selectedAssetIds ?? [];
  if (
    !Array.isArray(selected) ||
    selected.length > MAX_MEDIA_INPUTS ||
    selected.some((id) => !Number.isSafeInteger(id) || id <= 0)
  )
    throw new HttpError(400, 'Invalid selected input images');
  const conversation =
    conversationId === null
      ? null
      : stmt('SELECT character_id, persona_id FROM conversations WHERE id = ?').get(conversationId);
  let characterId = conversation?.character_id == null ? null : Number(conversation.character_id);
  let personaId =
    conversation?.persona_id == null
      ? getSettings().defaultPersonaId
      : Number(conversation.persona_id);
  const avatar =
    context.avatar === undefined ? null : requireObject(context.avatar, 'avatar context');
  if (avatar) {
    const id = optionalNullableId(avatar, 'id');
    if (id == null || !['character', 'persona'].includes(String(avatar.kind)))
      throw new HttpError(400, 'Invalid avatar context');
    const entity = avatar.kind === 'character' ? 'characters' : 'personas';
    if (!stmt(`SELECT id FROM ${entity} WHERE id = ?`).get(id))
      throw new HttpError(404, 'Avatar entity not found');
    if (avatar.kind === 'character') characterId = id;
    else personaId = id;
  }
  const mode = avatar ? 'avatar' : conversationId === null ? 'standalone' : 'chat';
  const bindings = workflow.inputBindings[mode] ?? {};
  const allowed = new Set(mediaInputSlots(workflow));
  const next = [...inputs];
  const copied = new Map<string, number>();
  for (const [slot, source] of Object.entries(bindings)) {
    if (!allowed.has(slot) || next.some((input) => input.slot === slot)) continue;
    if (source.startsWith('selected:')) {
      const assetId = selected[Number(source.slice(9)) - 1];
      if (assetId !== undefined) next.push(...capture([{ slot, assetId }]));
      continue;
    }
    const kind = source === 'character-avatar' ? 'character' : 'persona';
    const id = kind === 'character' ? characterId : personaId;
    if (id === null) continue;
    const entity = stmt(
      `SELECT avatar FROM ${kind === 'character' ? 'characters' : 'personas'} WHERE id = ?`,
    ).get(id);
    if (!entity?.avatar) continue;
    const identity = `${kind}:${id}`;
    let assetId = copied.get(identity);
    if (assetId === undefined) {
      const data = readAvatarFile(kind, id);
      if (!data) continue;
      const format = rasterImageFormat(data);
      if (!format) throw new HttpError(400, 'The avatar is not a supported image');
      const path = saveImage(format.ext, data);
      copiedPaths.push(path);
      assetId = mediaAssetForPath(path)!.id;
      if (kind === 'character') setMediaCharacters(assetId, [id]);
      copied.set(identity, assetId);
    }
    next.push({ slot, assetId, prompt: '' });
  }
  return next;
}
