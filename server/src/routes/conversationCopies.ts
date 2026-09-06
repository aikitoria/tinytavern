import { randomUUID } from 'node:crypto';
import type {
  Conversation,
  GenerationKind,
  Message,
  MessageStatus,
  Role,
} from '@minitavern/shared';
import { stmt, transaction } from '../db.ts';
import { copyImage, deleteImageFiles } from '../images.ts';

export interface MessageRow {
  id: number;
  parent_id: number | null;
  role: Role;
  status: MessageStatus;
  active_child_id: number | null;
  gen_meta_json: string | null;
  created_at: number;
  name: string | null;
  generation_kind: GenerationKind;
  image_render_json: string | null;
}

/** Track files before SQL commit so any partial failure can remove every copy. */
export function copyMessageImages(
  message: Pick<Message, 'images' | 'activeImage'>,
  written: string[],
) {
  const images: string[] = [];
  let activeImage = 0;
  for (const [index, path] of message.images.entries()) {
    const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '.png';
    const copied = copyImage(path, `msg-copy-${randomUUID()}${ext}`);
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
  generationKind = row.generation_kind,
): number {
  const { images, activeImage } = copyMessageImages(live, written);
  return Number(
    stmt(
      `INSERT INTO messages
       (conversation_id, parent_id, role, content, reasoning, status, active_child_id,
        model, gen_meta_json, created_at, name, generation_kind, images_json, active_image,
        image_pending, image_render_json)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      conversationId,
      parentId,
      row.role,
      live.content,
      live.reasoning,
      row.status === 'streaming' ? 'stopped' : row.status,
      live.model,
      row.gen_meta_json,
      row.created_at,
      row.name,
      generationKind,
      JSON.stringify(images),
      activeImage,
      row.image_render_json,
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
