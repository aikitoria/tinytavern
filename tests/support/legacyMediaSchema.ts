import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Database } from 'bun:sqlite';

/** Downgrade an empty media library in a disposable fixture to its actual version-84 layout. */
export function restoreLegacyMediaSchema(database: Database): void {
  restoreLegacyAttachments(database);
  assert.deepEqual(database.query('SELECT count(*) AS n FROM media_jobs').get(), { n: 0 });
  const triggers = database
    .query<{ name: string; sql: string }, []>("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
    .all();
  const indexes = database
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media_jobs' AND sql IS NOT NULL",
    )
    .all();
  for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name}"`);
  database.exec('DROP TABLE media_jobs');
  database.exec(readFileSync(new URL('../fixtures/media-jobs-84.sql', import.meta.url), 'utf8'));
  for (const index of indexes) {
    if (!/CREATE INDEX media_jobs_(workflow|chat_prompt|standalone_prompt) /.test(index.sql)) database.exec(index.sql);
  }
  database.exec('DROP INDEX media_recipes_workflow');
  database.exec('ALTER TABLE media_recipes DROP COLUMN workflow_id');
  for (const table of [
    'media_selections',
    'media_favorites',
    'media_shortcuts',
    'media_workflows',
    'media_chat_prompts',
    'media_standalone_prompts',
    'avatar_prompts',
    'media_workflow_folders',
    'media_chat_prompts_folders',
    'media_standalone_prompts_folders',
    'avatar_prompts_folders',
  ])
    database.exec(`DROP TABLE ${table}`);
  for (const trigger of triggers) database.exec(trigger.sql);
  database.exec('PRAGMA user_version = 84');
}

/** Restore the actual path-backed schema before exercising the 85-to-86 upgrade. */
export function restoreLegacyAttachments(database: Database): void {
  restoreVersion86Schema(database);
  database.exec(`DROP TRIGGER media_attachment_insert;
    DROP TRIGGER media_attachment_delete;
    DROP VIEW message_media_files;
    ALTER TABLE messages ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE gallery_items ADD COLUMN image TEXT;
    ALTER TABLE gallery_items ADD COLUMN image_width INTEGER;
    ALTER TABLE gallery_items ADD COLUMN image_height INTEGER;
    UPDATE messages SET images_json = (
      SELECT json_group_array(path) FROM (
        SELECT a.path FROM media_owners o JOIN media_assets a ON a.id = o.asset_id
        WHERE o.owner_type = 'message' AND o.owner_id = messages.id ORDER BY CAST(o.slot AS INTEGER)
      )
    );
    UPDATE gallery_items SET (image, image_width, image_height) = (
      SELECT a.path, a.width, a.height FROM media_owners o JOIN media_assets a ON a.id = o.asset_id
      WHERE o.owner_type = 'gallery' AND o.owner_id = gallery_items.id
    );
    CREATE INDEX idx_gallery_image ON gallery_items(image);
    PRAGMA user_version = 85;`);
  database.exec(readFileSync(new URL('../fixtures/attachments-85.sql', import.meta.url), 'utf8'));
}

export function restoreVersion86Schema(database: Database): void {
  const versionTriggers = database
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_library_%'")
    .all();
  for (const trigger of versionTriggers) database.exec(`DROP TRIGGER "${trigger.name}"`);
  database.exec('DROP TABLE media_library_versions');
  database.exec('PRAGMA user_version = 86');
}
