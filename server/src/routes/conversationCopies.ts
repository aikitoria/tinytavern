import type { Conversation, Message } from '@tinytavern/shared';
import { stmt, transaction } from '../db.ts';
import { copyImage, deleteImageFiles } from '../images.ts';

export interface MessageRow {
  gen_meta_json: string | null;
  render_recipe_id: number | null;
}

/** Track files before SQL commit so any partial failure can remove every copy. */
export function copyMessageImages(
  message: Pick<Message, 'media' | 'activeImage'>,
  written: string[],
) {
  const images: string[] = [];
  let activeImage = 0;
  for (const [index, asset] of message.media.entries()) {
    const path = asset.url;
    const copied = copyImage(path);
    if (copied == null) {
      console.warn(`[messages] copy: source image ${path} is missing`);
      continue;
    }
    if (index === message.activeImage) activeImage = images.length;
    written.push(copied);
    images.push(copied);
  }
  return { images, activeImage };
}

export function insertCopiedMessage(
  conversationId: number,
  parentId: number | null,
  row: MessageRow,
  live: Message,
  written: string[],
  generationKind = live.generationKind,
): number {
  const { images, activeImage } = copyMessageImages(live, written);
  return Number(
    stmt(
      `INSERT INTO messages
       (conversation_id, parent_id, role, content, reasoning, status, active_child_id,
        model, gen_meta_json, created_at, name, generation_kind, images_json, active_image,
        image_pending, render_recipe_id)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      conversationId,
      parentId,
      live.role,
      live.content,
      live.reasoning,
      live.status === 'streaming' ? 'stopped' : live.status,
      live.model,
      row.gen_meta_json,
      live.createdAt,
      live.name,
      generationKind,
      JSON.stringify(images),
      activeImage,
      row.render_recipe_id,
    ).lastInsertRowid,
  );
}

export function copyConversation(
  source: Conversation,
  suffix: string,
  copyMessages: (conversationId: number, written: string[]) => void,
): number {
  const title =
    source.title.length + suffix.length > 60
      ? `${source.title.slice(0, 60 - suffix.length - 1)}…${suffix}`
      : `${source.title}${suffix}`;
  const now = Date.now();
  const written: string[] = [];
  try {
    return transaction(() => {
      const id = Number(
        stmt(
          `INSERT INTO conversations
           (title, character_id, persona_id, endpoint_id, speaker_name, scenario_override,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          title,
          source.characterId,
          source.personaId,
          source.endpointId,
          source.speakerName,
          source.scenarioOverride,
          now,
          now,
        ).lastInsertRowid,
      );
      copyMessages(id, written);
      return id;
    });
  } catch (err) {
    // A file cannot roll back with SQL. The orphan sweep covers process crashes.
    deleteImageFiles(written);
    throw err;
  }
}
