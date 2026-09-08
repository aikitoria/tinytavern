// Construct historical schemas in private temporary files before importing db.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  migrateMediaRendering,
  systemNote,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_SETTINGS,
  DEFAULT_AVATAR_CONTEXT,
  DEFAULT_STEER_TEMPLATE,
  DEFAULT_SPEAKER_HANDOFF_TEMPLATE,
  DEFAULT_CHAT_IMAGE_REVISION_TEMPLATE,
  DEFAULT_IMAGE_PROMPT_REVISION,
} from '@tinytavern/shared';
import { DatabaseSync } from 'node:sqlite';
import { IMAGE_DESCRIPTION_WORKFLOW } from './imageDescriptionWorkflow.ts';

const root = mkdtempSync(join(tmpdir(), 'tinytavern-migration-test-'));
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
  61: '',
  60: `DROP TRIGGER media_message_characters; DROP TABLE media_characters;
    ALTER TABLE gallery_items ADD COLUMN character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL;
    CREATE INDEX idx_gallery_character ON gallery_items(character_id, updated_at DESC);`,
  59: 'ALTER TABLE media_recipes DROP COLUMN instruction;',
  58: '', // Merge image editing into reference-only workflows.
  57: '', // Disable the old default media deadline.
  56: '', // Repair missing gallery dimensions from media assets.
  55: 'ALTER TABLE media_assets DROP COLUMN thumbnail_revision;',
  54: `DROP TABLE avatar_thumbnails;
    DROP INDEX media_thumbnail_pending; DROP INDEX media_thumbnail_path;
    ALTER TABLE media_assets DROP COLUMN thumbnail;
    ALTER TABLE media_assets DROP COLUMN thumbnail_size;
    ALTER TABLE media_assets DROP COLUMN thumbnail_retry_at;
    ALTER TABLE media_assets ADD COLUMN poster TEXT;
    ALTER TABLE gallery_items ADD COLUMN thumbnail TEXT;
    ALTER TABLE gallery_items ADD COLUMN thumbnail_size INTEGER;
    ALTER TABLE gallery_items ADD COLUMN thumbnail_retry_at INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX gallery_thumbnail_pending ON gallery_items(thumbnail_retry_at, id) WHERE thumbnail_size IS NULL;
    CREATE INDEX gallery_thumbnail_path ON gallery_items(thumbnail) WHERE thumbnail IS NOT NULL;`,
  53: 'DROP INDEX gallery_thumbnail_pending; DROP INDEX gallery_thumbnail_path; ALTER TABLE gallery_items DROP COLUMN thumbnail; ALTER TABLE gallery_items DROP COLUMN thumbnail_size; ALTER TABLE gallery_items DROP COLUMN thumbnail_retry_at;',
  52: '',
  51: '',
  50: '',
  49: '',
  48: 'DROP TRIGGER media_gallery_input_delete; ALTER TABLE media_assets DROP COLUMN reference_deleted;',
  47: '',
  46: '',
  45: '',
  44: '',
  43: '',
  42: '',
  41: 'ALTER TABLE conversations DROP COLUMN auto_title_pending;',
  40: '',
  39: '',
  38: `ALTER TABLE templates DROP COLUMN speaker_handoff_template;
    UPDATE templates SET steer_template = '' WHERE steer_template = '${DEFAULT_STEER_TEMPLATE.replaceAll("'", "''")}';`,
  37: 'ALTER TABLE presets DROP COLUMN builtin; ALTER TABLE templates DROP COLUMN builtin;',
  36: '', // Materialize the implicit prompt layout as a saved template.
  35: '', // Reset misrouted chat image preset selections; row data only.
  34: 'DROP TRIGGER media_draft_delete; DROP INDEX media_jobs_draft; ALTER TABLE media_jobs DROP COLUMN draft_id; DROP TABLE media_drafts;',
  33: '', // Remove migrated image settings; settings JSON only.
  32: `ALTER TABLE messages ADD COLUMN image_render_json TEXT; ALTER TABLE gallery_items ADD COLUMN image_render_json TEXT;`,
  31: `DROP VIEW message_media_files; DROP TRIGGER media_message_recipe_delete; DROP TRIGGER media_message_recipe_update;
    DROP INDEX messages_render_recipe; ALTER TABLE messages DROP COLUMN render_recipe_id;`,
  30: `DROP TRIGGER media_message_insert; DROP TRIGGER media_message_update;
    DROP TRIGGER media_message_delete; DROP TRIGGER media_gallery_insert;
    DROP TRIGGER media_gallery_update; DROP TRIGGER media_gallery_delete;
    DROP TRIGGER media_job_delete; DROP TRIGGER media_recipe_delete;
    DROP TABLE media_remote_files; DROP TABLE media_jobs; DROP TABLE media_owners;
    DROP TABLE media_assets; DROP TABLE media_recipes;`,
  29: 'ALTER TABLE characters DROP COLUMN chat_name;',
  28: '', // Gallery standalone template; settings JSON only.
  27: '', // Settings JSON changed; no DDL to rewind.
  26: 'ALTER TABLE gallery_items DROP COLUMN image_width; ALTER TABLE gallery_items DROP COLUMN image_height;',
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
  assert.equal(fresh.prepare('PRAGMA user_version').get()!.user_version, 61);
  const expectedSchema = schema(fresh);
  fresh.close();

  const thumbnailPath = join(root, 'thumbnails-v53.db');
  copyFileSync(freshPath, thumbnailPath);
  const thumbnailFixture = new DatabaseSync(thumbnailPath);
  thumbnailFixture.exec(rewind[60]!);
  thumbnailFixture.exec(rewind[59]!);
  thumbnailFixture.exec(rewind[55]!);
  thumbnailFixture.exec(rewind[54]!);
  thumbnailFixture.exec(`PRAGMA user_version = 53;
    INSERT INTO media_assets(path, poster) VALUES ('/images/movie.webm', '/images/movie-poster.jpg');
    INSERT INTO gallery_items(character_name, prompt, image, thumbnail, thumbnail_size, created_at, updated_at)
      VALUES ('Test', '', '/images/movie.webm', '/images/gallery-thumb-existing.jpg', 512, 1, 1);`);
  thumbnailFixture.close();
  upgrade(thumbnailPath);
  const migratedThumbnails = new DatabaseSync(thumbnailPath);
  assert.deepEqual(
    { ...migratedThumbnails.prepare('SELECT thumbnail, thumbnail_size FROM media_assets').get() },
    {
      thumbnail: '/images/gallery-thumb-existing.jpg',
      thumbnail_size: 512,
    },
  );
  assert(
    !migratedThumbnails
      .prepare('PRAGMA table_info(media_assets)')
      .all()
      .some((row) => row.name === 'poster'),
  );
  assert(
    !migratedThumbnails
      .prepare('PRAGMA table_info(gallery_items)')
      .all()
      .some((row) => row.name === 'thumbnail'),
  );
  migratedThumbnails.close();

  const videoGalleryPath = join(root, 'video-gallery-v55.db');
  copyFileSync(freshPath, videoGalleryPath);
  const videoGalleryFixture = new DatabaseSync(videoGalleryPath);
  videoGalleryFixture.exec(rewind[60]!);
  videoGalleryFixture.exec(rewind[59]!);
  videoGalleryFixture.exec(`PRAGMA user_version = 55;
    INSERT INTO media_assets(path, kind, mime, width, height)
      VALUES ('/images/chat-video.webm', 'video', 'video/webm', 1344, 768);
    INSERT INTO gallery_items(character_name, prompt, image, created_at, updated_at)
      VALUES ('Test', '', '/images/chat-video.webm', 1, 1);`);
  videoGalleryFixture.close();
  upgrade(videoGalleryPath);
  const repairedGallery = new DatabaseSync(videoGalleryPath);
  assert.deepEqual(
    { ...repairedGallery.prepare('SELECT image_width, image_height FROM gallery_items').get() },
    { image_width: 1344, image_height: 768 },
    'Existing chat videos regain their gallery aspect ratio',
  );
  repairedGallery.close();

  const timeoutPath = join(root, 'media-timeout-v56.db');
  copyFileSync(freshPath, timeoutPath);
  const timeoutFixture = new DatabaseSync(timeoutPath);
  timeoutFixture.exec(rewind[60]!);
  timeoutFixture.exec(rewind[59]!);
  timeoutFixture.exec(`PRAGMA user_version = 56;
    INSERT OR REPLACE INTO settings(key, value) VALUES ('app', '{"revision":10,"mediaRendering":{"jobTimeoutSeconds":3600}}');
    INSERT INTO media_jobs(id, operation, state, configuration_json, deadline, created_at, updated_at)
      VALUES ('default-limit', 'video', 'rendering', '{"timeoutSeconds":3600}', 123, 1, 1),
             ('custom-limit', 'video', 'rendering', '{"timeoutSeconds":7200}', 456, 1, 1);
    INSERT INTO media_recipes(id, prompt, configuration_json, created_at)
      VALUES ('old-limit', '', '{"timeoutSeconds":3600}', 1);`);
  timeoutFixture.close();
  upgrade(timeoutPath);
  const migratedTimeouts = new DatabaseSync(timeoutPath);
  const timeoutSettings = JSON.parse(
    String(migratedTimeouts.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value),
  );
  assert.equal(timeoutSettings.mediaRendering.jobTimeoutSeconds, 0);
  assert.equal(timeoutSettings.revision, 11);
  assert.deepEqual(
    migratedTimeouts
      .prepare(
        "SELECT id, deadline, json_extract(configuration_json, '$.timeoutSeconds') AS seconds FROM media_jobs ORDER BY id",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 'custom-limit', deadline: 456, seconds: 7200 },
      { id: 'default-limit', deadline: null, seconds: 0 },
    ],
  );
  assert.equal(
    migratedTimeouts
      .prepare(
        "SELECT json_extract(configuration_json, '$.timeoutSeconds') AS seconds FROM media_recipes",
      )
      .get()!.seconds,
    0,
  );
  migratedTimeouts.close();

  const editPath = join(root, 'image-edit-v57.db');
  copyFileSync(freshPath, editPath);
  const editFixture = new DatabaseSync(editPath);
  editFixture.exec(rewind[60]!);
  editFixture.exec(rewind[59]!);
  editFixture.exec('PRAGMA user_version = 57');
  const editWorkflows = [0, 1, 2, 3].map((count) => ({
    id: `edit-${count}`,
    name: `Edit ${count}`,
    operation: count === 0 ? 'image-edit' : 'image-edit-references',
    referenceCount: count,
    galleryPromptPresetId: 'edit-prompt',
    chatPromptPresetId: null,
    json: JSON.stringify({
      text: { inputs: { prompt: '{{prompt}}', note: 'source.png' } },
      source: { class_type: 'LoadImage', inputs: { image: 'samples/source.png [input]' } },
      ...Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `ref${index + 1}`,
          { class_type: 'LoadImage', inputs: { image: `reference${index + 1}.png` } },
        ]),
      ),
    }),
  }));
  editWorkflows[0]!.json = editWorkflows[0]!.json.replace(
    '\"prompt\":\"{{prompt}}\"',
    '\"prompt\":\"{{prompt}}\",\"seed\":{{seed}}',
  );
  const editSettings = {
    revision: 1,
    mediaRendering: {
      workflows: editWorkflows,
      defaults: Object.fromEntries(
        editWorkflows.map((workflow) => [
          `${workflow.operation}:${workflow.referenceCount}`,
          workflow.id,
        ]),
      ),
    },
    galleryImagePrompts: {
      presets: [
        {
          id: 'edit-prompt',
          name: 'Edit',
          operation: 'image-edit',
          userMessage: '{{#if source_prompt}}Original: {{source_prompt}}{{/if}}',
        },
        {
          id: 'refs-prompt',
          name: 'Edit',
          operation: 'image-edit-references',
          userMessage: '{{source_prompt}} / {{reference1_prompt}} / {{reference2_prompt}}',
        },
      ],
      defaults: { 'image-edit': 'edit-prompt', 'image-edit-references': 'refs-prompt' },
    },
  };
  editFixture
    .prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('app', ?)")
    .run(JSON.stringify(editSettings));
  const oldInputs = ['source', 'reference1', 'reference2'].map((slot, index) => ({
    slot,
    assetId: index === 1 ? null : 1,
    prompt: `Saved ${slot} prompt`,
  }));
  const oldConfig = JSON.stringify({
    workflow: editWorkflows[2],
    comfyUrl: 'http://comfy',
    timeoutSeconds: 0,
  });
  editFixture.exec(
    "INSERT INTO media_assets(id, path) VALUES (1, '/images/migrated-reference.png')",
  );
  editFixture
    .prepare(
      "INSERT INTO media_recipes(id, prompt, configuration_json, inputs_json, created_at) VALUES ('edit-recipe', 'Final prompt', ?, ?, 1)",
    )
    .run(oldConfig, JSON.stringify(oldInputs));
  editFixture
    .prepare(
      "INSERT INTO media_jobs(id, operation, state, configuration_json, inputs_json, created_at, updated_at) VALUES ('edit-job', 'image-edit-references', 'queued', ?, ?, 1, 1)",
    )
    .run(oldConfig, JSON.stringify(oldInputs));
  for (const owner of ['job', 'recipe']) {
    for (const input of oldInputs) {
      if (input.assetId !== null) {
        editFixture
          .prepare('INSERT INTO media_owners VALUES (?, ?, ?, ?)')
          .run(input.assetId, owner, `edit-${owner}`, input.slot);
      }
    }
  }
  editFixture.close();
  upgrade(editPath);
  const editedDb = new DatabaseSync(editPath);
  const migratedEdits = JSON.parse(
    String(editedDb.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value),
  );
  assert.deepEqual(
    migratedEdits.mediaRendering.workflows.map((workflow: any) => workflow.referenceCount),
    [1, 2, 3, 3],
  );
  assert(
    migratedEdits.mediaRendering.workflows.every(
      (workflow: any) => workflow.operation === 'image-edit',
    ),
  );
  assert.deepEqual(migratedEdits.mediaRendering.defaults, {
    'image-edit:1': 'edit-0',
    'image-edit:2': 'edit-1',
    'image-edit:3': 'edit-2',
  });
  assert.match(migratedEdits.mediaRendering.workflows[0].json, /"seed":\{\{seed\}\}/);
  const migratedGraph = JSON.parse(migratedEdits.mediaRendering.workflows[2].json);
  assert.equal(migratedGraph.source.inputs.image, 'samples/reference1.png [input]');
  assert.equal(migratedGraph.ref1.inputs.image, 'reference2.png');
  assert.equal(migratedGraph.ref2.inputs.image, 'reference3.png');
  assert.equal(migratedGraph.text.inputs.note, 'source.png', 'Unrelated text is unchanged');
  assert.match(migratedEdits.mediaRendering.workflows[3].json, /reference4\}\}/);
  assert.match(migratedEdits.mediaRendering.workflows[3].name, /requires three-reference workflow/);
  assert.deepEqual(migratedEdits.galleryImagePrompts.defaults, { 'image-edit': 'edit-prompt' });
  assert.deepEqual(
    migratedEdits.galleryImagePrompts.presets.map((preset: any) => preset.name),
    ['Edit', 'Edit (2)'],
  );
  assert.equal(
    migratedEdits.galleryImagePrompts.presets[0].userMessage,
    '{{#if reference1_prompt}}Original: {{reference1_prompt}}{{/if}}',
  );
  assert.equal(
    migratedEdits.galleryImagePrompts.presets[1].userMessage,
    '{{reference1_prompt}} / {{reference2_prompt}} / {{reference3_prompt}}',
  );
  for (const table of ['media_jobs', 'media_recipes']) {
    const record = editedDb.prepare(`SELECT * FROM ${table}`).get()!;
    assert.deepEqual(
      JSON.parse(String(record.inputs_json)),
      oldInputs.map((input, index) => ({
        ...input,
        slot: `reference${index + 1}`,
      })),
    );
    assert.equal(JSON.parse(String(record.configuration_json)).workflow.referenceCount, 3);
  }
  assert.equal(editedDb.prepare('SELECT operation FROM media_jobs').get()!.operation, 'image-edit');
  assert.equal(editedDb.prepare('SELECT state FROM media_jobs').get()!.state, 'queued');
  assert.deepEqual(
    editedDb
      .prepare('SELECT DISTINCT slot FROM media_owners ORDER BY slot')
      .all()
      .map((row) => row.slot),
    ['reference1', 'reference3'],
  );
  assert.equal(editedDb.prepare('PRAGMA foreign_key_check').all().length, 0);
  editedDb.close();

  const instructionPath = join(root, 'recipe-instructions-v58.db');
  copyFileSync(freshPath, instructionPath);
  const instructionFixture = new DatabaseSync(instructionPath);
  instructionFixture.exec(rewind[60]!);
  instructionFixture.exec(rewind[59]!);
  instructionFixture.exec(`PRAGMA user_version = 58;
    INSERT INTO media_recipes(id, prompt, configuration_json, created_at)
      VALUES ('available-job', 'Final prompt', '{}', 1), ('deleted-job', 'Older prompt', '{}', 1);
    INSERT INTO media_jobs(id, operation, instruction, created_at, updated_at)
      VALUES ('available-job', 'image-edit', 'Keep the subject, change the lighting', 1, 1);`);
  instructionFixture.close();
  upgrade(instructionPath);
  const recoveredInstructions = new DatabaseSync(instructionPath);
  assert.deepEqual(
    recoveredInstructions
      .prepare('SELECT instruction FROM media_recipes ORDER BY id')
      .all()
      .map((row) => row.instruction),
    ['Keep the subject, change the lighting', ''],
  );
  recoveredInstructions.close();

  const associationsPath = join(root, 'media-associations-v59.db');
  copyFileSync(freshPath, associationsPath);
  const associationsFixture = new DatabaseSync(associationsPath);
  associationsFixture.exec(rewind[60]!);
  associationsFixture.exec(`PRAGMA user_version = 59;
    INSERT INTO characters(id, name, created_at) VALUES (900, 'Haeun', 1), (901, 'Ashina', 1);
    INSERT INTO gallery_items(character_id, character_name, prompt, image, created_at, updated_at)
      VALUES (900, 'Haeun', '', '/images/shared.png', 1, 1);
    INSERT INTO conversations(id, title, character_id, created_at, updated_at) VALUES (900, 'Chat', 901, 1, 1);
    INSERT INTO messages(conversation_id, role, content, images_json, created_at)
      VALUES (900, 'tool', '', '["/images/shared.png"]', 1);`);
  associationsFixture.close();
  upgrade(associationsPath);
  const associationsDb = new DatabaseSync(associationsPath);
  assert.deepEqual(
    associationsDb
      .prepare('SELECT character_id FROM media_characters ORDER BY character_id')
      .all()
      .map((row) => row.character_id),
    [900, 901],
  );
  assert(
    !associationsDb
      .prepare('PRAGMA table_info(gallery_items)')
      .all()
      .some((row) => row.name === 'character_id'),
  );
  associationsDb.exec('DROP TRIGGER media_message_characters; PRAGMA user_version = 60');
  associationsDb.close();
  upgrade(associationsPath);
  const repairedAssociations = new DatabaseSync(associationsPath);
  assert(
    repairedAssociations
      .prepare("SELECT name FROM sqlite_master WHERE name = 'media_message_characters'")
      .get(),
  );
  repairedAssociations.close();

  for (let version = 1; version <= 61; version++) {
    const path = join(root, `v${version}.db`);
    copyFileSync(freshPath, path);
    const fixture = new DatabaseSync(path);
    for (let undo = 61; undo > version; undo--) fixture.exec(rewind[undo]!);
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
    if (version === 34) {
      fixture.exec(`INSERT INTO media_jobs(id, operation, context_conversation_id, preset_id, created_at, updated_at)
        VALUES ('misrouted-chat-image', 'image', 100, 'gallery-preset', 1, 1);`);
    }
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
    if (version === 25) {
      const header = Buffer.alloc(24);
      Buffer.from('89504e470d0a1a0a', 'hex').copy(header);
      header.write('IHDR', 12);
      header.writeUInt32BE(1600, 16);
      header.writeUInt32BE(900, 20);
      writeFileSync(join(root, 'images', 'dimensions.png'), header);
      fixture.exec(`INSERT INTO gallery_items (character_name, prompt, image, created_at, updated_at)
        VALUES ('Historical character', 'Original prompt', '/images/dimensions.png', 20, 30),
               ('Historical character', 'Missing file prompt', '/images/missing.png', 21, 31);`);
    }
    fixture.close();
    upgrade(path);
    const upgraded = new DatabaseSync(path);
    assert.deepEqual(schema(upgraded), expectedSchema, `schema upgraded from v${version}`);
    assert.equal(upgraded.prepare('PRAGMA user_version').get()!.user_version, 61);
    if (version < 36) {
      const settings = JSON.parse(
        String(upgraded.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value),
      );
      assert.equal(
        settings.defaultTemplateId,
        1,
        'The old implicit layout now selects the existing saved template',
      );
    }
    if (version === 34) {
      const job = upgraded
        .prepare("SELECT preset_id, revision FROM media_jobs WHERE id = 'misrouted-chat-image'")
        .get()!;
      assert.equal(job.preset_id, null);
      assert.equal(job.revision, 1, 'Existing chat drafts no longer select gallery presets');
    }
    assert.equal(upgraded.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.equal(
      upgraded.prepare('SELECT chat_name FROM characters WHERE id = 100').get()!.chat_name,
      null,
      'Existing characters keep their display name as their chat name',
    );
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
    assert.deepEqual(
      JSON.parse(
        String(upgraded.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value),
      ),
      {
        preserved: true,
        ...(version < 30 ? { mediaRendering: migrateMediaRendering({}) } : {}),
        ...(version < 36 ? { defaultTemplateId: 1 } : {}),
        ...(version < 38
          ? {
              titlePrompt: DEFAULT_SETTINGS.titlePrompt,
              draftCompletionPrompt: DEFAULT_SETTINGS.draftCompletionPrompt,
              imageGeneration: DEFAULT_SETTINGS.imageGeneration,
              revision: version < 30 ? 5 : version < 36 ? 4 : version < 37 ? 3 : 2,
            }
          : {}),
        ...(version < 45
          ? {
              galleryImagePrompts: { presets: [], defaults: {} },
              galleryVideoPrompts: { presets: [], defaults: {} },
              chatVideoPrompts: { presets: [], defaults: {} },
              ...(version >= 38 ? { revision: 1 } : {}),
            }
          : {}),
      },
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
    if (version === 25) {
      assert.deepEqual(
        upgraded
          .prepare('SELECT image_width, image_height FROM gallery_items ORDER BY id')
          .all()
          .map((row) => ({ ...row })),
        [
          { image_width: 1600, image_height: 900 },
          { image_width: null, image_height: null },
        ],
      );
    }
    upgraded.close();
    // Reopening an up-to-date database must not repeat seeds or migrations.
    upgrade(path);
  }

  for (const selected of [null, 1]) {
    const path = join(root, `layout-${selected}.db`);
    copyFileSync(freshPath, path);
    const fixture = new DatabaseSync(path);
    fixture.exec(rewind[60]!);
    fixture.exec(rewind[59]!);
    fixture.exec(rewind[55]!);
    fixture.exec(rewind[54]!);
    fixture.exec(rewind[53]!);
    fixture.exec(rewind[48]!);
    fixture.exec(rewind[41]!);
    fixture.exec(rewind[38]!);
    fixture.exec(rewind[37]!);
    fixture.exec(
      "UPDATE templates SET content = ''; UPDATE presets SET content = 'Custom assistant instruction' WHERE id = 1; PRAGMA user_version = 35;",
    );
    fixture
      .prepare("UPDATE settings SET value = ? WHERE key = 'app'")
      .run(JSON.stringify({ defaultTemplateId: selected, revision: 10 }));
    fixture.close();
    upgrade(path);
    const upgraded = new DatabaseSync(path);
    const settings = JSON.parse(
      String(upgraded.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value),
    );
    assert.equal(
      upgraded.prepare('SELECT content FROM templates WHERE id = 1').get()!.content,
      '',
      'Migration never replaces an intentionally empty saved template',
    );
    assert.equal(
      upgraded.prepare('SELECT content FROM presets WHERE id = 1').get()!.content,
      'Custom assistant instruction',
    );
    assert.equal(upgraded.prepare('SELECT builtin FROM presets WHERE id = 1').get()!.builtin, 0);
    assert.equal(
      upgraded.prepare('SELECT count(*) AS count FROM presets WHERE builtin = 1').get()!.count,
      1,
    );

    if (selected === null) {
      assert.notEqual(settings.defaultTemplateId, 1);
      assert.equal(
        upgraded
          .prepare('SELECT content FROM templates WHERE id = ?')
          .get(settings.defaultTemplateId)!.content,
        DEFAULT_PROMPT_TEMPLATE,
        'An implicit layout becomes a visible saved template',
      );
      assert.equal(settings.revision, 14);
    } else {
      assert.equal(settings.defaultTemplateId, 1);
      assert.equal(settings.revision, 13);
    }
    assert.equal(
      upgraded.prepare('SELECT builtin FROM templates WHERE id = 1').get()!.builtin,
      0,
      'Customized default content remains editable',
    );
    assert.equal(
      upgraded.prepare('SELECT count(*) AS count FROM templates WHERE builtin = 1').get()!.count,
      1,
    );
    const count = upgraded.prepare('SELECT count(*) AS count FROM templates').get()!.count;
    upgraded.close();
    upgrade(path);
    const reopened = new DatabaseSync(path);
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM templates').get()!.count, count);
    reopened.close();
  }

  {
    const path = join(root, 'explicit-prompts.db');
    copyFileSync(freshPath, path);
    const fixture = new DatabaseSync(path);
    fixture.exec(rewind[60]!);
    fixture.exec(rewind[59]!);
    fixture.exec(rewind[55]!);
    fixture.exec(rewind[54]!);
    fixture.exec(rewind[53]!);
    fixture.exec(rewind[48]!);
    fixture.exec(rewind[41]!);
    fixture.exec(rewind[38]!);
    fixture.exec(
      "PRAGMA user_version = 37; UPDATE templates SET steer_template = 'Custom {{instruction}}' WHERE id = 1;",
    );
    fixture
      .prepare('UPDATE characters SET custom_template = ? WHERE id = 1')
      .run(JSON.stringify({ content: 'Inline layout', steerTemplate: '  ' }));
    fixture.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run(
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        revision: 10,
        imageGeneration: {
          promptRevisionTemplate: 'Custom revision {{instruction}}',
          promptPresets: {
            avatar: { active: 'Saved', presets: [{ name: 'Saved', prompt: 'Portrait' }] },
          },
        },
      }),
    );
    fixture.close();
    upgrade(path);
    const upgraded = new DatabaseSync(path);
    const template = upgraded.prepare('SELECT * FROM templates WHERE id = 1').get()!;
    assert.equal(template.steer_template, '[System Note]\nCustom {{instruction}}');
    assert.equal(template.speaker_handoff_template, DEFAULT_SPEAKER_HANDOFF_TEMPLATE);
    const inline = JSON.parse(
      String(
        upgraded.prepare('SELECT custom_template FROM characters WHERE id = 1').get()!
          .custom_template,
      ),
    );
    assert.equal(inline.content, 'Inline layout');
    assert.equal(inline.steerTemplate, DEFAULT_STEER_TEMPLATE);
    assert.equal(inline.speakerHandoffTemplate, DEFAULT_SPEAKER_HANDOFF_TEMPLATE);
    const settings = JSON.parse(
      String(upgraded.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value),
    );
    assert.equal(
      settings.imageGeneration.promptRevisionTemplate,
      '[System Note]\nCustom revision {{instruction}}',
    );
    assert.equal(
      settings.imageGeneration.promptRevisionContext,
      DEFAULT_SETTINGS.imageGeneration.promptRevisionContext,
    );
    assert.equal(
      settings.imageGeneration.promptRevisionOriginal,
      DEFAULT_SETTINGS.imageGeneration.promptRevisionOriginal,
    );
    assert.equal(
      settings.imageGeneration.promptPresets.avatar.presets[0].context,
      DEFAULT_AVATAR_CONTEXT,
    );
    assert.equal(settings.titlePrompt, DEFAULT_SETTINGS.titlePrompt);
    assert.equal(settings.draftCompletionPrompt, DEFAULT_SETTINGS.draftCompletionPrompt);
    assert.equal(settings.revision, 12);
    upgraded.close();
  }

  for (const customized of [false, true]) {
    const path = join(root, `draft-prompt-${customized}.db`);
    copyFileSync(freshPath, path);
    const fixture = new DatabaseSync(path);
    fixture.exec(rewind[60]!);
    fixture.exec(rewind[59]!);
    fixture.exec(rewind[55]!);
    fixture.exec(rewind[54]!);
    fixture.exec(rewind[53]!);
    fixture.exec(rewind[48]!);
    const oldPrompt =
      'Complete the unfinished user input below at its exact cursor position.\n' +
      'Return only the missing continuation. Do not repeat any of the existing input. Do not add a speaker name, quotation marks, commentary, or an answer to the input.\n\n' +
      '<unfinished_user_input>\n{{draft}}\n</unfinished_user_input>';
    const prompt = customized ? 'Custom draft prompt {{draft}}' : oldPrompt;
    fixture
      .prepare("UPDATE settings SET value = ? WHERE key = 'app'")
      .run(JSON.stringify({ ...DEFAULT_SETTINGS, draftCompletionPrompt: prompt, revision: 20 }));
    fixture.exec(rewind[41]!);
    fixture.exec('PRAGMA user_version = 38');
    fixture.close();
    upgrade(path);
    const upgraded = new DatabaseSync(path);
    const settings = JSON.parse(
      String(upgraded.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value),
    );
    assert.equal(
      settings.draftCompletionPrompt,
      customized ? systemNote(prompt) : DEFAULT_SETTINGS.draftCompletionPrompt,
    );
    assert.equal(settings.revision, 21);
    upgraded.close();
    upgrade(path);
  }

  for (const customTitle of [false, true]) {
    for (const customDraft of [false, true]) {
      const path = join(root, `assistance-prompts-${customTitle}-${customDraft}.db`);
      copyFileSync(freshPath, path);
      const fixture = new DatabaseSync(path);
      fixture.exec(rewind[60]!);
      fixture.exec(rewind[59]!);
      fixture.exec(rewind[55]!);
      fixture.exec(rewind[54]!);
      fixture.exec(rewind[53]!);
      fixture.exec(rewind[48]!);
      const titlePrompt = customTitle
        ? 'Custom title instruction'
        : 'Summarize this conversation in 3-6 words for a sidebar title. Reply with only the title, no quotes.\n\nUser: {{userMessage}}\n\nAssistant: {{assistantMessage}}';
      const draftCompletionPrompt = customDraft
        ? 'Custom draft {{draft}}'
        : 'Continue the unfinished user message below in the same voice and style.\n' +
          'Return the complete message: first reproduce the existing draft exactly, character for character, then continue directly from its end. ' +
          'Preserve every space, tab, line break, punctuation mark, and Markdown character, including leading and trailing whitespace. Do not correct, reformat, or repeat any part of the draft twice.\n' +
          'Write as the user, not as an assistant answering them. Return only the message itself, without commentary, speaker labels, surrounding quotation marks, or added code fences. Do not include the delimiter tags.\n\n' +
          '<unfinished_user_input>\n{{draft}}\n</unfinished_user_input>';
      fixture
        .prepare("UPDATE settings SET value = ? WHERE key = 'app'")
        .run(
          JSON.stringify({ ...DEFAULT_SETTINGS, titlePrompt, draftCompletionPrompt, revision: 30 }),
        );
      fixture.exec(rewind[41]!);
      fixture.exec('PRAGMA user_version = 39');
      fixture.close();
      upgrade(path);
      const upgraded = new DatabaseSync(path);
      const settings = JSON.parse(
        String(upgraded.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value),
      );
      assert.equal(
        settings.titlePrompt,
        customTitle ? systemNote(titlePrompt) : DEFAULT_SETTINGS.titlePrompt,
      );
      assert.equal(
        settings.draftCompletionPrompt,
        customDraft ? systemNote(draftCompletionPrompt) : DEFAULT_SETTINGS.draftCompletionPrompt,
      );
      assert.equal(settings.revision, customTitle !== customDraft ? 32 : 31);
      upgraded.close();
      upgrade(path);
    }
  }

  {
    const path = join(root, 'contextual-titles.db');
    copyFileSync(freshPath, path);
    const fixture = new DatabaseSync(path);
    fixture.exec(rewind[60]!);
    fixture.exec(rewind[59]!);
    fixture.exec(rewind[55]!);
    fixture.exec(rewind[54]!);
    fixture.exec(rewind[53]!);
    fixture.exec(rewind[48]!);
    fixture.exec(rewind[41]!);
    fixture.exec(`PRAGMA user_version = 40;
      INSERT INTO characters (id, name, first_message, created_at) VALUES (500, 'Greeting character', 'Hello', 1);
      INSERT INTO conversations (id, title, character_id, created_at, updated_at) VALUES
        (500, 'Greeting character', 500, 1, 1), (501, 'My chosen title', 500, 1, 1),
        (502, 'Greeting character', 500, 1, 1);
      INSERT INTO messages (conversation_id, role, content, created_at) VALUES (502, 'user', 'Already started', 1);`);
    fixture.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run(
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        titlePrompt: 'Summarize {{userMessage}} and {{assistantMessage}}',
        revision: 40,
      }),
    );
    fixture.close();
    upgrade(path);
    const upgraded = new DatabaseSync(path);
    assert.deepEqual(
      upgraded
        .prepare('SELECT auto_title_pending FROM conversations WHERE id >= 500 ORDER BY id')
        .all()
        .map((row) => row.auto_title_pending),
      [1, 0, 0],
    );
    const settings = JSON.parse(
      String(upgraded.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value),
    );
    assert.equal(settings.titlePrompt, DEFAULT_SETTINGS.titlePrompt);
    assert.equal(settings.revision, 41);
    upgraded.close();
    upgrade(path);
  }

  {
    const path = join(root, 'removed-video-operation.db');
    copyFileSync(freshPath, path);
    const fixture = new DatabaseSync(path);
    fixture.exec(rewind[60]!);
    fixture.exec(rewind[59]!);
    fixture.exec(rewind[55]!);
    fixture.exec(rewind[54]!);
    fixture.exec(rewind[53]!);
    fixture.exec(rewind[48]!);
    fixture.exec('PRAGMA user_version = 46');
    const retired = { id: 'retired', name: 'Retired', operation: 'video-frames' };
    const retained = { id: 'retained', name: 'Retained', operation: 'video-first' };
    const prompts = {
      presets: [retired, retained],
      defaults: { 'video-frames': retired.id, 'video-first': retained.id },
    };
    fixture.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run(
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        revision: 90,
        chatVideoPrompts: prompts,
        galleryVideoPrompts: prompts,
        mediaRendering: {
          ...DEFAULT_SETTINGS.mediaRendering,
          workflows: [retired, retained],
          defaults: { 'video-frames:0': retired.id, 'video-first:0': retained.id },
        },
      }),
    );
    fixture.exec(`INSERT INTO media_jobs (id, operation, state, prompt, created_at, updated_at)
      VALUES ('unfinished-frames', 'video-frames', 'queued', 'Unfinished video', 1, 1),
             ('finished-frames', 'video-frames', 'succeeded', 'Saved video', 1, 1);`);
    fixture.close();
    upgrade(path);
    const upgraded = new DatabaseSync(path);
    const settings = JSON.parse(
      String(upgraded.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value),
    );
    assert.equal(settings.revision, 91);
    assert.deepEqual(settings.mediaRendering.workflows, [retained]);
    assert.deepEqual(settings.mediaRendering.defaults, {
      'video-first:0': retained.id,
    });
    for (const key of ['chatVideoPrompts', 'galleryVideoPrompts']) {
      assert.deepEqual(settings[key], {
        presets: [retained],
        defaults: { 'video-first': retained.id },
      });
    }
    assert.equal(
      upgraded.prepare("SELECT state FROM media_jobs WHERE id = 'unfinished-frames'").get()!.state,
      'cancelling',
    );
    assert.equal(
      upgraded.prepare("SELECT state FROM media_jobs WHERE id = 'finished-frames'").get()!.state,
      'succeeded',
    );
    assert.equal(
      upgraded.prepare("SELECT prompt FROM media_jobs WHERE id = 'finished-frames'").get()!.prompt,
      'Saved video',
    );
    upgraded.close();
  }

  {
    const path = join(root, 'reference-images.db');
    copyFileSync(freshPath, path);
    const fixture = new DatabaseSync(path);
    fixture.exec(rewind[60]!);
    fixture.exec(rewind[59]!);
    fixture.exec(rewind[55]!);
    fixture.exec(rewind[54]!);
    fixture.exec(rewind[53]!);
    fixture.exec(rewind[48]!);
    fixture.exec('PRAGMA user_version = 41');
    const prompt = {
      id: 'custom-video',
      name: 'Keep this name',
      operation: 'video-references',
      systemPrompt: 'Custom formatting instructions',
      userMessage: '{{references}}\n\n{{instruction}}',
      chatPrompt:
        'Custom steering\n\n<reference_descriptions>\n{{references}}\n</reference_descriptions>\n\n{{instruction}}',
      reasoningPrefill: 'Preserve reasoning',
      messagePrefill: '',
    };
    const workflow = {
      id: 'preserved-workflow',
      name: 'Preserved workflow',
      operation: 'video-references',
      referenceCount: 1,
      json: '{"1":{"inputs":{"text":"{{prompt}}","image":"{{reference1}}"}}}',
      outputNodes: ['1'],
      promptPresetId: prompt.id,
    };
    fixture.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run(
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        mediaPrompts: { presets: [prompt], defaults: { 'video-references': prompt.id } },
        mediaRendering: {
          ...DEFAULT_SETTINGS.mediaRendering,
          workflows: [workflow],
          defaults: { 'video-references:1': workflow.id },
        },
        revision: 50,
      }),
    );
    const inputs = JSON.stringify([
      { slot: 'reference1', assetId: 123, description: 'Unused saved prompt' },
    ]);
    fixture
      .prepare(
        "INSERT INTO media_jobs (id, operation, inputs_json, created_at, updated_at) VALUES ('references', 'video-references', ?, 1, 1)",
      )
      .run(inputs);
    fixture
      .prepare(
        "INSERT INTO media_recipes (id, prompt, configuration_json, inputs_json, created_at) VALUES ('references', 'Keep rendered prompt', '{}', ?, 1)",
      )
      .run(inputs);
    for (const table of ['media_jobs', 'media_recipes']) {
      fixture
        .prepare(`UPDATE ${table} SET configuration_json = ? WHERE id = 'references'`)
        .run(JSON.stringify({ workflow, comfyUrl: 'http://preserved-comfy' }));
    }
    fixture.close();
    upgrade(path);
    const upgraded = new DatabaseSync(path);
    const settings = JSON.parse(
      String(upgraded.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value),
    );
    const { chatPrompt, ...gallery } = prompt;
    assert.deepEqual(settings.galleryVideoPrompts.presets[0], {
      ...gallery,
      userMessage: '{{instruction}}',
    });
    assert.deepEqual(settings.chatVideoPrompts.presets[0], {
      id: prompt.id,
      name: prompt.name,
      operation: prompt.operation,
      chatPrompt: '[System Note]\nCustom steering\n\n{{instruction}}',
    });
    assert(!('mediaPrompts' in settings));
    assert.deepEqual(settings.galleryVideoPrompts.defaults, { 'video-references': prompt.id });
    assert.deepEqual(settings.chatVideoPrompts.defaults, { 'video-references': prompt.id });
    assert.deepEqual(settings.galleryImagePrompts, { presets: [], defaults: {} });
    const { promptPresetId, outputNodes, ...workflowFields } = workflow;
    const splitWorkflow = {
      ...workflowFields,
      galleryPromptPresetId: promptPresetId,
      chatPromptPresetId: promptPresetId,
    };
    assert.deepEqual(settings.mediaRendering.workflows, [splitWorkflow]);
    assert.equal(settings.revision, 54);
    for (const table of ['media_jobs', 'media_recipes']) {
      assert.deepEqual(
        JSON.parse(
          String(
            upgraded
              .prepare(`SELECT configuration_json FROM ${table} WHERE id = 'references'`)
              .get()!.configuration_json,
          ),
        ),
        { workflow: splitWorkflow, comfyUrl: 'http://preserved-comfy' },
      );
      assert.deepEqual(
        JSON.parse(
          String(
            upgraded.prepare(`SELECT inputs_json FROM ${table} WHERE id = 'references'`).get()!
              .inputs_json,
          ),
        ),
        [{ slot: 'reference1', assetId: 123, prompt: '' }],
      );
    }
    upgraded.close();
    upgrade(path);
  }

  {
    const path = join(root, 'single-steering-heading.db');
    copyFileSync(freshPath, path);
    const fixture = new DatabaseSync(path);
    fixture.exec(rewind[60]!);
    fixture.exec(rewind[59]!);
    fixture.exec(rewind[55]!);
    fixture.exec(rewind[54]!);
    fixture.exec(rewind[53]!);
    fixture.exec(rewind[48]!);
    fixture.exec('PRAGMA user_version = 43');
    const preset = {
      id: 'video',
      name: 'Custom video',
      operation: 'video',
      systemPrompt: 'Gallery instructions',
      userMessage: '{{instruction}}',
      reasoningPrefill: '',
      messagePrefill: '',
      chatPrompt: '[System Note]\n[VIDEO PROMPT TASK]\nKeep my formatting.\n  {{instruction}}',
    };
    fixture.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run(
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        revision: 70,
        mediaPrompts: { presets: [preset], defaults: { video: 'video' } },
        imageGeneration: {
          ...DEFAULT_SETTINGS.imageGeneration,
          promptRevisionTemplate:
            '[System Note]\n[IMAGE PROMPT REVISION TASK]\nRevise {{instruction}}',
        },
      }),
    );
    fixture.close();
    upgrade(path);
    const upgraded = new DatabaseSync(path);
    const encoded = String(
      upgraded.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value,
    );
    const settings = JSON.parse(encoded);
    assert.deepEqual(settings.chatVideoPrompts.presets[0], {
      id: preset.id,
      name: preset.name,
      operation: preset.operation,
      chatPrompt: '[System Note]\nKeep my formatting.\n  {{instruction}}',
    });
    assert.equal(settings.galleryVideoPrompts.presets[0].systemPrompt, preset.systemPrompt);
    assert.equal(
      settings.imageGeneration.promptRevisionTemplate,
      '[System Note]\nRevise {{instruction}}',
    );
    assert.equal(settings.revision, 72);
    upgraded.close();
    upgrade(path);
    const reopened = new DatabaseSync(path);
    assert.equal(
      reopened.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value,
      encoded,
    );
    reopened.close();
  }

  const savedImageSettings = {
    comfyUrl: 'http://preserved-comfy:8588',
    workflows: [
      { name: 'Landscape', json: '{"prompt":"{{prompt}}"}' },
      { name: 'Portrait', json: '{"seed":{{seed}}}' },
    ],
    activeWorkflow: 'Landscape',
    avatarWorkflow: 'Portrait',
    promptPresets: {
      describe: {
        presets: [{ name: 'Detailed', prompt: 'Describe {{char}} in detail.' }],
        active: 'Detailed',
      },
      avatar: {
        presets: [{ name: 'Face', prompt: 'Portrait', context: '{{description}}' }],
        active: 'Face',
      },
    },
  };
  const markedImagePresets = {
    ...savedImageSettings.promptPresets,
    describe: {
      ...savedImageSettings.promptPresets.describe,
      presets: savedImageSettings.promptPresets.describe.presets.map((preset) => ({
        ...preset,
        prompt: systemNote(preset.prompt),
      })),
    },
  };
  const legacyImageSettings = {
    describePrompt: 'Keep this exact prompt\n  and indentation',
    instructionPrompt: 'Apply {{instruction}}',
    avatarPrompt: 'Portrait of {{name}}',
    workflowJson: '{"legacy":"{{prompt}}"}',
    comfyUrl: 'http://legacy-comfy:8588',
  };
  for (const [name, imageSettings] of Object.entries({
    presets: savedImageSettings,
    legacy: legacyImageSettings,
  })) {
    const path = join(root, `image-settings-${name}.db`);
    copyFileSync(freshPath, path);
    const fixture = new DatabaseSync(path);
    fixture.exec(rewind[60]!);
    fixture.exec(rewind[59]!);
    fixture.exec(rewind[55]!);
    fixture.exec(rewind[54]!);
    fixture.exec(rewind[53]!);
    fixture.exec(rewind[48]!);
    fixture.exec(rewind[41]!);
    fixture.exec(rewind[38]!);
    fixture.exec(rewind[37]!);
    const previous = {
      revision: 41,
      activeEndpointId: 7,
      defaultTemplateId: 1,
      backgroundSwipeGeneration: true,
      pluginSettings: { imageGeneration: imageSettings },
    };
    fixture
      .prepare("UPDATE settings SET value = ? WHERE key = 'app'")
      .run(JSON.stringify(previous));
    fixture.exec(rewind[34]!);
    fixture.exec(rewind[32]!);
    fixture.exec(rewind[31]!);
    fixture.exec(rewind[30]!);
    fixture.exec('ALTER TABLE characters DROP COLUMN chat_name; PRAGMA user_version = 26');
    fixture.close();
    upgrade(path);
    const upgraded = new DatabaseSync(path);
    const encoded = upgraded.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value;
    assert.deepEqual(JSON.parse(encoded as string), {
      revision: 48,
      galleryImagePrompts: { presets: [], defaults: {} },
      galleryVideoPrompts: { presets: [], defaults: {} },
      chatVideoPrompts: { presets: [], defaults: {} },
      titlePrompt: DEFAULT_SETTINGS.titlePrompt,
      draftCompletionPrompt: DEFAULT_SETTINGS.draftCompletionPrompt,
      mediaRendering: migrateMediaRendering(imageSettings),
      activeEndpointId: 7,
      defaultTemplateId: 1,
      backgroundSwipeGeneration: true,
      imageGeneration:
        name === 'presets'
          ? { ...DEFAULT_SETTINGS.imageGeneration, promptPresets: markedImagePresets }
          : {
              ...DEFAULT_SETTINGS.imageGeneration,
              promptPresets: {
                describe: {
                  presets: [
                    { name: 'Custom', prompt: systemNote(legacyImageSettings.describePrompt) },
                  ],
                  active: 'Custom',
                },
                instruction: {
                  presets: [
                    { name: 'Custom', prompt: systemNote(legacyImageSettings.instructionPrompt) },
                  ],
                  active: 'Custom',
                },
                avatar: {
                  presets: [
                    {
                      name: 'Custom',
                      prompt: legacyImageSettings.avatarPrompt,
                      context: DEFAULT_AVATAR_CONTEXT,
                    },
                  ],
                  active: 'Custom',
                },
              },
            },
    });
    upgraded.close();
    upgrade(path);
    const reopened = new DatabaseSync(path);
    assert.equal(
      reopened.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value,
      encoded,
    );
    reopened.close();
  }

  for (const [name, previousTemplate] of Object.entries({
    default: DEFAULT_CHAT_IMAGE_REVISION_TEMPLATE,
    custom: 'Keep this exact custom text\n  Apply {{instruction}} and preserve $&',
  })) {
    const path = join(root, `gallery-template-${name}.db`);
    copyFileSync(freshPath, path);
    const fixture = new DatabaseSync(path);
    fixture.exec(rewind[60]!);
    fixture.exec(rewind[59]!);
    fixture.exec(rewind[55]!);
    fixture.exec(rewind[54]!);
    fixture.exec(rewind[53]!);
    fixture.exec(rewind[48]!);
    fixture.exec(rewind[41]!);
    fixture.exec(rewind[38]!);
    fixture.exec(rewind[37]!);
    const previous = {
      revision: 52,
      activeEndpointId: 7,
      defaultTemplateId: 1,
      imageGeneration: savedImageSettings,
      gallery: { promptRevisionTemplate: previousTemplate },
    };
    fixture
      .prepare("UPDATE settings SET value = ? WHERE key = 'app'")
      .run(JSON.stringify(previous));
    fixture.exec(rewind[34]!);
    fixture.exec(rewind[32]!);
    fixture.exec(rewind[31]!);
    fixture.exec(rewind[30]!);
    fixture.exec('ALTER TABLE characters DROP COLUMN chat_name; PRAGMA user_version = 27');
    fixture.close();
    upgrade(path);
    const upgraded = new DatabaseSync(path);
    const encoded = upgraded.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value;
    const expectedTemplate =
      name === 'default'
        ? DEFAULT_IMAGE_PROMPT_REVISION
        : {
            ...DEFAULT_IMAGE_PROMPT_REVISION,
            systemPrompt: '',
            userMessage:
              '<original_image_prompt>\n{{prompt}}\n</original_image_prompt>\n\n' +
              previousTemplate,
          };
    assert.deepEqual(JSON.parse(encoded as string), {
      ...Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'gallery')),
      revision: 60,
      galleryImagePrompts: {
        presets: [
          {
            id: 'image-prompt-revision',
            name: 'Revise image prompt',
            operation: 'image',
            ...expectedTemplate,
          },
        ],
        defaults: {},
      },
      galleryVideoPrompts: { presets: [], defaults: {} },
      chatVideoPrompts: { presets: [], defaults: {} },
      titlePrompt: DEFAULT_SETTINGS.titlePrompt,
      draftCompletionPrompt: DEFAULT_SETTINGS.draftCompletionPrompt,
      imageGeneration: {
        ...DEFAULT_SETTINGS.imageGeneration,
        promptPresets: markedImagePresets,
      },
      mediaRendering: migrateMediaRendering(savedImageSettings),
    });
    upgraded.close();
    upgrade(path);
    const reopened = new DatabaseSync(path);
    assert.equal(
      reopened.prepare("SELECT value FROM settings WHERE key = 'app'").get()!.value,
      encoded,
    );
    reopened.close();
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
  {
    const path = join(root, 'input-prompts.db');
    copyFileSync(freshPath, path);
    const fixture = new DatabaseSync(path);
    fixture.exec(rewind[60]!);
    fixture.exec(rewind[59]!);
    fixture.exec(rewind[55]!);
    fixture.exec(rewind[54]!);
    fixture.exec(rewind[53]!);
    fixture.exec(`PRAGMA user_version = 48;
      INSERT INTO media_recipes(id, prompt, configuration_json, inputs_json, created_at) VALUES ('source-prompt', 'Original source prompt', '{}', '[]', 1);
      INSERT INTO media_assets(id, path, recipe_id) VALUES (900, '/images/source.png', 'source-prompt');
      INSERT INTO media_jobs(id, operation, inputs_json, created_at, updated_at)
        VALUES ('input-job', 'video-first', '[{"slot":"first_frame","assetId":900}]', 1, 1);
      INSERT INTO media_recipes(id, prompt, configuration_json, inputs_json, created_at) VALUES ('input-recipe', 'Result', '{}',
        '[{"slot":"reference1","assetId":900},{"slot":"reference2","assetId":null}]', 1);`);
    fixture.close();
    upgrade(path);
    const upgraded = new DatabaseSync(path);
    const jobInputs = JSON.parse(
      String(
        upgraded.prepare("SELECT inputs_json FROM media_jobs WHERE id = 'input-job'").get()!
          .inputs_json,
      ),
    );
    const recipeInputs = JSON.parse(
      String(
        upgraded.prepare("SELECT inputs_json FROM media_recipes WHERE id = 'input-recipe'").get()!
          .inputs_json,
      ),
    );
    assert.deepEqual(jobInputs, [
      { slot: 'first_frame', assetId: 900, prompt: 'Original source prompt' },
    ]);
    assert.deepEqual(recipeInputs, [
      { slot: 'reference1', assetId: 900, prompt: 'Original source prompt' },
      { slot: 'reference2', assetId: null, prompt: '' },
    ]);
    upgraded.close();
  }

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
  const galleryPresetPath = join(root, 'gallery-preset-v49.db');
  copyFileSync(freshPath, galleryPresetPath);
  const galleryPresetFixture = new DatabaseSync(galleryPresetPath);
  galleryPresetFixture.exec(rewind[60]!);
  galleryPresetFixture.exec(rewind[59]!);
  galleryPresetFixture.exec(rewind[55]!);
  galleryPresetFixture.exec(rewind[54]!);
  galleryPresetFixture.exec(rewind[53]!);
  const revisionTemplate = {
    systemPrompt: 'Preserve the original details',
    userMessage: '{{prompt}} followed by {{instruction}}',
    reasoningPrefill: 'Consider the change',
    messagePrefill: 'Scene: ',
  };
  galleryPresetFixture
    .prepare(
      "INSERT INTO settings(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        revision: 80,
        gallery: { promptRevision: revisionTemplate },
      }),
    );
  galleryPresetFixture.exec('PRAGMA user_version = 49');
  galleryPresetFixture.close();
  upgrade(galleryPresetPath);
  const galleryPresetUpgraded = new DatabaseSync(galleryPresetPath);
  const migratedGallerySettings = JSON.parse(
    String(
      galleryPresetUpgraded.prepare("SELECT value FROM settings WHERE key='app'").get()!.value,
    ),
  );
  assert.equal(migratedGallerySettings.gallery, undefined);
  assert.equal(migratedGallerySettings.revision, 81);
  const migratedPreset = migratedGallerySettings.galleryImagePrompts.presets.find(
    (preset: { name: string }) => preset.name === 'Revise image prompt (2)',
  );
  assert(migratedPreset, 'Existing named presets remain separate from the migrated template');
  assert.notEqual(migratedPreset.id, 'image-prompt-revision');
  const { id: _id, name: _name, operation, ...preservedTemplate } = migratedPreset;
  assert.equal(operation, 'image');
  assert.deepEqual(preservedTemplate, revisionTemplate);
  galleryPresetUpgraded.close();

  // Existing installations lose the untouched sample, but retain saved custom workflows.
  for (const selected of ['image-description', 'edited-description']) {
    const path = join(root, `description-default-${selected}.db`);
    copyFileSync(freshPath, path);
    const fixture = new DatabaseSync(path);
    fixture.exec(rewind[60]!);
    fixture.exec(rewind[59]!);
    fixture.exec(rewind[55]!);
    fixture.exec(rewind[54]!);
    fixture.exec(rewind[53]!);
    const edited = {
      ...IMAGE_DESCRIPTION_WORKFLOW,
      id: 'edited-description',
      json: IMAGE_DESCRIPTION_WORKFLOW.json + '\n',
    };
    const renamed = { ...IMAGE_DESCRIPTION_WORKFLOW, id: 'mine', name: 'My description' };
    fixture
      .prepare(
        "INSERT INTO settings(key,value) VALUES ('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(
        JSON.stringify({
          ...DEFAULT_SETTINGS,
          revision: 10,
          mediaRendering: {
            ...DEFAULT_SETTINGS.mediaRendering,
            workflows: [IMAGE_DESCRIPTION_WORKFLOW, edited, renamed],
            defaults: { 'image-describe:0': selected },
          },
        }),
      );
    fixture.exec('PRAGMA user_version = 51');
    fixture.close();
    upgrade(path);
    const upgraded = new DatabaseSync(path);
    const settings = JSON.parse(
      String(upgraded.prepare("SELECT value FROM settings WHERE key='app'").get()!.value),
    );
    assert.deepEqual(settings.mediaRendering.workflows, [edited, renamed]);
    assert.deepEqual(
      settings.mediaRendering.defaults,
      selected === edited.id ? { 'image-describe:0': edited.id } : {},
    );
    assert.equal(settings.revision, 11);
    upgraded.close();
  }

  console.log(
    'Migration regressions passed: fresh schema, versions 1–61, preserved image settings and gallery templates, data conversions, nested transactions and migration rollback.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
