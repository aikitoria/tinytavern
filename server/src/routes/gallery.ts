import {
  mediaCharacterIds,
  mediaCharacterNames,
  setMediaCharacters,
} from '../media/mediaCharacters.ts';
import { publicGalleryItem } from '../media/mediaUrls.ts';
import { insertGalleryAsset } from '../media/galleryStore.ts';
import type { GalleryItem } from '@tinytavern/shared';
import {
  mediaAssetForPath,
  stmt,
  toGalleryItem as canonicalGalleryItem,
  transaction,
} from '../db/db.ts';
import { invalidate, observeInvalidation } from '../realtime/events.ts';
import { copyImage, deleteImageFiles, rasterImageFormat, saveImage } from '../media/images.ts';
import { imageDimensions } from '../media/imageDimensions.ts';
import { HttpError, route } from '../http/router.ts';
import { objectBody, optionalNullableId, optionalString, positiveId } from '../http/validation.ts';
import { requireReference } from './shared/entityUtils.ts';
import { describeImage, descriptionWorkflow } from '../media/mediaDescription.ts';
import { streamResponse } from '../http/streamResponse.ts';

observeInvalidation((entity) => {
  if (entity === 'characters') invalidate('gallery');
});

const GALLERY_SELECT = `SELECT g.*,
  (SELECT json_group_array(json_object('id', id, 'name', name)) FROM (
    SELECT c.id, c.name FROM media_assets a
    JOIN media_characters mc ON mc.asset_id = a.id
    JOIN characters c ON c.id = mc.character_id
    WHERE a.path = g.image ORDER BY c.name COLLATE NOCASE, c.id
  )) AS characters_json FROM gallery_items g`;

type GalleryRow = Record<string, unknown> & {
  image: string;
  folder_id: number | null;
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

// One original per request avoids base64 copies and bounds concurrent upload memory.
route.post(
  '/api/gallery/upload',
  ({ req, raw }) => {
    if (!raw?.length) throw new HttpError(400, 'image file is empty');
    const format = rasterImageFormat(raw);
    const size = format && imageDimensions(raw);
    if (!format || !size) throw new HttpError(400, 'Upload a valid PNG, JPEG, or WebP image');
    const query = new URL(req.url!, 'http://localhost').searchParams;
    const folderId = query.has('folderId') ? positiveId(query.get('folderId')!, 'folderId') : null;
    requireReference('gallery_folders', folderId, 'folderId');
    const characterId = query.has('characterId') ? positiveId(query.get('characterId')!) : null;
    let characterName = query.get('characterName')?.trim() || 'Uploads';
    if (characterId != null) {
      const character = stmt('SELECT name FROM characters WHERE id = ?').get(characterId) as
        { name: string } | undefined;
      if (!character) throw new HttpError(404, 'character not found');
      characterName = character.name;
    } else if (characterName.length > 500) throw new HttpError(400, 'character name is too long');
    const saved = saveImage(format.ext, raw);
    try {
      const asset = mediaAssetForPath(saved)!;
      if (characterId !== null) setMediaCharacters(asset.id, [characterId]);
      const item = galleryItem(insertGalleryAsset(asset, { characterName, prompt: '', folderId }));
      invalidate('gallery');
      return item;
    } catch (err) {
      deleteImageFiles([saved]);
      throw err;
    }
  },
  { rawBody: true, maxBodyBytes: 64 * 1024 * 1024 },
);

/** Own the image copy; source links use ON DELETE SET NULL for navigation only. */
route.post('/api/gallery', ({ body }) => {
  const b = objectBody(body);
  if (!Number.isSafeInteger(b.messageId) || (b.messageId as number) <= 0) {
    throw new HttpError(400, 'messageId must be a positive integer');
  }
  const source = stmt(
    `SELECT m.id, m.conversation_id, m.content, m.images_json, m.active_image,
            conv.character_id,
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

  const copied = copyImage(sourceImage);
  if (!copied) throw new HttpError(409, 'the source image file no longer exists');
  try {
    const item = galleryItem(
      insertGalleryAsset(mediaAssetForPath(copied)!, {
        characterName: source.character_name,
        conversationId: source.conversation_id,
        messageId: source.id,
        image: sourceImage,
        prompt: source.content,
      }),
    );
    invalidate('gallery');
    return { item, created: true };
  } catch (err) {
    deleteImageFiles([copied]);
    throw err;
  }
});

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
  return { deleted: deleteGalleryRows(ids) };
});

const describing = new Set<number>();
route.post('/api/gallery/move', ({ body }) => {
  const data = objectBody(body);
  const folderId = optionalNullableId(data, 'folderId');
  if (folderId === undefined) throw new HttpError(400, 'folderId is required');
  requireReference('gallery_folders', folderId, 'folderId');
  if (!Array.isArray(data.items) || !data.items.length || data.items.length > 10_000)
    throw new HttpError(400, 'Select between 1 and 10000 gallery items');
  const expected = new Map<number, number | null>();
  for (const value of data.items) {
    const item = objectBody(value);
    const id = optionalNullableId(item, 'id');
    const folder = optionalNullableId(item, 'expectedFolderId');
    if (!id || folder === undefined || expected.has(id))
      throw new HttpError(400, 'Each item needs a unique id and expectedFolderId');
    expected.set(id, folder);
  }
  const ids = JSON.stringify([...expected.keys()]);
  transaction(() => {
    const rows = stmt(
      'SELECT id, folder_id FROM gallery_items WHERE id IN (SELECT value FROM json_each(?))',
    ).all(ids);
    if (rows.length !== expected.size)
      throw new HttpError(404, 'One or more gallery items no longer exist');
    if (rows.some((row) => row.folder_id !== expected.get(Number(row.id))))
      throw new HttpError(409, 'An item moved elsewhere. Refresh the gallery and try again.');
    stmt('UPDATE gallery_items SET folder_id = ? WHERE id IN (SELECT value FROM json_each(?))').run(
      folderId,
      ids,
    );
  });
  invalidate('gallery');
  return { moved: expected.size };
});

route.post('/api/gallery/:id/describe', ({ params, body, req }) => {
  const id = positiveId(params.id);
  const item = galleryItem(id);
  if (!item.media || item.media.kind !== 'image')
    throw new HttpError(400, 'Choose an image to describe');
  if (describing.has(id))
    throw new HttpError(409, 'A prompt is already being generated for this image');
  const configuration = descriptionWorkflow(optionalString(objectBody(body), 'workflowId'));
  const assetId = item.media.id;
  describing.add(id);
  return streamResponse(
    req,
    async (send, signal) => {
      const prompt = await describeImage(assetId, configuration, signal, (update) =>
        send({ progress: update }),
      );
      send({ d: prompt });
    },
    () => describing.delete(id),
  );
});

route.patch('/api/gallery/:id', ({ params, body }) => {
  const id = positiveId(params.id);
  const row = requireGalleryItem(id);
  const data = objectBody(body);
  const hasPrompt = Object.hasOwn(data, 'prompt');
  const hasCharacters = Object.hasOwn(data, 'characterIds');
  const hasFolder = Object.hasOwn(data, 'folderId');
  if (!hasPrompt && !hasCharacters && !hasFolder)
    throw new HttpError(400, 'Provide a prompt, characters or folder to update');
  const folderId = hasFolder ? optionalNullableId(data, 'folderId') : row.folder_id;
  if (folderId === undefined) throw new HttpError(400, 'folderId is required');
  if (hasFolder) {
    const expectedFolderId = optionalNullableId(data, 'expectedFolderId');
    if (expectedFolderId === undefined) throw new HttpError(400, 'expectedFolderId is required');
    if (row.folder_id !== expectedFolderId)
      throw new HttpError(409, 'The folder changed elsewhere. Reopen the media to load it.');
    requireReference('gallery_folders', folderId, 'folderId');
  }
  const prompt = hasPrompt ? data.prompt : row.prompt;
  if (typeof prompt !== 'string' || prompt.length > 200_000) {
    throw new HttpError(400, 'Prompt must be text of at most 200000 characters');
  }
  if (hasPrompt) {
    if (typeof data.expectedPrompt !== 'string')
      throw new HttpError(400, 'expectedPrompt is required');
    if (row.prompt !== data.expectedPrompt) {
      throw new HttpError(409, 'The saved prompt changed elsewhere. Reopen the media to load it.');
    }
  }
  const asset = mediaAssetForPath(row.image)!;
  const previousIds = mediaCharacterIds(asset.id);
  let characterIds = previousIds;
  if (hasCharacters) {
    const parseIds = (value: unknown): number[] => {
      if (!Array.isArray(value) || value.some((id) => !Number.isInteger(id) || id <= 0)) {
        throw new HttpError(400, 'Character selections must be arrays of character IDs');
      }
      return [...new Set(value as number[])].sort((a, b) => a - b);
    };
    characterIds = parseIds(data.characterIds);
    if (JSON.stringify(parseIds(data.expectedCharacterIds)) !== JSON.stringify(previousIds)) {
      throw new HttpError(409, 'The characters changed elsewhere. Reopen the media to load them.');
    }
    for (const characterId of characterIds) {
      if (!stmt('SELECT id FROM characters WHERE id = ?').get(characterId)) {
        throw new HttpError(404, 'Character not found');
      }
    }
  }
  const charactersChanged = JSON.stringify(characterIds) !== JSON.stringify(previousIds);
  if (prompt !== row.prompt || charactersChanged || folderId !== row.folder_id) {
    transaction(() => {
      if (charactersChanged) setMediaCharacters(asset.id, characterIds);
      const characterName = charactersChanged
        ? mediaCharacterNames(asset.id) || (asset.recipeId ? 'Media tools' : 'Uploads')
        : String(row.character_name);
      stmt(`UPDATE gallery_items SET prompt = ?, character_name = ?, folder_id = ?,
        updated_at = MAX(updated_at + 1, ?) WHERE id = ?`).run(
        prompt,
        characterName,
        folderId,
        Date.now(),
        id,
      );
    });
    invalidate('gallery');
  }
  return galleryItem(id);
});

route.del('/api/gallery/:id', ({ params }) => {
  const id = positiveId(params.id);
  requireGalleryItem(id);
  deleteGalleryRows([id]);
});

function toGalleryItem(row: Record<string, unknown>): GalleryItem {
  return publicGalleryItem(canonicalGalleryItem(row));
}
