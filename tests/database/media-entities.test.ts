import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '@tinytavern/shared';
import { DATA_DIR } from '../../server/src/db/db.ts';
import { restoreLegacyMediaSchema } from '../support/legacyMediaSchema.ts';

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
      const settings = structuredClone(DEFAULT_SETTINGS);
      const workflow = (id: string, name: string) => ({
        id,
        name,
        json: graph,
        inputBindings: {},
        textOutputNodeId: null,
        standalonePromptPresetId: 'standalone',
        chatPromptPresetId: 'chat',
      });
      settings.mediaRendering.workflows = [
        workflow('old-uuid', 'Text identity'),
        workflow('800', 'Numeric identity'),
      ];
      settings.mediaRendering.folders = [
        { id: 'folder', name: 'Images', workflowIds: ['old-uuid'] },
      ];
      settings.mediaRendering.defaultWorkflowId = 'old-uuid';
      settings.mediaRendering.shortcuts = [
        { id: 'shortcut', name: 'Render', workflowId: 'old-uuid' },
      ];
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
      settings.mediaFavorites = [
        { id: 'favorite', name: 'Favorite', workflowId: 'old-uuid', presetId: 'chat' },
      ];
      settings.imageGeneration.promptPresets = {
        avatar: {
          presets: [{ name: 'Portrait', prompt: 'Portrait', context: 'Person' }],
          active: 'Portrait',
        },
      };
      legacy.query("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));
      legacy.exec(
        "INSERT INTO conversations(id, title, created_at, updated_at) VALUES (99, 'Chat', 1, 1)",
      );
      legacy
        .query(
          'INSERT INTO media_recipes(id, prompt, configuration_json, created_at) VALUES (1, ?, ?, 1)',
        )
        .run('Saved prompt', JSON.stringify({ workflowId: '1200', seed: 0 }));
      legacy.exec(
        "INSERT INTO media_assets(id, path, recipe_id, created_at) VALUES (1, '/images/media-1.png', 1, 1)",
      );
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
      assert.deepEqual(
        migrated.query('SELECT deleted_at FROM media_workflows WHERE id = 1200').get(),
        { deleted_at: 0 },
      );
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
          .query(
            'SELECT name FROM avatar_prompts WHERE id = (SELECT avatar_prompt_id FROM media_selections)',
          )
          .get(),
        { name: 'Portrait' },
      );
      if (withJobs) {
        assert.deepEqual(
          migrated
            .query(
              'SELECT workflow_id, chat_preset_id, standalone_preset_id FROM media_jobs WHERE id = 50',
            )
            .get(),
          {
            workflow_id: String(row.id),
            chat_preset_id: 900,
            standalone_preset_id: null,
          },
        );
        assert.deepEqual(
          migrated
            .query('SELECT preset_id, standalone_preset_id FROM media_jobs WHERE id = 51')
            .get(),
          { preset_id: '1000', standalone_preset_id: 1000 },
        );
      }
      const stored = migrated
        .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'app'")
        .get()!;
      const scalar = JSON.parse(stored.value);
      assert.equal(scalar.mediaRendering.workflows, undefined);
      assert.equal(scalar.mediaChatPrompts, undefined);
      assert.equal(scalar.mediaFavorites, undefined);
      assert.equal(scalar.imageGeneration.promptPresets, undefined);
      const newJob = migrated
        .query('INSERT INTO media_jobs(created_at, updated_at) VALUES (1, 1)')
        .run();
      assert.equal(
        Number(newJob.lastInsertRowid),
        10001,
        'Even an empty job table retains its high-water mark',
      );
    }
    start();
    using reopened = new Database(path);
    const next = reopened
      .query("INSERT INTO media_workflows(name, created_at) VALUES ('After restart', 1)")
      .run();
    assert(Number(next.lastInsertRowid) > assignedWorkflow);
    assert.deepEqual(reopened.query('PRAGMA foreign_key_check').all(), []);
  }
});
