import { publicGalleryItem } from '../mediaUrls.ts';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { GalleryItem } from '@minitavern/shared';
import { stmt, toGalleryItem as canonicalGalleryItem, transaction } from '../db.ts';
import { parseImageConfig, renderToBuffer } from '../comfy.ts';
import { invalidate } from '../events.ts';
import { streamChatCompletion } from '../generation.ts';
import { copyImage, deleteImageFiles, saveImage } from '../images.ts';
import { buildImagePromptRevisionMessages } from '../prompt.ts';
import { HttpError, route } from '../router.ts';
import type { Ctx } from '../router.ts';
import {
  finishRenderProgress,
  publishRenderPreview,
  publishRenderProgress,
  renderJobId,
  streamRenderProgress,
} from '../renderProgress.ts';
import { streamResponse } from './streamResponse.ts';
import { objectBody, positiveId, requiredString } from '../validation.ts';

const GALLERY_SELECT = `
  SELECT g.*, c.name AS current_character_name
  FROM gallery_items g
  LEFT JOIN characters c ON c.id = g.character_id`;

type GalleryRow = Record<string, unknown> & {
  image: string;
  image_render_json: string | null;
};

function galleryRow(id: number): GalleryRow | undefined {
  return stmt(`${GALLERY_SELECT} WHERE g.id = ?`).get(id) as GalleryRow | undefined;
}

function requireGalleryItem(id: number): GalleryRow {
  const row = galleryRow(id);
  if (!row) throw new HttpError(404, `gallery item ${id} not found`);
  return row;
}

function galleryItem(id: number): GalleryItem {
  return toGalleryItem(requireGalleryItem(id));
}

function sourceImageIndex(value: unknown, images: string[]): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= images.length) {
    throw new HttpError(400, 'index out of range');
  }
  return value as number;
}

route.get('/api/gallery', () =>
  (stmt(`${GALLERY_SELECT} ORDER BY g.updated_at DESC, g.id DESC`).all() as GalleryRow[]).map(
    toGalleryItem,
  ),
);

/** Own the image copy; source links use ON DELETE SET NULL for navigation only. */
route.post('/api/gallery', ({ body }) => {
  const b = objectBody(body);
  if (!Number.isSafeInteger(b.messageId) || (b.messageId as number) <= 0) {
    throw new HttpError(400, 'messageId must be a positive integer');
  }
  const source = stmt(
    `SELECT m.id, m.conversation_id, m.content, m.images_json, m.active_image,
            m.image_render_json, conv.character_id,
            COALESCE(c.name, 'Assistant') AS character_name
     FROM messages m
     JOIN conversations conv ON conv.id = m.conversation_id
     LEFT JOIN characters c ON c.id = conv.character_id
     WHERE m.id = ?`,
  ).get(b.messageId as number) as
    | {
        id: number;
        conversation_id: number;
        content: string;
        images_json: string;
        active_image: number;
        image_render_json: string | null;
        character_id: number | null;
        character_name: string;
      }
    | undefined;
  if (!source) throw new HttpError(404, `message ${String(b.messageId)} not found`);
  const sourceImages = JSON.parse(source.images_json) as string[];
  const index = sourceImageIndex(b.index ?? source.active_image, sourceImages);
  const sourceImage = sourceImages[index]!;

  const existing = stmt(`${GALLERY_SELECT} WHERE g.source_image = ?`).get(sourceImage) as
    GalleryRow | undefined;
  if (existing) return { item: toGalleryItem(existing), created: false };

  const ext = extname(sourceImage).toLowerCase();
  const copied = copyImage(sourceImage, `gallery-${randomUUID()}${ext}`);
  if (!copied) throw new HttpError(409, 'the source image file no longer exists');
  try {
    const now = Date.now();
    const result = stmt(
      `INSERT INTO gallery_items
         (character_id, character_name, source_conversation_id, source_message_id,
          source_image, prompt, image, image_render_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      source.character_id,
      source.character_name,
      source.conversation_id,
      source.id,
      sourceImage,
      source.content,
      copied,
      source.image_render_json,
      now,
      now,
    );
    const item = galleryItem(Number(result.lastInsertRowid));
    invalidate('gallery');
    return { item, created: true };
  } catch (err) {
    deleteImageFiles([copied]);
    throw err;
  }
});

const activeRenders = new Set<number>();
const activePromptRevisions = new Set<number>();
const PROMPT_REVISION_MAX_TOKENS = 2048;

route.get('/api/gallery/render-progress/:id', (ctx) => streamRenderProgress(ctx));

function deleteGalleryRows(ids: number[]): number {
  const encodedIds = JSON.stringify(ids);
  const rows = stmt(
    `SELECT id, image FROM gallery_items
     WHERE id IN (SELECT value FROM json_each(?))`,
  ).all(encodedIds) as { id: number; image: string }[];
  if (rows.length !== ids.length) throw new HttpError(404, 'one or more gallery items not found');
  transaction(() =>
    stmt(
      `DELETE FROM gallery_items
       WHERE id IN (SELECT value FROM json_each(?))`,
    ).run(encodedIds),
  );
  deleteImageFiles(rows.map((row) => row.image));
  invalidate('gallery');
  return rows.length;
}

route.post('/api/gallery/bulk-delete', ({ body }) => {
  const rawIds = objectBody(body).ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new HttpError(400, 'ids must be a non-empty array');
  }
  if (rawIds.length > 10_000) throw new HttpError(400, 'too many gallery items');
  if (rawIds.some((id) => !Number.isSafeInteger(id) || (id as number) <= 0)) {
    throw new HttpError(400, 'ids must contain positive integers');
  }
  const ids = [...new Set(rawIds as number[])];
  if (ids.some((id) => activeRenders.has(id) || activePromptRevisions.has(id))) {
    throw new HttpError(409, 'generation is still running for a selected item');
  }
  return { deleted: deleteGalleryRows(ids) };
});

async function reviseGalleryPrompt(ctx: Ctx): Promise<void> {
  const id = positiveId(ctx.params.id);
  requireGalleryItem(id);
  const body = objectBody(ctx.body);
  const prompt = requiredString(body, 'prompt');
  const instruction = requiredString(body, 'instruction');
  if (activePromptRevisions.has(id)) {
    throw new HttpError(409, 'a prompt revision is already running for this gallery item');
  }
  activePromptRevisions.add(id);
  try {
    await streamResponse(ctx.res, async (send, signal) => {
      await streamChatCompletion(
        null,
        buildImagePromptRevisionMessages(prompt, instruction),
        PROMPT_REVISION_MAX_TOKENS,
        (d) => send({ d }),
        signal,
      );
    });
  } finally {
    activePromptRevisions.delete(id);
  }
}

route.post('/api/gallery/:id/revise-prompt', reviseGalleryPrompt);

/** Render into a new gallery item, preserving the source item. */
route.post('/api/gallery/:id/render-image', async ({ params, body }) => {
  const id = positiveId(params.id);
  const row = requireGalleryItem(id);
  if (activeRenders.has(id)) throw new HttpError(409, 'an image render is already running');
  const b = objectBody(body);
  let config: { workflow: string; comfyUrl: string };
  try {
    if ('workflow' in b || 'comfyUrl' in b) config = parseImageConfig(b);
    else if (row.image_render_json) config = parseImageConfig(JSON.parse(row.image_render_json));
    else throw new HttpError(400, 'gallery item has no image render configuration');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  const prompt = 'prompt' in b ? requiredString(b, 'prompt') : (row.prompt as string);
  if (!prompt.trim()) throw new HttpError(400, 'gallery item has no prompt to render');
  const jobId = typeof b.jobId === 'string' && b.jobId.trim() ? renderJobId(b.jobId.trim()) : '';

  activeRenders.add(id);
  let saved: string | null = null;
  let committed = false;
  try {
    let result: Awaited<ReturnType<typeof renderToBuffer>>;
    try {
      result = await renderToBuffer({
        comfyUrl: config.comfyUrl,
        workflow: config.workflow,
        prompt,
        onProgress: jobId ? (value, max) => publishRenderProgress(jobId, value, max) : undefined,
        onPreview: jobId ? (preview) => publishRenderPreview(jobId, preview) : undefined,
      });
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : String(err));
    }
    saved = saveImage(
      `gallery-${randomUUID()}-${result.promptId.slice(0, 8)}${result.ext}`,
      result.data,
    );
    const created = transaction(() => {
      const characterId =
        row.character_id != null &&
        stmt('SELECT 1 FROM characters WHERE id = ?').get(row.character_id as number)
          ? (row.character_id as number)
          : null;
      const now = Date.now();
      const inserted = stmt(
        `INSERT INTO gallery_items
           (character_id, character_name, source_conversation_id, source_message_id,
            source_image, prompt, image, image_render_json, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
      ).run(
        characterId,
        (row.current_character_name as string | null) ?? (row.character_name as string),
        prompt,
        saved!,
        JSON.stringify(config),
        now,
        now,
      );
      return galleryItem(Number(inserted.lastInsertRowid));
    });
    committed = true;
    invalidate('gallery');
    return created;
  } finally {
    activeRenders.delete(id);
    if (jobId) finishRenderProgress(jobId);
    if (saved && !committed) deleteImageFiles([saved]);
  }
});

route.del('/api/gallery/:id', ({ params }) => {
  const id = positiveId(params.id);
  requireGalleryItem(id);
  if (activeRenders.has(id) || activePromptRevisions.has(id)) {
    throw new HttpError(409, 'generation is still running for this gallery item');
  }
  deleteGalleryRows([id]);
});

function toGalleryItem(row: Record<string, unknown>): GalleryItem {
  return publicGalleryItem(canonicalGalleryItem(row));
}
