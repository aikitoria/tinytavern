import { stmt, transaction } from '../db/db.ts';

/** Replace ordered attachments without dropping reference pins during a reorder. */
export function setMessageMedia(messageId: number, assetIds: readonly number[], activeImage = 0): void {
  transaction(() => {
    const message = stmt(`SELECT c.character_id FROM messages m
      JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?`).get(messageId);
    if (!message) {
      throw new Error(`Message ${messageId} does not exist`);
    }
    const previous = stmt(`SELECT asset_id, slot FROM media_owners
      WHERE owner_type = 'message' AND owner_id = ?`).all(messageId);
    const previousIds = new Set(previous.map((row) => Number(row.asset_id)));
    const previousSlots = new Map(previous.map((row) => [String(row.slot), Number(row.asset_id)]));
    const changedSlots: number[] = [];
    for (const [index, assetId] of assetIds.entries()) {
      if (previousSlots.get(String(index)) === assetId) {
        continue;
      }
      // Pin incoming slots first: removing a source's final owner releases inactive recipe inputs.
      stmt(`INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
        VALUES (?, 'message', ?, ?)`).run(assetId, messageId, `pending:${index}`);
      changedSlots.push(index);
      if (!previousIds.has(assetId) && message.character_id != null) {
        stmt('INSERT OR IGNORE INTO media_characters(asset_id, character_id) VALUES (?, ?)').run(
          assetId,
          message.character_id,
        );
      }
    }
    for (const row of previous) {
      if (assetIds[Number(row.slot)] !== row.asset_id) {
        stmt("DELETE FROM media_owners WHERE owner_type = 'message' AND owner_id = ? AND slot = ?").run(
          messageId,
          String(row.slot),
        );
      }
    }
    for (const index of changedSlots) {
      stmt("UPDATE media_owners SET slot = ? WHERE owner_type = 'message' AND owner_id = ? AND slot = ?").run(
        String(index),
        messageId,
        `pending:${index}`,
      );
    }
    const selected = Math.max(0, Math.min(activeImage, assetIds.length - 1));
    stmt('UPDATE messages SET active_image = ? WHERE id = ?').run(selected, messageId);
  });
}
