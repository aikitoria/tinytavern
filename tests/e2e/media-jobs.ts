import type { GalleryItem, MediaJob, Settings } from '@tinytavern/shared';
import {
  BASE,
  WsClient,
  MOCK_CONTROL,
  assert,
  branchBody,
  branchQuery,
  expectStatus,
  putSettings,
  req,
  tree,
} from './helpers.ts';
import { setTimeout as sleep } from 'node:timers/promises';

export async function waitForJob(
  id: string,
  state: MediaJob['state'],
  ws?: WsClient,
): Promise<MediaJob> {
  if (ws) {
    const event = await ws.waitFor(
      (event) => event.t === 'mediaJob' && event.job.id === id && event.job.state === state,
      `Media job ${id} reaches ${state}`,
    );
    if (event.t !== 'mediaJob') throw new Error('Expected a media job update');
    return event.job;
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const job = await req<MediaJob>('GET', `/api/media/jobs/${id}`);
    if (job.state === state) {
      return job;
    }
    await sleep(40);
  }
  throw new Error(`Media job ${id} did not reach ${state}`);
}

export async function testMediaJobs(): Promise<void> {
  console.log('== durable media job API ==');
  const ws = new WsClient();
  await ws.open();
  const previous = await req<Settings>('GET', '/api/settings');
  const jobIds: string[] = [];
  const conversationIds: number[] = [];
  const resultPaths = new Set<string>();
  try {
    await putSettings({
      mediaRendering: {
        comfyUrl: MOCK_CONTROL,
        workflows: [
          {
            id: 'media-e2e',
            name: 'Media E2E',
            operation: 'image',
            referenceCount: 0,
            json: '{"6":{"inputs":{"text":"{{prompt}}","seed":{{seed}}}},"9":{"class_type":"SaveImage","inputs":{"filename_prefix":"{{job_id}}"}}}',
            galleryPromptPresetId: null,
            chatPromptPresetId: null,
          },
        ],
        defaults: { 'image:0': 'media-e2e' },
        avatarWorkflowId: null,
        jobTimeoutSeconds: 60,
      },
    });
    const pending = await req<MediaJob>('POST', '/api/media/jobs', {
      requestKey: 'media-e2e-pending',
      operation: 'image',
      prompt: 'An unfinished draft',
    });
    jobIds.push(pending.id);
    const body = {
      requestKey: 'media-e2e-create',
      operation: 'image',
      prompt: 'An evening forest',
    };
    const draft = await req<MediaJob>('POST', '/api/media/jobs', body);
    jobIds.push(draft.id);
    const duplicate = await req<MediaJob>('POST', '/api/media/jobs', body);
    assert(duplicate.id === draft.id, 'draft request keys prevent duplicate jobs');
    await expectStatus('POST', `/api/media/jobs/${draft.id}/render`, {}, 400);
    const rendering = await req<MediaJob>('POST', `/api/media/jobs/${draft.id}/render`, {
      expectedRevision: draft.revision,
    });
    assert(rendering.state === 'submitting', 'render requests return before background execution');
    await expectStatus(
      'PATCH',
      `/api/media/jobs/${draft.id}`,
      {
        expectedRevision: draft.revision,
        prompt: 'A stale edit',
      },
      409,
    );
    const completed = await waitForJob(draft.id, 'succeeded', ws);
    assert(completed.outputs.length === 1, 'completed jobs expose their saved output');
    assert(
      !(await req<MediaJob[]>('GET', '/api/media/jobs')).some((job) => job.id === completed.id),
      'automatically saved results leave the jobs list',
    );
    await expectStatus('GET', `/api/media/jobs/${completed.id}`, undefined, 404);
    await ws.waitFor(
      (event) => event.t === 'mediaJobDeleted' && event.id === completed.id,
      'automatic saves notify clients of job deletion',
    );
    jobIds.splice(jobIds.indexOf(completed.id), 1);
    const output = completed.outputs[0]!;
    resultPaths.add(output.url);
    const range = await fetch(`${BASE}${output.url}`, { headers: { range: 'bytes=0-7' } });
    assert(range.status === 206, 'media responses support byte ranges');
    assert(
      (await range.arrayBuffer()).byteLength === 8,
      'range responses contain only requested bytes',
    );
    const gallery = await req<GalleryItem[]>('GET', '/api/gallery');
    assert(
      gallery.some((item) => item.media?.id === output.id),
      'standalone job output appears in the gallery',
    );

    const next = await req<MediaJob>('POST', `/api/media/assets/${output.id}/rerun`, {
      requestKey: 'media-e2e-rerun',
    });
    jobIds.push(next.id);
    assert(
      next.workflowSnapshot?.id === 'media-e2e' && next.state === 'draft',
      'saved assets rerun from their recipe after the job is deleted',
    );
    const started = await req<MediaJob>('POST', `/api/media/jobs/${next.id}/render`, {
      expectedRevision: next.revision,
    });
    const current = await waitForJob(started.id, 'queued');
    await req('POST', `/api/media/jobs/${current.id}/cancel`, {
      expectedRevision: current.revision,
    });
    await waitForJob(current.id, 'cancelled');
    const active = await req<MediaJob[]>('GET', '/api/media/jobs/active');
    assert(!active.some((job) => job.id === current.id), 'cancelled jobs leave the active list');

    const firstPage = await req<MediaJob[]>('GET', '/api/media/jobs?limit=1');
    const cursor = firstPage[0]!;
    const nextPage = await req<MediaJob[]>(
      'GET',
      `/api/media/jobs?limit=1&before=${encodeURIComponent(`${cursor.createdAt}:${cursor.id}`)}`,
    );
    assert(
      cursor.id === current.id && nextPage.length === 1 && nextPage[0]!.id === pending.id,
      'history pagination keeps cancelled and pending jobs while skipping saved successes',
    );

    const recipeRerun = await req<MediaJob>('POST', `/api/media/assets/${output.id}/rerun`, {
      requestKey: 'media-e2e-recipe-rerun',
    });
    jobIds.push(recipeRerun.id);
    assert(
      recipeRerun.workflowSnapshot?.id === 'media-e2e',
      'asset recipe endpoint restores a workflow after job history removal',
    );

    console.log('== review media variations before accepting ==');
    const reviewChat = await req<{ id: number }>('POST', '/api/conversations', {});
    conversationIds.push(reviewChat.id);
    const beforeReview = await tree(reviewChat.id);
    const reviewDraft = await req<MediaJob>('POST', '/api/media/jobs', {
      requestKey: 'review-first',
      operation: 'image',
      prompt: 'First candidate',
      contextConversationId: reviewChat.id,
      destination: 'chat',
      reviewBeforeSave: true,
    });
    jobIds.push(reviewDraft.id);
    await req('POST', `/api/media/jobs/${reviewDraft.id}/render`, {
      expectedRevision: reviewDraft.revision,
    });
    const firstCandidate = await waitForJob(reviewDraft.id, 'succeeded', ws);
    const another = await req<MediaJob>('POST', `/api/media/jobs/${firstCandidate.id}/rerun`, {
      requestKey: 'review-second',
      expectedRevision: firstCandidate.revision,
      prompt: 'Second candidate',
    });
    jobIds.push(another.id);
    await req('POST', `/api/media/jobs/${another.id}/render`, {
      expectedRevision: another.revision,
    });
    const secondCandidate = await waitForJob(another.id, 'succeeded', ws);
    const reviewHistory = await req<MediaJob[]>('GET', '/api/media/jobs');
    assert(
      [firstCandidate, secondCandidate].every((candidate) =>
        reviewHistory.some((job) => job.id === candidate.id),
      ),
      'completed variations remain in the jobs list until accepted',
    );
    assert(
      (await tree(reviewChat.id)).messages.length === beforeReview.messages.length,
      'trying variations creates no chat messages',
    );
    assert(
      !(await req<GalleryItem[]>('GET', '/api/gallery')).some((item) =>
        [firstCandidate.outputs[0]!.id, secondCandidate.outputs[0]!.id].includes(item.media!.id),
      ),
      'unaccepted variations do not enter the gallery',
    );
    const selected = await req<MediaJob>('POST', `/api/media/jobs/${another.id}/select`, {
      expectedRevision: secondCandidate.revision,
      expectedDraftRevision: secondCandidate.draft!.revision,
      assetId: firstCandidate.outputs[0]!.id,
    });
    const variations = await req<MediaJob[]>('GET', `/api/media/jobs/${another.id}/variations`);
    assert(
      variations.length === 2 &&
        variations.every((item) => item.draft?.selectedAssetId === firstCandidate.outputs[0]!.id),
      'reopening a draft restores all variations and the selected result',
    );
    const accepted = await req<MediaJob>(
      'POST',
      `/api/media/jobs/${another.id}/accept`,
      await branchBody(reviewChat.id, {
        expectedRevision: selected.revision,
        expectedDraftRevision: selected.draft!.revision,
        assetId: firstCandidate.outputs[0]!.id,
      }),
    );
    jobIds.splice(jobIds.indexOf(another.id), 1);
    jobIds.splice(jobIds.indexOf(firstCandidate.id), 1);
    await expectStatus('GET', `/api/media/jobs/${accepted.id}`, undefined, 404);
    await ws.waitFor(
      (event) => event.t === 'mediaJobDeleted' && event.id === accepted.id,
      'acceptance notifies clients of the chosen job deletion',
    );
    assert(
      !(await req<MediaJob[]>('GET', '/api/media/jobs')).some(
        (job) => job.draft?.id === accepted.draft!.id,
      ),
      'accepting a result removes its draft from the jobs list',
    );
    const acceptedTree = await tree(reviewChat.id);
    const acceptedMessage = acceptedTree.messages.find((item) => item.id === accepted.messageId)!;
    assert(
      acceptedTree.messages.length === beforeReview.messages.length + 1 &&
        acceptedMessage.content === 'First candidate' &&
        acceptedMessage.images.length === 1 &&
        acceptedMessage.media?.[0]?.id === firstCandidate.outputs[0]!.id,
      'accepting an earlier candidate inserts exactly its prompt and selected media',
    );
    assert(
      (await fetch(`${BASE}${secondCandidate.outputs[0]!.url}`)).status === 404,
      'acceptance deletes the discarded variation file',
    );
    await expectStatus('GET', `/api/media/jobs/${another.id}`, undefined, 404);

    console.log('== media images use normal chat swipes ==');
    const conversation = await req<{ id: number }>('POST', '/api/conversations', {});
    conversationIds.push(conversation.id);
    const chatDraft = await req<MediaJob>('POST', '/api/media/jobs', {
      requestKey: 'media-chat-image',
      operation: 'image',
      prompt: 'A moonlit forest with literal {{seed}} text',
      contextConversationId: conversation.id,
      destination: 'chat',
    });
    jobIds.push(chatDraft.id);
    await req(
      'POST',
      `/api/media/jobs/${chatDraft.id}/render`,
      await branchBody(conversation.id, {
        expectedRevision: chatDraft.revision,
      }),
    );
    const chatResult = await waitForJob(chatDraft.id, 'succeeded', ws);
    const beforeSwipe = await tree(conversation.id);
    const message = beforeSwipe.messages.find((item) => item.id === chatResult.messageId)!;
    assert(
      message.hasImageRender && message.media?.[0]?.recipeId != null,
      'media-tool image messages retain the shared rendering recipe',
    );
    await expectStatus('GET', `/api/media/jobs/${chatResult.id}`, undefined, 404);
    jobIds.splice(jobIds.indexOf(chatResult.id), 1);
    await putSettings({
      mediaRendering: {
        ...previous.mediaRendering,
        workflows: [],
        defaults: {},
        avatarWorkflowId: null,
      },
    });

    const swipeBody = await branchBody(conversation.id);
    const swipe = await req<{ jobId: string }>(
      'POST',
      `/api/messages/${message.id}/render-image`,
      swipeBody,
    );
    jobIds.push(swipe.jobId);
    await expectStatus('POST', `/api/messages/${message.id}/render-image`, swipeBody, 409);
    await expectStatus(
      'POST',
      `/api/messages/${message.id}/render-image`,
      await branchBody(conversation.id),
      409,
    );
    const alternative = await waitForJob(swipe.jobId, 'succeeded', ws);
    await expectStatus('GET', `/api/media/jobs/${swipe.jobId}`, undefined, 404);
    jobIds.splice(jobIds.indexOf(swipe.jobId), 1);
    const afterSwipe = await tree(conversation.id);
    const updated = afterSwipe.messages.find((item) => item.id === message.id)!;
    assert(
      afterSwipe.messages.length === beforeSwipe.messages.length &&
        afterSwipe.activeLeafId === beforeSwipe.activeLeafId,
      'swiping a media image keeps the existing tool message and active branch',
    );
    assert(
      updated.images.length === 2 &&
        updated.activeImage === 1 &&
        updated.images[0] === message.images[0],
      'the fresh render is appended and selected as an image alternative',
    );
    assert(
      alternative.prompt === message.content &&
        JSON.stringify(alternative.workflowSnapshot) ===
          JSON.stringify(chatResult.workflowSnapshot),
      'image swipes preserve the prompt and full recipe after workflow and history deletion',
    );
    await req(
      'POST',
      `/api/messages/${message.id}/active-image`,
      await branchBody(conversation.id, { index: 0 }),
    );
    const restored = (await tree(conversation.id)).messages.find((item) => item.id === message.id)!;
    assert(
      restored.activeImage === 0,
      'the original media image remains selectable with normal swipe navigation',
    );
  } finally {
    ws.close();
    for (const id of jobIds) {
      const job = await req<MediaJob>('GET', `/api/media/jobs/${id}`);
      await req('DELETE', `/api/media/jobs/${id}?expectedRevision=${job.revision}`);
    }
    const gallery = await req<GalleryItem[]>('GET', '/api/gallery');
    for (const item of gallery) {
      if (resultPaths.has(item.image)) {
        await req('DELETE', `/api/gallery/${item.id}`);
      }
    }
    for (const id of conversationIds) {
      await req('DELETE', `/api/conversations/${id}?${branchQuery(await tree(id))}`);
    }
    await putSettings({ mediaRendering: previous.mediaRendering });
  }
}
