import type { MediaAsset } from '@tinytavern/shared';
import { stmt, transaction } from '../db/db.ts';
import { mediaCharacterNames } from './mediaCharacters.ts';

/** Insert the gallery owner for an existing asset; callers control transactions and publication. */
export function insertGalleryAsset(
  asset: MediaAsset,
  source: {
    prompt: string;
    folderId?: number | null;
    characterName?: string;
    conversationId?: number | null;
    messageId?: number | null;
    image?: string;
  },
): number {
  return transaction(() => {
    const now = Date.now();
    const characterName =
      mediaCharacterNames(asset.id) ||
      (source.characterName ??
        ((source.conversationId == null
          ? null
          : stmt(`SELECT c.name FROM characters c
        JOIN conversations conv ON conv.character_id = c.id WHERE conv.id = ?`).get(source.conversationId)?.name) ||
          ''));
    const id = Number(
      stmt(`INSERT INTO gallery_items (
      character_name, source_conversation_id, source_message_id, source_image,
      prompt, created_at, updated_at, folder_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        characterName,
        source.conversationId ?? null,
        source.messageId ?? null,
        source.image ?? null,
        source.prompt,
        now,
        now,
        source.folderId ?? null,
      ).lastInsertRowid,
    );
    stmt(`INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
    VALUES (?, 'gallery', ?, '0')`).run(asset.id, id);
    return id;
  });
}

export const GALLERY_SELECT = `SELECT g.*,
  asset.id AS asset_id, asset.path, asset.kind, asset.mime, asset.byte_size, asset.width, asset.height,
  asset.duration, asset.thumbnail, asset.thumbnail_revision, asset.recipe_id,
  json_extract(r.configuration_json, '$.workflowId') AS workflow_id,
  json_extract(r.configuration_json, '$.workflowName') AS workflow_name,
  (SELECT json_group_array(json_object('id', id, 'name', name)) FROM (
    SELECT c.id, c.name FROM media_assets a
    JOIN media_characters mc ON mc.asset_id = a.id
    JOIN characters c ON c.id = mc.character_id
    WHERE a.id = asset.id ORDER BY c.name COLLATE NOCASE, c.id
  )) AS characters_json FROM gallery_items g
  JOIN media_owners owner ON owner.owner_type = 'gallery' AND owner.owner_id = g.id
  JOIN media_assets asset ON asset.id = owner.asset_id
  LEFT JOIN media_recipes r ON r.id = asset.recipe_id`;
