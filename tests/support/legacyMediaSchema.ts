import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Database } from 'bun:sqlite';

/** Downgrade an empty media library in a disposable fixture to its actual version-84 layout. */
export function restoreLegacyMediaSchema(database: Database): void {
  assert.deepEqual(database.query('SELECT count(*) AS n FROM media_jobs').get(), { n: 0 });
  const triggers = database
    .query<{ name: string; sql: string }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger'",
    )
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
    if (!/CREATE INDEX media_jobs_(workflow|chat_prompt|standalone_prompt) /.test(index.sql))
      database.exec(index.sql);
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
