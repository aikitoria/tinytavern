import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Conversation, Message } from '@minitavern/shared';
import {
  BASE,
  MOCK_CONTROL,
  assert,
  req,
  expectStatus,
  tree,
  branchBody,
  pathOf,
} from './helpers.ts';
import type { SetupFixture } from './setup.ts';
import type { TemplatesFixture } from './templates.ts';
import type { ChatFixture } from './chat.ts';

export async function testImages(
  fixture: Pick<SetupFixture, 'dataDir'> &
    Pick<TemplatesFixture, 'conv2'> &
    Pick<ChatFixture, 'ws'>,
) {
  const { dataDir, conv2, ws } = fixture;

  console.log('== comfy image rendering ==');
  const comfyDeleteCount = async () =>
    (
      (await (await fetch(`${MOCK_CONTROL}/control/comfy-deleted`)).json()) as {
        deleted: { filename: string; type: string }[];
      }
    ).deleted;
  const COMFY_WORKFLOW =
    '{"3":{"class_type":"KSampler","inputs":{"seed":{{seed}}}},"6":{"inputs":{"text":"{{prompt}}"}}}';
  const setNextComfyOutput = async (kind: string) => {
    const res = await fetch(
      `${MOCK_CONTROL}/control/comfy-output-next?kind=${encodeURIComponent(kind)}`,
      { method: 'POST' },
    );
    if (!res.ok) throw new Error(`could not configure mock Comfy output: ${await res.text()}`);
  };
  for (const [kind, mime] of [
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ] as const) {
    await setNextComfyOutput(kind);
    const response = await fetch(`${BASE}/api/avatar/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: `Render ${kind}`,
        image: { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL },
      }),
    });
    assert(
      response.ok && response.headers.get('content-type') === mime,
      `${kind} render bytes are accepted`,
    );
    await response.arrayBuffer();
  }
  const filesBeforeActiveContent = readdirSync(join(dataDir, 'images')).sort().join('\n');
  for (const kind of ['html', 'svg', 'polyglot']) {
    await setNextComfyOutput(kind);
    const response = await fetch(`${BASE}/api/avatar/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: `Reject ${kind}`,
        image: { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL },
      }),
    });
    assert(response.status === 502, `${kind} Comfy output is rejected`);
  }
  assert(
    readdirSync(join(dataDir, 'images')).sort().join('\n') === filesBeforeActiveContent,
    'rejected active-content renders create no generated files',
  );
  const deletesBeforeRender = (await comfyDeleteCount()).length;
  const imgSnap = await tree(conv2.id);
  const imgRes = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    {
      prompt: 'Depict this scene.',
      label: 'Image prompt',
      expectedActiveLeafId: imgSnap.activeLeafId,
      expectedMutationRevision: imgSnap.mutationRevision,
      image: { workflow: COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL },
    },
  );
  const pendingSnap = await tree(conv2.id);
  assert(
    pendingSnap.messages.find((m) => m.id === imgRes.toolMessageId)?.imagePending === true,
    'image render is flagged pending while the tool text streams',
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === imgRes.toolMessageId,
    'image tool text finished',
  );
  await ws.waitFor(
    (e) => e.t === 'imageProgress' && e.mid === imgRes.toolMessageId,
    'image render progress relayed to subscribers',
    15_000,
  );
  await ws.waitFor(
    (e) =>
      e.t === 'imageProgress' &&
      e.mid === imgRes.toolMessageId &&
      e.preview?.startsWith('data:image/jpeg;base64,') === true,
    'image render preview relayed to subscribers',
    15_000,
  );
  const waitForImageState = async (
    mid: number,
    pred: (m: Message) => boolean,
    label: string,
  ): Promise<Message> => {
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const message = (await tree(conv2.id)).messages.find((m) => m.id === mid);
      if (message && pred(message)) return message;
    }
    throw new Error(`timeout waiting for: ${label}`);
  };

  const renderedMessage = await waitForImageState(
    imgRes.toolMessageId,
    (message) => !message.imagePending && message.images.length > 0,
    'rendered image attached to the tool message',
  );
  const imageUrl = renderedMessage.images[0]!;
  assert(imageUrl?.startsWith('/images/'), 'rendered image attached to the tool message');
  const served = await fetch(`${BASE}${imageUrl}`);
  assert(
    served.ok &&
      served.headers.get('content-type') === 'image/png' &&
      served.headers.get('cache-control') === 'no-store' &&
      served.headers.get('x-content-type-options') === 'nosniff' &&
      served.headers.get('content-security-policy')?.includes("default-src 'none'") === true &&
      (await served.arrayBuffer()).byteLength > 0,
    'generated image is served with a raster MIME type and restrictive headers',
  );
  // ComfyUI cleanup is fire-and-forget, so poll for DELETE /view.
  let comfyDeletes = await comfyDeleteCount();
  const targetWasDeleted = () =>
    comfyDeletes
      .slice(deletesBeforeRender)
      .some((entry) => entry.filename === 'mock.png' && entry.type === 'output');
  for (let i = 0; i < 40 && !targetWasDeleted(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    comfyDeletes = await comfyDeleteCount();
  }
  assert(targetWasDeleted(), 'the downloaded output is deleted from ComfyUI');

  const { workflow: substituted } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-workflow`)
  ).json()) as {
    workflow: { 3: { inputs: { seed: unknown } }; 6: { inputs: { text: string } } };
  };
  assert(typeof substituted[3].inputs.seed === 'number', '{{seed}} substituted as a number');
  assert(
    substituted[6].inputs.text.includes('You said:') && substituted[6].inputs.text.includes('"'),
    '{{prompt}} carries the JSON-escaped description with quotes intact',
  );

  const firstSeed = substituted[3].inputs.seed;
  const CURRENT_COMFY_WORKFLOW =
    '{"3":{"class_type":"KSampler","inputs":{"seed":{{seed}}}},"6":{"inputs":{"text":"LATEST {{prompt}}"}}}';
  const originalImagePrompt = (await tree(conv2.id)).messages.find(
    (message) => message.id === imgRes.toolMessageId,
  )!.content;
  await req(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/render-image`,
    await branchBody(conv2.id, { workflow: CURRENT_COMFY_WORKFLOW, comfyUrl: MOCK_CONTROL }),
  );
  const pendingRerender = await tree(conv2.id);
  assert(
    pendingRerender.messages.find((message) => message.id === imgRes.toolMessageId)
      ?.imagePending === true,
    'image rerender is marked pending before returning to the client',
  );
  await expectStatus(
    'PATCH',
    `/api/messages/${imgRes.toolMessageId}`,
    {
      content: 'A stale prompt that must not replace the render input.',
      expectedActiveLeafId: pendingRerender.activeLeafId,
      expectedMutationRevision: pendingRerender.mutationRevision,
    },
    409,
  );
  const regenMsg = await waitForImageState(
    imgRes.toolMessageId,
    (message) => !message.imagePending && message.images.length === 2,
    'regenerated image is appended',
  );
  assert(
    regenMsg != null && regenMsg.activeImage === 1,
    'regenerated image is appended and selected',
  );
  assert(regenMsg.images[0] !== regenMsg.images[1], 'each render produces a distinct image file');
  assert(
    regenMsg.content === originalImagePrompt,
    'a pending image render cannot be attached to an edited prompt',
  );
  const { workflow: regenWorkflow } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-workflow`)
  ).json()) as {
    workflow: { 3: { inputs: { seed: unknown } }; 6: { inputs: { text: string } } };
  };
  assert(regenWorkflow[3].inputs.seed !== firstSeed, 'regeneration uses a fresh seed');
  assert(
    regenWorkflow[6].inputs.text.startsWith('LATEST '),
    'manual regeneration uses and stores the currently selected workflow',
  );
  const beforeImageSelection = await tree(conv2.id);
  await req('POST', `/api/messages/${imgRes.toolMessageId}/active-image`, {
    index: 0,
    expectedActiveLeafId: beforeImageSelection.activeLeafId,
    expectedMutationRevision: beforeImageSelection.mutationRevision,
  });
  await expectStatus(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/active-image`,
    {
      index: 1,
      expectedActiveLeafId: beforeImageSelection.activeLeafId,
      expectedMutationRevision: beforeImageSelection.mutationRevision,
    },
    409,
  );
  assert(
    (await tree(conv2.id)).messages.find((m) => m.id === imgRes.toolMessageId)?.activeImage === 0,
    'active image selection persists and a stale selection cannot overwrite it',
  );
  const secondImageUrl = regenMsg.images[1]!;

  const imageBranch = await req<Conversation>(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/branch-conversation`,
  );
  const imageBranchSnap = await tree(imageBranch.id);
  const branchedImageMessage = pathOf(imageBranchSnap).at(-1)!;
  assert(
    branchedImageMessage.images.length === regenMsg.images.length &&
      branchedImageMessage.images.every(
        (image, index) => image !== regenMsg.images[index] && image.startsWith('/images/'),
      ) &&
      (await fetch(`${BASE}${branchedImageMessage.images[0]}`)).status === 200,
    'branch to new conversation copies generated image files instead of sharing paths',
  );
  return {
    COMFY_WORKFLOW,
    setNextComfyOutput,
    imgRes,
    waitForImageState,
    imageUrl,
    regenMsg,
    secondImageUrl,
    imageBranch,
    branchedImageMessage,
  };
}

export type ImagesFixture = Awaited<ReturnType<typeof testImages>>;
