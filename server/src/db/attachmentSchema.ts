export const ATTACHMENT_SCHEMA = `
CREATE VIEW message_media_files AS
  SELECT o.owner_id AS message_id, a.path AS image FROM media_owners o
  JOIN media_assets a ON a.id = o.asset_id WHERE o.owner_type = 'message'
  UNION ALL
  SELECT m.id, a.path FROM messages m
  JOIN media_owners o ON o.owner_type = 'recipe' AND o.owner_id = m.render_recipe_id
  JOIN media_assets a ON a.id = o.asset_id;

CREATE TRIGGER media_attachment_insert AFTER INSERT ON media_owners
WHEN new.owner_type IN ('message', 'gallery') BEGIN
  UPDATE media_assets SET reference_deleted = 0 WHERE id = new.asset_id AND reference_deleted = 1;
END;

CREATE TRIGGER media_attachment_delete AFTER DELETE ON media_owners
WHEN old.owner_type IN ('message', 'gallery') BEGIN
  UPDATE media_assets SET reference_deleted = 1 WHERE id = old.asset_id AND reference_deleted = 0
    AND NOT EXISTS (SELECT 1 FROM media_owners WHERE asset_id = old.asset_id
      AND owner_type IN ('message', 'gallery'));
END;
`;
