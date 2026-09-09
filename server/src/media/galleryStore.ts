import type { MediaAsset } from '@tinytavern/shared';
import { stmt } from '../db/db.ts';
import { mediaCharacterNames } from './mediaCharacters.ts';

/** Insert the gallery owner for an existing asset; callers control transactions and publication. */
export function insertGalleryAsset(
  asset: MediaAsset,
  source: {
    prompt: string;
    characterName?: string;
    conversationId?: number | null;
    messageId?: number | null;
    image?: string;
  },
): number {
  const now = Date.now();
  const characterName =
    mediaCharacterNames(asset.id) ||
    source.characterName ||
    (source.conversationId == null
      ? null
      : stmt(`SELECT c.name FROM characters c
        JOIN conversations conv ON conv.character_id = c.id WHERE conv.id = ?`).get(
          source.conversationId,
        )?.name) ||
    'Media tools';
  return Number(
    stmt(`INSERT INTO gallery_items (
      character_name, source_conversation_id, source_message_id, source_image,
      prompt, image, image_width, image_height, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      characterName,
      source.conversationId ?? null,
      source.messageId ?? null,
      source.image ?? null,
      source.prompt,
      asset.url,
      asset.width,
      asset.height,
      now,
      now,
    ).lastInsertRowid,
  );
}
