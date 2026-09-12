import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '@tinytavern/shared';
import { DATA_DIR } from '../../server/src/db/db.ts';
import {
  restoreLegacyMediaSchema,
  restoreLegacyAttachments,
  restoreVersion86Schema,
} from '../support/legacyMediaSchema.ts';

const graph = '{"output":{"inputs":{"prompt":"{{prompt}}","seed":0}}}';

test('media entity migration preserves historical identities, references and allocation after restart', () => {
  for (const withJobs of [true, false]) {
    const directory = mkdtempSync(join(DATA_DIR, 'entities-'));
    const path = join(directory, 'tinytavern.db');
    const start = () => {
      const result = spawnSync(
        process.execPath,
        ['-e', "const { db } = await import('./server/src/db/db.ts'); db.close(true);"],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            DATA_DIR: directory,
            DB_PATH: path,
            TINYTAVERN_TEST_DATA_DIR: directory,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
    };
    start();
    {
      using legacy = new Database(path);
      restoreLegacyMediaSchema(legacy);
      const settings = structuredClone(DEFAULT_SETTINGS) as unknown as Omit<
        typeof DEFAULT_SETTINGS,
        'mediaRendering' | 'mediaChatPrompts'
      > & {
        mediaRendering: Omit<typeof DEFAULT_SETTINGS.mediaRendering, 'folders'> & {
          folders: { id: string; name: string; workflowIds: string[] }[];
        };
        mediaChatPrompts: Omit<typeof DEFAULT_SETTINGS.mediaChatPrompts, 'folders'> & {
          folders: { id: string; name: string; presetIds: string[] }[];
        };
      };
      const workflow = (id: string, name: string) => ({
        id,
        name,
        json: graph,
        inputBindings: {},
        textOutputNodeId: null,
        standalonePromptPresetId: 'standalone',
        chatPromptPresetId: 'chat',
      });
      settings.mediaRendering.workflows = [workflow('old-uuid', 'Text identity'), workflow('800', 'Numeric identity')];
      settings.mediaRendering.folders = [{ id: 'folder', name: 'Images', workflowIds: ['old-uuid'] }];
      settings.mediaRendering.defaultWorkflowId = 'old-uuid';
      settings.mediaRendering.shortcuts = [{ id: 'shortcut', name: 'Render', workflowId: 'old-uuid' }];
      settings.mediaChatPrompts = {
        presets: [
          { id: 'chat', name: 'Chat', chatPrompt: 'Describe' },
          { id: '700', name: 'Numeric chat', chatPrompt: 'Details' },
        ],
        folders: [{ id: 'chat-folder', name: 'Chat folder', presetIds: ['chat'] }],
        defaultPresetId: 'chat',
      };
      settings.mediaStandalonePrompts = {
        presets: [
          {
            id: 'standalone',
            name: 'Standalone',
            systemPrompt: '',
            userMessage: 'Render',
            reasoningPrefill: '',
            messagePrefill: '',
          },
        ],
        folders: [],
        defaultPresetId: 'standalone',
      };
      settings.mediaFavorites = [{ id: 'favorite', name: 'Favorite', workflowId: 'old-uuid', presetId: 'chat' }];
      settings.imageGeneration.promptPresets = {
        avatar: {
          presets: [{ name: 'Portrait', prompt: 'Portrait', context: 'Person' }],
          active: 'Portrait',
        },
      };
      legacy.query("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
      legacy.exec("INSERT INTO conversations(id, title, created_at, updated_at) VALUES (99, 'Chat', 1, 1)");
      legacy
        .query('INSERT INTO media_recipes(id, prompt, configuration_json, created_at) VALUES (1, ?, ?, 1)')
        .run('Saved prompt', JSON.stringify({ workflowId: '1200', seed: 0 }));
      legacy.exec("INSERT INTO media_assets(id, path, recipe_id, created_at) VALUES (1, '/images/media-1.png', 1, 1)");
      if (withJobs) {
        legacy
          .query(
            `INSERT INTO media_jobs(id, workflow_id, preset_id, context_conversation_id, configuration_json, created_at, updated_at)
          VALUES (50, 'old-uuid', '900', 99, ?, 1, 1)`,
          )
          .run(JSON.stringify({ workflowId: 'old-uuid' }));
        legacy.exec(
          "INSERT INTO media_jobs(id, workflow_id, preset_id, created_at, updated_at) VALUES (51, '1200', '1000', 1, 1)",
        );
      }
      legacy.exec(
        "DELETE FROM sqlite_sequence WHERE name = 'media_jobs'; INSERT INTO sqlite_sequence(name, seq) VALUES ('media_jobs', 10000)",
      );
    }
    start();
    let assignedWorkflow = 0;
    {
      using migrated = new Database(path);
      assert.deepEqual(migrated.query('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(migrated.query('PRAGMA integrity_check').get(), { integrity_check: 'ok' });
      const row = migrated
        .query<{ id: number; folder_id: number; chat_prompt_preset_id: number }, []>(
          "SELECT * FROM media_workflows WHERE name = 'Text identity'",
        )
        .get()!;
      assignedWorkflow = row.id;
      assert(row.id > 1200, 'Allocate legacy text IDs above every known historical numeric ID');
      assert(row.folder_id > 0);
      assert(row.chat_prompt_preset_id > (withJobs ? 900 : 700));
      assert.deepEqual(migrated.query('SELECT deleted_at FROM media_workflows WHERE id = 1200').get(), {
        deleted_at: 0,
      });
      assert.deepEqual(migrated.query('SELECT workflow_id FROM media_recipes WHERE id = 1').get(), {
        workflow_id: 1200,
      });
      assert.deepEqual(migrated.query('SELECT recipe_id FROM media_assets WHERE id = 1').get(), {
        recipe_id: 1,
      });
      assert.deepEqual(migrated.query('SELECT default_workflow_id FROM media_selections').get(), {
        default_workflow_id: row.id,
      });
      assert.deepEqual(migrated.query('SELECT workflow_id, preset_id FROM media_favorites').get(), {
        workflow_id: row.id,
        preset_id: row.chat_prompt_preset_id,
      });
      assert.deepEqual(migrated.query('SELECT workflow_id FROM media_shortcuts').get(), {
        workflow_id: row.id,
      });
      assert.deepEqual(
        migrated
          .query('SELECT name FROM avatar_prompts WHERE id = (SELECT avatar_prompt_id FROM media_selections)')
          .get(),
        { name: 'Portrait' },
      );
      if (withJobs) {
        assert.deepEqual(
          migrated
            .query('SELECT workflow_id, chat_preset_id, standalone_preset_id FROM media_jobs WHERE id = 50')
            .get(),
          {
            workflow_id: String(row.id),
            chat_preset_id: 900,
            standalone_preset_id: null,
          },
        );
        assert.deepEqual(migrated.query('SELECT preset_id, standalone_preset_id FROM media_jobs WHERE id = 51').get(), {
          preset_id: '1000',
          standalone_preset_id: 1000,
        });
      }
      const stored = migrated.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'app'").get()!;
      const scalar = JSON.parse(stored.value);
      assert.equal(scalar.mediaRendering.workflows, undefined);
      assert.equal(scalar.mediaChatPrompts, undefined);
      assert.equal(scalar.mediaFavorites, undefined);
      assert.equal(scalar.imageGeneration.promptPresets, undefined);
      const newJob = migrated.query('INSERT INTO media_jobs(created_at, updated_at) VALUES (1, 1)').run();
      assert.equal(Number(newJob.lastInsertRowid), 10001, 'Even an empty job table retains its high-water mark');
    }
    start();
    using reopened = new Database(path);
    const next = reopened.query("INSERT INTO media_workflows(name, created_at) VALUES ('After restart', 1)").run();
    assert(Number(next.lastInsertRowid) > assignedWorkflow);
    assert.deepEqual(reopened.query('PRAGMA foreign_key_check').all(), []);
  }
});

test('attachment upgrade preserves asset identities, numeric order and reference pins across restart', () => {
  const directory = mkdtempSync(join(DATA_DIR, 'attachments-'));
  const path = join(directory, 'tinytavern.db');
  const start = () => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const { db, toMessage, stmt } = await import('./server/src/db/db.ts');
      const row = stmt('SELECT * FROM messages WHERE id = 100').get();
      if (row) console.log(JSON.stringify(toMessage(row)));
      db.close(true);
    `,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, DATA_DIR: directory, DB_PATH: path, TINYTAVERN_TEST_DATA_DIR: directory },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  start();
  const paths = Array.from({ length: 13 }, (_, index) => `/images/legacy-${index}.png`);
  let owners: unknown[];
  {
    using legacy = new Database(path);
    restoreLegacyAttachments(legacy);
    legacy.exec(`INSERT INTO conversations(id, title, created_at, updated_at) VALUES (100, 'Legacy', 1, 1);
      INSERT INTO media_recipes(id, prompt, configuration_json, created_at) VALUES (100, 'Recipe', '{}', 1);
      INSERT INTO media_jobs(id, state, created_at, updated_at) VALUES (100, 'draft', 1, 1);`);
    legacy
      .query(
        `INSERT INTO messages(id, conversation_id, role, content, images_json, active_image, created_at)
      VALUES (100, 100, 'tool', 'Prompt', ?, 11, 1)`,
      )
      .run(JSON.stringify([...paths, paths[0]]));
    legacy
      .query(
        `INSERT INTO gallery_items(id, character_name, prompt, image, created_at, updated_at)
      VALUES (100, 'Legacy', 'Saved', ?, 1, 1)`,
      )
      .run(paths[0]!);
    legacy
      .query(
        `INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
      SELECT id, 'job', 100, 'input:input1' FROM media_assets WHERE path = ?`,
      )
      .run(paths[0]!);
    legacy
      .query(
        `INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
      SELECT id, 'recipe', 100, 'input:input1' FROM media_assets WHERE path = ?`,
      )
      .run(paths[0]!);
    owners = legacy.query('SELECT * FROM media_owners ORDER BY owner_type, owner_id, slot').all();
  }
  const first = JSON.parse(start());
  assert.deepEqual(
    first.media.map((asset: { url: string }) => asset.url),
    [...paths, paths[0]],
  );
  assert.equal(first.activeImage, 11);
  assert.equal(first.media[0].id, first.media[13].id, 'Repeated slots keep the same asset identity');
  assert.deepEqual(JSON.parse(start()), first, 'Reopening never replays attachment migration');
  {
    using migrated = new Database(path);
    assert.deepEqual(migrated.query('SELECT * FROM media_owners ORDER BY owner_type, owner_id, slot').all(), owners);
    assert.equal(migrated.query("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'images_json'").get(), null);
    assert.equal(
      migrated
        .query(
          "SELECT 1 FROM pragma_table_info('gallery_items') WHERE name IN ('image', 'image_width', 'image_height')",
        )
        .get(),
      null,
    );
    assert.deepEqual(migrated.query('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(migrated.query('PRAGMA integrity_check').get(), { integrity_check: 'ok' });
  }
});

test('review prompt upgrade is atomic, runs once and leaves unattended history lightweight', () => {
  const directory = mkdtempSync(join(DATA_DIR, 'review-prompts-'));
  const path = join(directory, 'tinytavern.db');
  const start = () => {
    const result = spawnSync(
      process.execPath,
      ['-e', "const { db } = await import('./server/src/db/db.ts'); db.close(true);"],
      {
        encoding: 'utf8',
        env: { ...process.env, DATA_DIR: directory, DB_PATH: path, TINYTAVERN_TEST_DATA_DIR: directory },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  start();
  const context = {
    messages: [
      { role: 'system', content: 'Captured context' },
      { role: 'user', content: 'Captured instruction' },
    ],
    template: { reasoningPrefill: 'Think', messagePrefill: 'Reply' },
  };
  {
    using legacy = new Database(path);
    restoreVersion86Schema(legacy);
    legacy.exec('INSERT INTO media_drafts(id) VALUES (100), (101)');
    const insert = legacy.query(`INSERT INTO media_jobs
      (id, draft_id, state, prompt, context_json, endpoint_json, auto_render, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '{"id":999999}', 1, 1, 1)`);
    insert.run(100, 100, 'ready', 'Saved reply', JSON.stringify(context));
    insert.run(101, 101, 'preparing', 'Partial reply', JSON.stringify(context));
    insert.run(102, null, 'succeeded', 'Unattended reply', JSON.stringify(context));
    insert.run(103, 100, 'ready', 'Saved variation', JSON.stringify(context));
    legacy.exec(`INSERT INTO media_assets(id, path, reference_deleted)
      VALUES (100, '/images/deleted-during-preparation.png', 1);
      INSERT INTO media_owners VALUES (100, 'job', 101, 'input:input1');`);
  }
  start();
  let first: unknown[];
  {
    using migrated = new Database(path);
    const rows = migrated
      .query<
        { id: number; conversation_id: number; prompt_message_id: number; state: string; auto_render: number },
        []
      >(
        `SELECT j.*, d.conversation_id FROM media_jobs j
      LEFT JOIN media_drafts d ON d.id = j.draft_id ORDER BY j.id`,
      )
      .all();
    assert.ok(rows[0]!.conversation_id);
    assert.notEqual(rows[1]!.conversation_id, rows[0]!.conversation_id);
    assert.equal(rows[1]!.state, 'ready');
    assert.equal(rows[1]!.auto_render, 0, 'An interrupted reply must never render automatically');
    assert.equal(
      migrated.query("SELECT 1 FROM media_owners WHERE owner_type = 'job' AND owner_id = 101").get(),
      null,
      'Migrating interrupted preparation releases its deleted source inputs',
    );
    assert.equal(rows[2]!.conversation_id, null);
    assert.equal(rows[2]!.prompt_message_id, null);
    assert.equal(rows[3]!.conversation_id, rows[0]!.conversation_id);
    assert.ok(rows[3]!.prompt_message_id, 'Every saved variation gets its own linked reply');
    assert.notEqual(rows[3]!.prompt_message_id, rows[0]!.prompt_message_id);
    const conversation = migrated
      .query<{ prompt_context_json: string; endpoint_id: number | null; active_leaf_id: number }, [number]>(
        'SELECT * FROM conversations WHERE id = ?',
      )
      .get(rows[0]!.conversation_id)!;
    assert.deepEqual(JSON.parse(conversation.prompt_context_json), {
      messages: [context.messages[0]],
      reasoningPrefill: 'Think',
      messagePrefill: 'Reply',
    });
    assert.equal(conversation.endpoint_id, null, 'Deleted endpoints do not prevent migration');
    assert.equal(conversation.active_leaf_id, rows[0]!.prompt_message_id);
    const replies = migrated.query("SELECT content, status FROM messages WHERE role = 'assistant' ORDER BY id").all();
    assert.deepEqual(replies, [
      { content: 'Saved reply', status: 'done' },
      { content: 'Partial reply', status: 'error' },
      { content: 'Saved variation', status: 'done' },
    ]);
    assert.equal(migrated.query<{ n: number }, []>('SELECT count(*) AS n FROM media_library_versions').get()!.n, 9);
    assert.deepEqual(migrated.query('PRAGMA foreign_key_check').all(), []);
    first = migrated.query('SELECT * FROM messages ORDER BY id').all();
  }
  start();
  {
    using reopened = new Database(path);
    assert.deepEqual(reopened.query('SELECT * FROM messages ORDER BY id').all(), first);
    const discussion = reopened
      .query<{ conversation_id: number }, []>('SELECT conversation_id FROM media_drafts WHERE id = 100')
      .get()!.conversation_id;
    reopened
      .query(
        `INSERT INTO messages(id, conversation_id, role, content, active_child_id, created_at)
      VALUES (1000, ?, 'user', 'Continue the discussion', 1001, 2)`,
      )
      .run(discussion);
    reopened
      .query(
        `INSERT INTO messages(id, conversation_id, parent_id, role, content, created_at)
      VALUES (1001, ?, 1000, 'assistant', 'An independently edited reply', 2)`,
      )
      .run(discussion);
    reopened.query('UPDATE conversations SET active_leaf_id = 1001 WHERE id = ?').run(discussion);
    first = reopened.query('SELECT * FROM messages ORDER BY id').all();
    // A server may already have run version 87 before this pin cleanup was introduced.
    reopened.exec(`PRAGMA user_version = 87;
      INSERT INTO media_assets(id, path, reference_deleted)
        VALUES (200, '/images/deleted-before-upgrade.png', 1), (201, '/images/available-input.png', 0);
      INSERT INTO media_jobs(id, state, created_at, updated_at) VALUES (200, 'rendering', 1, 1);
      INSERT INTO media_jobs(id, draft_id, state, prompt, created_at, updated_at)
        VALUES (201, 100, 'ready', 'Unlinked version 87 variation', 1, 1);
      INSERT INTO media_owners VALUES
        (200, 'job', 101, 'input:input1'),
        (201, 'job', 101, 'input:input2'),
        (200, 'job', 101, 'output:0'),
        (200, 'job', 200, 'input:input1');`);
  }
  start();
  using repaired = new Database(path);
  assert.deepEqual(repaired.query('SELECT * FROM messages WHERE id <= 1001 ORDER BY id').all(), first);
  const linked = repaired
    .query<{ content: string; active_leaf_id: number; conversation_id: number; id: number }, []>(
      `SELECT m.*, c.active_leaf_id FROM media_jobs j
      JOIN messages m ON m.id = j.prompt_message_id
      JOIN conversations c ON c.id = m.conversation_id WHERE j.id = 201`,
    )
    .get()!;
  assert.equal(linked.content, 'Unlinked version 87 variation');
  assert.equal(linked.active_leaf_id, 1001, 'Repair preserves the existing active discussion');
  assert.notEqual(linked.id, 1001);
  assert.deepEqual(
    repaired.query('SELECT * FROM media_owners ORDER BY owner_id, slot').all(),
    [
      { asset_id: 201, owner_type: 'job', owner_id: 101, slot: 'input:input2' },
      { asset_id: 200, owner_type: 'job', owner_id: 101, slot: 'output:0' },
      { asset_id: 200, owner_type: 'job', owner_id: 200, slot: 'input:input1' },
    ],
    'Repair releases only deleted inactive inputs, preserving available inputs, outputs and active reads',
  );
  assert.equal(repaired.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version, 88);
  assert.deepEqual(repaired.query('PRAGMA foreign_key_check').all(), []);
});
