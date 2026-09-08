import { stmt } from './db.ts';
import type { MediaJobConfiguration, MediaJobRow } from './mediaJobStore.ts';

export function mediaCharacterIds(assetId: number): number[] {
  return stmt('SELECT character_id FROM media_characters WHERE asset_id = ? ORDER BY character_id')
    .all(assetId)
    .map((row) => Number(row.character_id));
}

/** Associations belong to the asset, independently of its gallery or chat location. */
export function setMediaCharacters(assetId: number, characterIds: readonly number[]): void {
  stmt('DELETE FROM media_characters WHERE asset_id = ?').run(assetId);
  for (const characterId of characterIds) {
    stmt(`INSERT OR IGNORE INTO media_characters(asset_id, character_id)
      SELECT ?, id FROM characters WHERE id = ?`).run(assetId, characterId);
  }
}

/** Capture the union before rendering, so deleting a reference cannot change the result. */
export function captureMediaCharacters(
  job: MediaJobRow,
  configuration: MediaJobConfiguration,
): number[] {
  const ids = new Set(configuration.sourceCharacterIds);
  const rows = stmt(`SELECT mc.character_id FROM json_each(?) input
    JOIN media_characters mc ON mc.asset_id = json_extract(input.value, '$.assetId')
    UNION SELECT character_id FROM conversations WHERE id = ? AND character_id IS NOT NULL`).all(
    job.inputs_json,
    job.context_conversation_id,
  );
  for (const row of rows) ids.add(Number(row.character_id));
  return [...ids].sort((a, b) => a - b);
}

export function mediaCharacters(assetId: number): { id: number; name: string }[] {
  return stmt(`SELECT c.id, c.name FROM media_characters mc JOIN characters c ON c.id = mc.character_id
    WHERE mc.asset_id = ? ORDER BY c.name COLLATE NOCASE, c.id`)
    .all(assetId)
    .map((row) => ({ id: Number(row.id), name: String(row.name) }));
}

export function mediaCharacterNames(assetId: number): string {
  return mediaCharacters(assetId)
    .map((character) => character.name)
    .join(', ');
}
