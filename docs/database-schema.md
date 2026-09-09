# Database schema and future migrations

Version 68 is the minimum supported database schema. `server/src/schema.ts` contains the complete current schema. New databases create it and the current seeds in one transaction, with settings revision zero. Existing supported databases retain their settings, rows and file paths; older schemas are rejected at startup.

Media jobs, review drafts and recipes use `INTEGER PRIMARY KEY AUTOINCREMENT`. Each table has its own numeric ID namespace; jobs reference recipes explicitly. Workflow and media-preset identities in settings and captured configurations are decimal IDs. Request correlation uses decimal nonces; only Comfy submission IDs require UUIDs.

`server/src/db.ts` retains the `migrate(target, apply)` entry point, with no registered migrations. The next migration is 69. Keep the baseline at 68 and never reset existing databases to zero. Older databases and backups require an upgrade-capable older build before this baseline can open them; changing `user_version` alone does not upgrade their schema. A database from a newer build must use that build or a newer compatible one.

For a future persistent change:

1. Update the fresh schema in `schema.ts` and increment `SCHEMA_VERSION`. Update the fresh seeds in `db.ts` when needed.
2. Add a numbered `migrate(...)` call at the marked location in `db.ts`. It runs synchronously in a transaction, before caches, startup recovery and workers. Advance the version only after success. Fresh databases already start at the latest version and skip these calls.
3. Convert every persisted representation affected by the change, then update shared contracts, DTO mappers and validators. Use the memoized `stmt()` helper for SQL.
4. Verify the new conversion and current application behavior using isolated data. Dev hot reload can apply a migration immediately, so a correction to an already-applied change needs another version.

Check these storage locations when deciding what needs conversion:

- **Entities and settings:** table columns, protected prompt/template seeds, `settings.value`, character `custom_template`/`card_json`, saved prompt collections, workflow defaults and named references. Preserve customized text and selections; advance the settings revision when changing stored settings.
- **Captured media state:** `media_jobs.configuration_json`, `inputs_json`, `outputs_json`, `context_json` and `endpoint_json`; `media_recipes.configuration_json` and `inputs_json`. Changing the current workflow or preset alone does not update saved jobs and rerun recipes.
- **Attachments and ownership:** `messages.images_json` and `active_image`, `render_recipe_id`, gallery paths and source links, `media_assets`, `media_owners`, `media_characters`, and draft selections. Preserve attachment order, IDs, deletion ownership and deliberately removed character associations. Review triggers and `message_media_files` whenever their source columns change.
- **Files and derivatives:** originals use `media-<assetId>.<ext>`; asset thumbnails use `thumb-<assetId>-<revision>.jpg`; avatar thumbnails use `thumb-<kind>-<id>-<avatarVersion>-<revision>.jpg`. Avatar source URLs contain numeric cache versions. A path change must cover every database reference. Make replacement files durable before committing references, retain old files until commit, and make crash retries and cleanup safe. Comfy files belong to the remote ledger.
- **Other persistent contracts:** FTS indexes/triggers, auth-session records, conversation JSON, PNG character cards, settings transfer documents and shared URLs. Import/export compatibility is independent of the database version.

Ordinary startup recovery is still required: interrupted generations, durable jobs, temporary ownership, missing derivatives and orphan cleanup can recur on the current schema. These are runtime lifecycles, not one-time migrations.

Application queries use `bun:sqlite` synchronously through the same prepared-statement cache.
Bun returns `null` for a missing SQL row and `Uint8Array` for BLOBs; DTO helpers keep
their existing public absence conventions. Journaling and durability settings are
unchanged. The separate backup process uses `VACUUM INTO` on a read-only connection,
then syncs and atomically publishes the complete snapshot without overwriting files.
