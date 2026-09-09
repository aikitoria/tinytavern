# Database schema and future migrations

Version 67 is the minimum supported database schema; older schemas are rejected at startup. Versions 66–67 added the reviewed indexes and trigger corrections; subtree deletion is handled explicitly by the application. `server/src/schema.ts` contains the complete current schema; a new database creates it and the current seeds in one transaction. Existing version-67 databases skip initialization and retain their settings, rows and file paths. New settings start at revision zero.

`server/src/db.ts` retains the `migrate(target, apply)` entry point. There are no pending migrations. The next migration is 68. Keep the baseline number at 67; do not reset existing databases to zero. Pre-baseline databases and older backups need an upgrade-capable build before they can use this baseline; changing `user_version` alone does not upgrade their schema. Historical upgrade code is intentionally absent from the current source. A database from a newer build must use that build or a newer compatible one.

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
