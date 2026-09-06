import type { Settings } from '@tinytavern/shared';
import {
  BASE,
  MOCK_CONTROL,
  assert,
  req,
  collectRenderProgress,
  expectStatus,
  putSettings,
} from './helpers.ts';
import type { CharactersFixture } from './characters.ts';
import type { SetupFixture } from './setup.ts';

export async function testAvatars(
  fixture: Pick<CharactersFixture, 'putAvatar'> & Pick<SetupFixture, 'persona'>,
) {
  const { putAvatar, persona } = fixture;

  console.log('== avatar generation (prompt stream + comfy render) ==');
  const AVATAR_WORKFLOW =
    '{"3":{"class_type":"KSampler","inputs":{"seed":{{seed}}}},"6":{"inputs":{"text":"{{prompt}}"}}}';
  const AVATAR_SYSTEM_TEMPLATE =
    'Write a portrait image-generation prompt for {{name}}. Reply with only the prompt.';
  const AVATAR_CONTEXT_TEMPLATE =
    'Name: {{name}}\nAvatar details: {{description}}\nScenario: {{scenario}}\nFirst message: {{firstMessage}}';
  // Build the request from plugin settings, matching the client.
  await putSettings({
    pluginSettings: {
      imageGeneration: {
        promptPresets: {
          avatar: {
            presets: [
              {
                name: 'Detailed',
                prompt: AVATAR_SYSTEM_TEMPLATE,
                context: AVATAR_CONTEXT_TEMPLATE,
              },
            ],
            active: 'Detailed',
          },
        },
        comfyUrl: MOCK_CONTROL,
        workflows: [{ name: 'Avatar', json: AVATAR_WORKFLOW }],
        activeWorkflow: 'Avatar',
      },
    },
  });
  const imageGenCfg = ((await req<Settings>('GET', '/api/settings')).pluginSettings
    .imageGeneration as {
    promptPresets: {
      avatar: {
        presets: { name: string; prompt: string; context: string }[];
        active: string;
      };
    };
    comfyUrl: string;
    workflows: { name: string; json: string }[];
    activeWorkflow: string;
  })!;
  const avatarPreset = imageGenCfg.promptPresets.avatar.presets.find(
    (preset) => preset.name === imageGenCfg.promptPresets.avatar.active,
  )!;
  const avatarImage = {
    workflow: imageGenCfg.workflows.find((w) => w.name === imageGenCfg.activeWorkflow)!.json,
    comfyUrl: imageGenCfg.comfyUrl,
  };
  const avatarChar = await req<{ id: number }>('POST', '/api/characters', {
    name: 'Avatar Hero',
    personality: 'a brave knight with silver hair',
    scenario: 'a mountain keep',
    firstMessage: 'Welcome to the keep. The winter wolves are close.',
  });

  const streamAvatarPrompt = async (
    path: string,
    prompt: string,
    context: string,
  ): Promise<string> => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, context }),
    });
    assert(
      res.ok && res.headers.get('content-type')?.includes('text/event-stream') === true,
      `prompt stream at ${path} responds with SSE`,
    );
    const body = await res.text();
    let text = '';
    let sawDone = false;
    let sawError = false;
    for (const line of body.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = JSON.parse(line.slice(5)) as { d?: string; error?: string; done?: boolean };
      if (payload.error !== undefined) sawError = true;
      if (payload.d) text += payload.d;
      if (payload.done) sawDone = true;
    }
    assert(!sawError, `prompt stream at ${path} carries no error event`);
    assert(sawDone, `prompt stream at ${path} terminates with a done event`);
    return text;
  };

  const firstStream = streamAvatarPrompt(
    `/api/characters/${avatarChar.id}/avatar/prompt`,
    avatarPreset.prompt,
    avatarPreset.context,
  );
  // Let the first request reach the server and claim the per-entity slot.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await expectStatus(
    'POST',
    `/api/characters/${avatarChar.id}/avatar/prompt`,
    { prompt: avatarPreset.prompt, context: avatarPreset.context },
    409,
  );
  const avatarPrompt = await firstStream;
  assert(avatarPrompt.includes('Avatar Hero'), 'prompt stream relays the LLM completion text');

  // An error without a done marker prevents the modal from rendering a partial prompt.
  await fetch(`${MOCK_CONTROL}/control/fail-next?count=1`, { method: 'POST' });
  const failedPromptRes = await fetch(`${BASE}/api/characters/${avatarChar.id}/avatar/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: avatarPreset.prompt, context: avatarPreset.context }),
  });
  const failedPromptBody = await failedPromptRes.text();
  assert(
    failedPromptBody.includes('"error"') && !failedPromptBody.includes('"done":true'),
    'failed avatar prompt stream cannot be mistaken for a completed prompt',
  );

  // Modal close must abort upstream and release the entity lock so reopening avoids a 409.
  const cancelledPrompt = new AbortController();
  const cancelledPromptRes = await fetch(`${BASE}/api/characters/${avatarChar.id}/avatar/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: avatarPreset.prompt, context: avatarPreset.context }),
    signal: cancelledPrompt.signal,
  });
  assert(cancelledPromptRes.ok, 'cancellable avatar prompt stream opens');
  cancelledPrompt.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const reopenedPrompt = await streamAvatarPrompt(
    `/api/characters/${avatarChar.id}/avatar/prompt`,
    avatarPreset.prompt,
    avatarPreset.context,
  );
  assert(reopenedPrompt.length > 0, 'aborting an avatar prompt releases its entity lock');

  const { completion: avatarCompletion } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as { completion: { system: string | null; user: string | null } };
  assert(
    avatarCompletion.system ===
      'Write a portrait image-generation prompt for Avatar Hero. Reply with only the prompt.',
    'avatar system prompt expands independently without duplicating character details',
  );
  assert(
    avatarCompletion.user ===
      'Name: Avatar Hero\n' +
        'Avatar details: a brave knight with silver hair\n' +
        'Scenario: a mountain keep\n' +
        'First message: Welcome to the keep. The winter wolves are close.',
    'the model is given avatar details, scenario, and first message as context',
  );

  const renderRes = await fetch(`${BASE}/api/avatar/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: avatarPrompt, image: avatarImage }),
  });
  assert(
    renderRes.ok && renderRes.headers.get('content-type') === 'image/png',
    'avatar render returns PNG bytes',
  );
  const renderedPng = Buffer.from(await renderRes.arrayBuffer());
  assert(renderedPng[0] === 0x89 && renderedPng[1] === 0x50, 'avatar render is a real PNG');
  const { workflow: avatarWorkflow, previewMethod: avatarPreviewMethod } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-workflow`)
  ).json()) as {
    workflow: { 6: { inputs: { text: string } } };
    previewMethod: string | null;
  };
  assert(
    avatarWorkflow[6].inputs.text.includes(avatarPrompt.slice(0, 30)),
    'the prompt lands in the workflow {{prompt}} slot',
  );
  assert(avatarPreviewMethod === 'taesd', 'avatar renders explicitly request TAESD previews');

  const genCharRes = await putAvatar(`/api/characters/${avatarChar.id}/avatar`, renderedPng);
  assert(genCharRes.ok, 'rendered avatar saves through the avatar upload route');

  // A jobId gets a private SSE stream rather than a global progress broadcast.
  const avatarJobId = 'e2e-avatar-job';
  const unrelatedJobId = 'e2e-avatar-unrelated-job';
  const unrelatedAbort = new AbortController();
  const unrelatedResponse = await fetch(`${BASE}/api/avatar/render-progress/${unrelatedJobId}`, {
    signal: unrelatedAbort.signal,
  });
  const unrelatedReader = unrelatedResponse.body!.getReader();
  // Consume the registration comment before checking for leaked data events.
  await unrelatedReader.read();
  const progressAbort = new AbortController();
  const progressResponse = await fetch(`${BASE}/api/avatar/render-progress/${avatarJobId}`, {
    signal: progressAbort.signal,
  });
  assert(progressResponse.ok && progressResponse.body != null, 'avatar progress SSE opens');
  const progressSeen = collectRenderProgress(progressResponse, 'avatar progress');
  const progressRenderRes = await fetch(`${BASE}/api/avatar/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'progress check', image: avatarImage, jobId: avatarJobId }),
  });
  assert(progressRenderRes.ok, 'avatar render with jobId succeeds');
  await progressSeen;
  assert(true, 'jobId render sends progress and a live preview through its private SSE stream');
  progressAbort.abort();
  const unrelatedResult = await Promise.race([
    unrelatedReader.read().then(
      () => 'event',
      () => 'closed',
    ),
    new Promise<'quiet'>((resolve) => setTimeout(() => resolve('quiet'), 150)),
  ]);
  assert(unrelatedResult === 'quiet', 'avatar progress never leaks to an unrelated job stream');
  unrelatedAbort.abort();

  // Closing the modal must stop Comfy polling along with the binary response.
  const historyCount = async () =>
    (
      (await (await fetch(`${MOCK_CONTROL}/control/comfy-history-count`)).json()) as {
        count: number;
      }
    ).count;
  const cancelledRender = new AbortController();
  const cancelledRenderRequest = fetch(`${BASE}/api/avatar/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'cancel this avatar render',
      image: avatarImage,
      jobId: 'e2e-avatar-cancelled-job',
    }),
    signal: cancelledRender.signal,
  }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 150));
  cancelledRender.abort();
  await cancelledRenderRequest;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const countAfterAbort = await historyCount();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert(
    (await historyCount()) === countAfterAbort,
    'aborting an avatar render stops further Comfy history polling',
  );

  await streamAvatarPrompt(
    `/api/personas/${persona.id}/avatar/prompt`,
    'Portrait of {{user}}: {{description}}',
    'Name: {{name}}\nAvatar details: {{description}}',
  );
  const { completion: personaCompletion } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as { completion: { system: string | null } };
  assert(
    personaCompletion.system === 'Portrait of Aiki: A performance-obsessed developer.',
    'persona avatar prompt macros expand from the persona fields',
  );

  await expectStatus(
    'POST',
    `/api/characters/${avatarChar.id}/avatar/prompt`,
    { prompt: '  ' },
    400,
  );
  await expectStatus('POST', '/api/characters/999999999/avatar/prompt', { prompt: 'x' }, 404);
  await expectStatus('POST', '/api/personas/999999999/avatar/prompt', { prompt: 'x' }, 404);
  await expectStatus('POST', '/api/avatar/render', { prompt: '  ', image: avatarImage }, 400);
  await expectStatus(
    'POST',
    '/api/avatar/render',
    { prompt: 'x', image: { workflow: '', comfyUrl: MOCK_CONTROL } },
    400,
  );
  await expectStatus(
    'POST',
    '/api/avatar/render',
    { prompt: 'x', image: { workflow: '{not json', comfyUrl: MOCK_CONTROL } },
    400,
  );
}
