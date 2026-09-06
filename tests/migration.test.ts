// Construct historical schemas in private temporary files before importing db.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = mkdtempSync(join(tmpdir(), 'minitavern-migration-test-'));
const moduleUrl = new URL('../server/src/db.ts', import.meta.url).href;
function migrate(path: string, code = '') {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { db, stmt, transaction } = await import(${JSON.stringify(moduleUrl)});
    ${code}
    db.close();
  `,
    ],
    { env: { ...process.env, DATA_DIR: root, DB_PATH: path }, encoding: 'utf8' },
  );
}
function upgrade(path: string, code = '') {
  const result = migrate(path, code);
  assert.equal(result.status, 0, result.stderr);
}

// Inverse DDL reconstructs each released schema independently of migrate().
// Fixtures are empty while rewinding, then populated with historical data.
const rewind: Record<number, string> = {
  25: 'ALTER TABLE characters DROP COLUMN disable_background_swipe_generation;',
  24: `DROP TABLE gallery_items;
    CREATE TABLE gallery_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
      character_name TEXT NOT NULL,
      source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
      source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      source_image TEXT UNIQUE, prompt TEXT NOT NULL,
      images_json TEXT NOT NULL DEFAULT '[]', active_image INTEGER NOT NULL DEFAULT 0,
      image_render_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_gallery_character ON gallery_items(character_id, updated_at DESC);`,
  23: 'DROP TABLE gallery_items;',
  22: 'ALTER TABLE conversations DROP COLUMN scenario_override;',
  21: `ALTER TABLE templates DROP COLUMN reasoning_prefill;
    ALTER TABLE templates DROP COLUMN message_prefill;`,
  20: 'DROP TABLE auth_sessions;',
  19: 'ALTER TABLE characters DROP COLUMN folder_id; DROP TABLE character_folders;',
  18: `ALTER TABLE conversations DROP COLUMN mutation_revision;
    ALTER TABLE messages DROP COLUMN generation_token;`,
  17: 'ALTER TABLE characters DROP COLUMN examples;',
  16: 'ALTER TABLE templates DROP COLUMN steer_template;',
  15: `ALTER TABLE messages ADD COLUMN image TEXT;
    ALTER TABLE messages DROP COLUMN images_json;
    ALTER TABLE messages DROP COLUMN active_image;
    ALTER TABLE messages DROP COLUMN image_pending;
    ALTER TABLE messages DROP COLUMN image_render_json;`,
  14: 'ALTER TABLE messages DROP COLUMN image;',
  13: 'ALTER TABLE templates DROP COLUMN uses_personas;',
  12: 'ALTER TABLE characters DROP COLUMN custom_template;',
  11: "DELETE FROM characters WHERE name = 'Assistant';",
  10: `DROP TRIGGER messages_fts_insert; DROP TRIGGER messages_fts_update;
    DROP TRIGGER messages_fts_delete; DROP TABLE messages_fts;`,
  9: `ALTER TABLE conversations ADD COLUMN model TEXT;
    ALTER TABLE conversations ADD COLUMN gen_params_json TEXT NOT NULL DEFAULT '{}';`,
  8: 'ALTER TABLE messages DROP COLUMN generation_kind;',
  7: 'ALTER TABLE endpoints DROP COLUMN prefill_mode;',
  6: 'ALTER TABLE endpoints DROP COLUMN model;',
  5: 'ALTER TABLE endpoints DROP COLUMN gen_params_json;',
  4: `ALTER TABLE conversations DROP COLUMN speaker_name;
    ALTER TABLE messages DROP COLUMN name; ALTER TABLE templates DROP COLUMN prefix_names;`,
  3: `ALTER TABLE templates DROP COLUMN user_prologue;
    ALTER TABLE characters DROP COLUMN template_id;`,
  2: 'DROP TABLE templates;',
};

function schema(db: DatabaseSync) {
  const objects = db
    .prepare(
      "SELECT type, name, tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return {
    objects,
    columns: objects
      .filter((row) => row.type === 'table')
      .map((row) => ({
        name: row.name,
        columns: db
          .prepare(`PRAGMA table_info(${row.name})`)
          .all()
          .map(({ cid, ...column }) => column)
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      })),
  };
}

try {
  const freshPath = join(root, 'fresh.db');
  upgrade(freshPath);
  const fresh = new DatabaseSync(freshPath);
  assert.equal(fresh.prepare('PRAGMA user_version').get()!.user_version, 25);
  const expectedSchema = schema(fresh);
  fresh.close();

  for (let version = 1; version <= 25; version++) {
    const path = join(root, `v${version}.db`);
    copyFileSync(freshPath, path);
    const fixture = new DatabaseSync(path);
    for (let undo = 25; undo > version; undo--) fixture.exec(rewind[undo]!);
    fixture.exec(`PRAGMA user_version = ${version};
      INSERT INTO characters (id, name, personality, card_json, created_at)
        VALUES (100, 'Historical character', 'Preserved personality', '{"custom":true}', 11);
      INSERT INTO endpoints (name, base_url, api_key, created_at)
        VALUES ('Historical endpoint', 'http://example.invalid/v1', 'preserved-secret', 12);
      INSERT INTO conversations (id, title, character_id, active_leaf_id, created_at, updated_at)
        VALUES (100, 'Preserved title', 100, 100, 13, 14);
      INSERT INTO messages (id, conversation_id, role, content, created_at)
        VALUES (100, 100, 'assistant', 'searchable historical content', 15);
      UPDATE settings SET value = '{"preserved":true}' WHERE key = 'app';
    `);
    if (version === 14) {
      fixture.exec(`UPDATE messages SET image = '/images/legacy.png' WHERE id = 100;
        INSERT INTO messages (id, conversation_id, role, image, created_at)
          VALUES (101, 100, 'tool', 'pending', 16);`);
    }
    if (version === 23) {
      fixture.exec(`INSERT INTO gallery_items
        (character_id, character_name, source_conversation_id, source_message_id,
         source_image, prompt, images_json, active_image, image_render_json, created_at, updated_at)
        VALUES (100, 'Historical character', 100, 100, '/images/source.png', 'Preserved prompt',
          '["/images/a.png","/images/b.png","/images/c.png"]', 2, '{"workflow":{}}', 20, 30);`);
    }
    fixture.close();
    upgrade(path);
    const upgraded = new DatabaseSync(path);
    assert.deepEqual(schema(upgraded), expectedSchema, `schema upgraded from v${version}`);
    assert.equal(upgraded.prepare('PRAGMA user_version').get()!.user_version, 25);
    assert.equal(upgraded.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(
      upgraded.prepare("SELECT count(*) AS n FROM characters WHERE name = 'Assistant'").get()!.n,
      1,
    );
    assert.equal(
      upgraded.prepare("SELECT count(*) AS n FROM templates WHERE name = 'Default'").get()!.n,
      1,
    );
    assert.equal(
      upgraded.prepare('SELECT content FROM messages WHERE id = 100').get()!.content,
      'searchable historical content',
    );
    assert.equal(
      upgraded
        .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'historical'")
        .get()!.rowid,
      100,
    );
    assert.equal(
      upgraded.prepare('SELECT api_key FROM endpoints').get()!.api_key,
      'preserved-secret',
    );
    assert.equal(
      upgraded.prepare('SELECT personality FROM characters WHERE id = 100').get()!.personality,
      'Preserved personality',
    );
    assert.equal(
      upgraded.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value,
      '{"preserved":true}',
    );
    if (version === 14) {
      assert.equal(
        upgraded.prepare('SELECT images_json FROM messages WHERE id = 100').get()!.images_json,
        '["/images/legacy.png"]',
      );
      assert.equal(
        upgraded.prepare('SELECT images_json FROM messages WHERE id = 101').get()!.images_json,
        '[]',
      );
    }
    if (version === 23) {
      const gallery = upgraded
        .prepare(
          'SELECT image, source_message_id, prompt, updated_at FROM gallery_items ORDER BY id',
        )
        .all();
      assert.deepEqual(
        gallery.map((row) => ({ ...row })),
        [
          {
            image: '/images/a.png',
            source_message_id: 100,
            prompt: 'Preserved prompt',
            updated_at: 30,
          },
          {
            image: '/images/b.png',
            source_message_id: null,
            prompt: 'Preserved prompt',
            updated_at: 31,
          },
          {
            image: '/images/c.png',
            source_message_id: null,
            prompt: 'Preserved prompt',
            updated_at: 32,
          },
        ],
      );
    }
    upgraded.close();
    // Reopening an up-to-date database must not repeat seeds or migrations.
    upgrade(path);
  }

  upgrade(
    freshPath,
    `
    const assert = (await import('node:assert/strict')).default;
    const insert = () => stmt("INSERT INTO settings (key, value) VALUES ('nested', 'retained')").run();
    transaction(() => transaction(insert));
    assert.equal(stmt("SELECT value FROM settings WHERE key = 'nested'").get().value, 'retained');
    stmt("DELETE FROM settings WHERE key = 'nested'").run();
    assert.throws(() => transaction(() => transaction(() => { insert(); throw Error('rollback'); })));
    assert.equal(stmt("SELECT value FROM settings WHERE key = 'nested'").get(), undefined);
    transaction(() => { try { transaction(() => { insert(); throw Error('caught'); }); } catch {} });
    assert.equal(stmt("SELECT value FROM settings WHERE key = 'nested'").get().value, 'retained');
    assert.equal(db.isTransaction, false);
  `,
  );

  // A failed migration rolls back its DDL while retaining earlier committed migrations.
  const failedPath = join(root, 'failed.db');
  copyFileSync(freshPath, failedPath);
  const failed = new DatabaseSync(failedPath);
  failed.exec(
    `DROP TABLE auth_sessions; ALTER TABLE templates DROP COLUMN reasoning_prefill; PRAGMA user_version = 19;`,
  );
  failed.close();
  assert.notEqual(migrate(failedPath).status, 0); // second ADD COLUMN already exists
  const rolledBack = new DatabaseSync(failedPath);
  assert.equal(rolledBack.prepare('PRAGMA user_version').get()!.user_version, 20);
  assert.equal(
    rolledBack
      .prepare('PRAGMA table_info(templates)')
      .all()
      .some((column) => column.name === 'reasoning_prefill'),
    false,
  );
  rolledBack.close();
  console.log(
    'Migration regressions passed: fresh schema, versions 1–25, data conversions, nested transactions and migration rollback.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
