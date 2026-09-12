CREATE VIEW message_media_files AS
  SELECT m.id AS message_id, j.value AS image FROM messages m, json_each(m.images_json) j
  UNION ALL
  SELECT m.id, a.path FROM messages m
  JOIN media_owners o ON o.owner_type = 'recipe' AND o.owner_id = m.render_recipe_id
  JOIN media_assets a ON a.id = o.asset_id;

CREATE TRIGGER media_message_insert AFTER INSERT ON messages BEGIN
  INSERT OR IGNORE INTO media_assets(path, created_at)
    SELECT j.value, new.created_at FROM json_each(new.images_json) j
    WHERE NOT EXISTS (SELECT 1 FROM media_assets WHERE path = j.value);
  INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
    SELECT a.id, 'message', new.id, CAST(j.key AS TEXT)
    FROM json_each(new.images_json) j JOIN media_assets a ON a.path = j.value;
  INSERT OR IGNORE INTO media_characters(asset_id, character_id)
    SELECT a.id, c.character_id FROM json_each(new.images_json) j
    JOIN media_assets a ON a.path = j.value
    JOIN conversations c ON c.id = new.conversation_id
    WHERE c.character_id IS NOT NULL;
END;

CREATE TRIGGER media_message_update AFTER UPDATE OF images_json ON messages
WHEN old.images_json IS NOT new.images_json BEGIN
  INSERT OR IGNORE INTO media_assets(path, created_at)
    SELECT j.value, new.created_at FROM json_each(new.images_json) j
    WHERE NOT EXISTS (SELECT 1 FROM media_assets WHERE path = j.value);
  DELETE FROM media_owners
    WHERE owner_type = 'message' AND owner_id = new.id
      AND NOT EXISTS (
        SELECT 1 FROM json_each(new.images_json) j JOIN media_assets a ON a.path = j.value
        WHERE CAST(j.key AS TEXT) = media_owners.slot AND a.id = media_owners.asset_id
      );
  INSERT OR IGNORE INTO media_owners(asset_id, owner_type, owner_id, slot)
    SELECT a.id, 'message', new.id, CAST(j.key AS TEXT)
    FROM json_each(new.images_json) j JOIN media_assets a ON a.path = j.value;
  INSERT OR IGNORE INTO media_characters(asset_id, character_id)
    SELECT a.id, c.character_id FROM json_each(new.images_json) j
    JOIN media_assets a ON a.path = j.value
    JOIN conversations c ON c.id = new.conversation_id
    WHERE c.character_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM json_each(old.images_json) previous WHERE previous.value = j.value);
END;

CREATE TRIGGER media_gallery_insert AFTER INSERT ON gallery_items BEGIN
  DELETE FROM media_owners WHERE owner_type = 'gallery' AND owner_id = new.id;
  INSERT OR IGNORE INTO media_assets(path, width, height, created_at)
    SELECT new.image, new.image_width, new.image_height, new.created_at WHERE new.image IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM media_assets WHERE path = new.image);
  INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
    SELECT id, 'gallery', new.id, '0' FROM media_assets WHERE path = new.image;
END;

CREATE TRIGGER media_gallery_update AFTER UPDATE OF image ON gallery_items
WHEN old.image IS NOT new.image BEGIN
  DELETE FROM media_owners WHERE owner_type = 'gallery' AND owner_id = new.id;
  INSERT OR IGNORE INTO media_assets(path, width, height, created_at)
    SELECT new.image, new.image_width, new.image_height, new.created_at WHERE new.image IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM media_assets WHERE path = new.image);
  INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
    SELECT id, 'gallery', new.id, '0' FROM media_assets WHERE path = new.image;
END;

CREATE TRIGGER media_message_reference_insert AFTER INSERT ON messages BEGIN
  UPDATE media_assets SET reference_deleted = 0 WHERE reference_deleted = 1
    AND path IN (SELECT value FROM json_each(new.images_json));
END;

CREATE TRIGGER media_message_reference_update AFTER UPDATE OF images_json ON messages
WHEN old.images_json IS NOT new.images_json BEGIN
  UPDATE media_assets SET reference_deleted = 0 WHERE reference_deleted = 1
    AND path IN (SELECT value FROM json_each(new.images_json));
  UPDATE media_assets SET reference_deleted = 1 WHERE reference_deleted = 0
    AND path IN (SELECT value FROM json_each(old.images_json))
    AND path NOT IN (SELECT value FROM json_each(new.images_json))
    AND NOT EXISTS (SELECT 1 FROM gallery_items WHERE image = media_assets.path)
    AND NOT EXISTS (SELECT 1 FROM media_owners WHERE asset_id = media_assets.id
      AND owner_type = 'message' AND owner_id != new.id);
END;

CREATE TRIGGER media_message_reference_delete AFTER DELETE ON messages BEGIN
  UPDATE media_assets SET reference_deleted = 1 WHERE reference_deleted = 0
    AND path IN (SELECT value FROM json_each(old.images_json))
    AND NOT EXISTS (SELECT 1 FROM gallery_items WHERE image = media_assets.path)
    AND NOT EXISTS (SELECT 1 FROM media_owners WHERE asset_id = media_assets.id
      AND owner_type = 'message');
END;

CREATE TRIGGER media_gallery_reference_insert AFTER INSERT ON gallery_items BEGIN
  UPDATE media_assets SET reference_deleted = 0 WHERE path = new.image AND reference_deleted = 1;
END;

CREATE TRIGGER media_gallery_reference_update AFTER UPDATE OF image ON gallery_items
WHEN old.image IS NOT new.image BEGIN
  UPDATE media_assets SET reference_deleted = 0 WHERE path = new.image AND reference_deleted = 1;
  UPDATE media_assets SET reference_deleted = 1 WHERE path = old.image AND reference_deleted = 0
    AND NOT EXISTS (SELECT 1 FROM gallery_items WHERE image = old.image)
    AND NOT EXISTS (SELECT 1 FROM media_owners WHERE asset_id = media_assets.id
      AND owner_type = 'message');
END;

CREATE TRIGGER media_gallery_input_delete AFTER DELETE ON gallery_items BEGIN
  UPDATE media_assets SET reference_deleted = 1 WHERE path = old.image AND reference_deleted = 0
    AND NOT EXISTS (SELECT 1 FROM gallery_items WHERE image = old.image)
    AND NOT EXISTS (SELECT 1 FROM media_owners WHERE asset_id = media_assets.id
      AND owner_type = 'message');
END;
