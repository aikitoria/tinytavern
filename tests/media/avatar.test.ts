import assert from 'node:assert/strict';
import { newRequestId, type MediaWorkflow } from '@tinytavern/shared';
import { databaseCase } from '../support/database.ts';
import { insertFixture } from '../support/fixtures.ts';
import { mockFetch, upstreamFrame } from '../support/streams.ts';
import { stmt } from '../../server/src/db/db.ts';
import { getSettings, putSettings } from '../../server/src/settings/settingsStore.ts';
import { createMediaJob, startMediaJob } from '../../server/src/media/mediaJobs.ts';
import { requireMediaJob, observeMediaJob } from '../../server/src/media/mediaJobStore.ts';
import {
  initMediaWorker,
  stopMediaWorker,
  tickMediaWorker,
} from '../../server/src/media/mediaWorker.ts';

const workflow: MediaWorkflow = {
  id: 'avatar',
  name: 'Avatar',
  inputBindings: {},
  textOutputNodeId: null,
  standalonePromptPresetId: null,
  chatPromptPresetId: null,
  json: '{"output":{"inputs":{"text":"{{prompt}}"}}}',
};

databaseCase('avatar workflows without a prompt do not require a text endpoint', async () => {
  const id = insertFixture('personas', { name: 'Persona', description: 'Portrait', created_at: 1 });
  putSettings({
    ...getSettings(),
    activeEndpointId: null,
    mediaRendering: {
      ...getSettings().mediaRendering,
      workflows: [{ ...workflow, json: '{"output":{"inputs":{}}}' }],
    },
  });
  const job = createMediaJob({
    requestKey: newRequestId(),
    workflowId: getSettings().mediaRendering.workflows[0]!.id,
    avatarContext: { kind: 'persona', id },
    reviewBeforeSave: true,
  });
  const running = startMediaJob(requireMediaJob(job.id), {}, false);
  assert.equal(running.state, 'submitting');
  assert.equal(running.prompt, '');
  assert.equal(requireMediaJob(job.id).endpoint_json, null);
  assert.equal(requireMediaJob(job.id).context_json, null);
});

databaseCase(
  'avatar jobs capture entity context and reject truncated prompts with shared endpoint settings',
  async () => {
    const id = insertFixture('characters', {
      name: 'Portrait subject',
      chat_name: 'Alias',
      personality: 'Original description',
      scenario: 'A garden',
      first_message: 'Hello',
      created_at: 1,
    });
    const endpointId = insertFixture('endpoints', {
      name: 'Avatar endpoint',
      base_url: 'http://avatar.invalid/v1',
      model: 'test',
      api_key: '',
      gen_params_json: JSON.stringify({
        temperature: 0.3,
        maxTokens: 8192,
        reasoningEffort: 'high',
      }),
      created_at: 1,
    });
    putSettings({
      ...getSettings(),
      activeEndpointId: endpointId,
      mediaRendering: { ...getSettings().mediaRendering, workflows: [workflow] },
      imageGeneration: {
        ...getSettings().imageGeneration,
        promptPresets: {
          avatar: {
            active: 'Custom',
            presets: [
              {
                name: 'Custom',
                prompt: 'Portrait of {{char}}',
                context: '{{description}} / {{scenario}} / {{firstMessage}}',
              },
            ],
          },
        },
      },
    });
    initMediaWorker();
    const originalFetch = globalThis.fetch;
    const requests: Record<string, unknown>[] = [];
    mockFetch((url, options) => {
      assert.equal(String(url), 'http://avatar.invalid/v1/chat/completions');
      requests.push(JSON.parse(String(options?.body)));
      return new Response(
        upstreamFrame({ content: 'Truncated portrait' }, 'length') + 'data: [DONE]\n\n',
      );
    });
    let unsubscribe = () => {};
    try {
      const job = createMediaJob({
        requestKey: newRequestId(),
        workflowId: workflow.id,
        avatarContext: { kind: 'character', id },
        reviewBeforeSave: true,
      });
      startMediaJob(requireMediaJob(job.id), { autoRender: true }, true);
      stmt('UPDATE characters SET personality = ? WHERE id = ?').run('Edited after capture', id);
      const finished = new Promise<void>((resolve) => {
        unsubscribe = observeMediaJob(job.id, (row) => {
          if (row.state === 'failed') resolve();
        });
      });
      tickMediaWorker();
      await finished;
      assert.equal(requests.length, 1, 'A truncated prompt never submits to Comfy');
      assert.equal(requests[0]!.temperature, 0.3);
      assert.equal(requests[0]!.max_tokens, 8192);
      assert.equal(requests[0]!.reasoning_effort, 'high');
      assert.deepEqual(requests[0]!.messages, [
        { role: 'system', content: 'Portrait of Alias' },
        { role: 'user', content: 'Original description / A garden / Hello' },
      ]);
      const failed = requireMediaJob(job.id);
      assert.match(failed.error!, /truncated/);
      assert.equal(failed.submission_id, null);
      assert.equal(failed.auto_render, 0);
      assert.equal(failed.prompt, 'Truncated portrait');
      const rerun = createMediaJob({ requestKey: newRequestId() }, failed);
      assert.deepEqual(rerun.avatarContext, { kind: 'character', id });
    } finally {
      unsubscribe();
      stopMediaWorker();
      globalThis.fetch = originalFetch;
    }
  },
);
