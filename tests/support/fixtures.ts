import type { SQLQueryBindings } from 'bun:sqlite';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { stmt, mediaAssetForPath, messageMedia } = await import('../../server/src/db/db.ts');

/** Insert fixture rows directly, independently of the operation being tested. */
export function insertFixture(table: string, values: Record<string, SQLQueryBindings>): number {
  if (table === 'gallery_items' && typeof values.image === 'string') {
    const { image, ...fields } = values;
    const id = insertFixture(table, fields);
    const assetId = assetFixture(image);
    stmt("INSERT INTO media_owners(asset_id, owner_type, owner_id, slot) VALUES (?, 'gallery', ?, '0')").run(
      assetId,
      id,
    );
    return id;
  }
  const columns = Object.keys(values);
  return Number(
    stmt(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    ).run(...Object.values(values)).lastInsertRowid,
  );
}

export const conversationFixture = (values: Record<string, SQLQueryBindings> = {}) =>
  insertFixture('conversations', { title: 'Test', created_at: 1, updated_at: 1, ...values });

export function messageFixture(
  conversationId: number,
  values: Record<string, SQLQueryBindings | readonly string[]> = {},
): number {
  const { images = [], ...fields } = values;
  const id = insertFixture('messages', {
    conversation_id: conversationId,
    role: 'assistant',
    created_at: 1,
    ...(fields as Record<string, SQLQueryBindings>),
  });
  attachImages(id, images as readonly string[], Number(values.active_image ?? 0));
  return id;
}

function assetFixture(path: string): number {
  const existing = mediaAssetForPath(path);
  if (existing) return existing.id;
  return insertFixture('media_assets', { path, created_at: 1 });
}

const { setMessageMedia } = await import('../../server/src/media/messageMedia.ts');
export function attachImages(id: number, paths: readonly string[], active = 0): void {
  setMessageMedia(id, paths.map(assetFixture), active);
}
export function messageImages(id: number): string[] {
  return messageMedia(id).map((asset) => asset.url);
}
export function galleryFixture(path: string, fields: Record<string, SQLQueryBindings> = {}): number {
  return insertFixture('gallery_items', {
    character_name: 'Test',
    prompt: '',
    created_at: 1,
    updated_at: 1,
    image: path,
    ...fields,
  });
}
