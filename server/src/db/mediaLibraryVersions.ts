import { MEDIA_SETTINGS_TABLES } from '@tinytavern/shared';

/** Transactional versions include cascaded reference repairs and roll back with rejected batches. */
export const MEDIA_LIBRARY_VERSION_SCHEMA = `
CREATE TABLE media_library_versions (
  table_name TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0
);
${MEDIA_SETTINGS_TABLES.map(
  (table) => `
INSERT INTO media_library_versions(table_name) VALUES ('${table}');
${['INSERT', 'UPDATE', 'DELETE']
  .map(
    (operation) => `
CREATE TRIGGER ${table}_library_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
  UPDATE media_library_versions SET revision = revision + 1 WHERE table_name = '${table}';
END;`,
  )
  .join('\n')}`,
).join('\n')}
`;
