import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GalleryItem } from '@tinytavern/shared';
import {
  BASE,
  MOCK_CONTROL,
  assert,
  req,
  collectRenderProgress,
  expectStatus,
  tree,
  branchBody,
  branchBodyAt,
  branchPath,
  activate,
} from './helpers.ts';
import type { ImagesFixture } from './images.ts';
import type { TemplatesFixture } from './templates.ts';
import type { SetupFixture } from './setup.ts';

export async function testGallery(
  fixture: Pick<
    ImagesFixture,
    | 'branchedImageMessage'
    | 'imageBranch'
    | 'regenMsg'
    | 'imgRes'
    | 'setNextComfyOutput'
    | 'waitForImageState'
  > &
    Pick<TemplatesFixture, 'conv2'> &
    Pick<SetupFixture, 'dataDir'>,
) {
  const {
    branchedImageMessage,
    imageBranch,
    regenMsg,
    conv2,
    imgRes,
    setNextComfyOutput,
    dataDir,
    waitForImageState,
  } = fixture;

  console.log('== durable saved-image gallery ==');
  const savedGallery = await req<{ item: GalleryItem; created: boolean }>('POST', '/api/gallery', {
    messageId: branchedImageMessage.id,
    index: branchedImageMessage.activeImage,
  });
  const savedGalleryImageUrl = savedGallery.item.image;
  assert(
    savedGallery.created &&
      savedGallery.item.prompt === branchedImageMessage.content &&
      savedGallery.item.sourceConversationId === imageBranch.id &&
      savedGallery.item.sourceMessageId === branchedImageMessage.id &&
      savedGallery.item.sourceImage ===
        branchedImageMessage.images[branchedImageMessage.activeImage] &&
      savedGalleryImageUrl !== branchedImageMessage.images[branchedImageMessage.activeImage] &&
      (await fetch(`${BASE}${savedGalleryImageUrl}`)).status === 200,
    'saving an image swipe copies its file and snapshots its prompt and source metadata',
  );
  const savedAgain = await req<{ item: GalleryItem; created: boolean }>('POST', '/api/gallery', {
    messageId: branchedImageMessage.id,
    index: branchedImageMessage.activeImage,
  });
  assert(
    !savedAgain.created && savedAgain.item.id === savedGallery.item.id,
    'saving the same source swipe is idempotent',
  );
  await expectStatus(
    'POST',
    '/api/gallery',
    { messageId: branchedImageMessage.id, index: 999 },
    400,
  );
  await req(
    'DELETE',
    `/api/conversations/${imageBranch.id}?expectedActiveLeafId=${imageBranch.activeLeafId}&expectedMutationRevision=${imageBranch.mutationRevision}`,
  );
  assert(
    (await fetch(`${BASE}${branchedImageMessage.images[0]}`)).status === 404 &&
      (await fetch(`${BASE}${regenMsg.images[0]}`)).status === 200,
    'deleting a branched conversation removes only its copied image files',
  );
  const detachedGallery = (await req<GalleryItem[]>('GET', '/api/gallery')).find(
    (item) => item.id === savedGallery.item.id,
  )!;
  assert(
    detachedGallery.sourceConversationId === null &&
      detachedGallery.sourceMessageId === null &&
      detachedGallery.prompt === branchedImageMessage.content &&
      (await fetch(`${BASE}${savedGalleryImageUrl}`)).status === 200,
    'deleting the source conversation detaches links but preserves the saved image and prompt',
  );
  const galleryRevisionInstruction = 'change only the lighting to a warm sunset';
  await expectStatus(
    'POST',
    `/api/gallery/${savedGallery.item.id}/revise-prompt`,
    { prompt: savedGallery.item.prompt, instruction: '   ' },
    400,
  );
  const galleryRevisionResponse = await fetch(
    `${BASE}/api/gallery/${savedGallery.item.id}/revise-prompt`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: savedGallery.item.prompt,
        instruction: galleryRevisionInstruction,
      }),
    },
  );
  assert(
    galleryRevisionResponse.ok &&
      galleryRevisionResponse.headers.get('content-type')?.includes('text/event-stream') === true,
    'gallery prompt revision responds with SSE',
  );
  let galleryRevisedPrompt = '';
  let galleryRevisionDone = false;
  let galleryRevisionError = '';
  for (const line of (await galleryRevisionResponse.text()).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const event = JSON.parse(line.slice(5)) as { d?: string; error?: string; done?: boolean };
    if (event.d) galleryRevisedPrompt += event.d;
    if (event.error) galleryRevisionError = event.error;
    if (event.done) galleryRevisionDone = true;
  }
  assert(
    galleryRevisionDone && !galleryRevisionError && galleryRevisedPrompt.trim().length > 0,
    'gallery prompt revision streams a complete replacement prompt',
  );
  const galleryRevisionCompletion = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: {
      messages: { role: string; content: string }[];
    } | null;
  };
  assert(
    galleryRevisionCompletion.completion?.messages.map((message) => message.role).join(',') ===
      'user,assistant,user' &&
      galleryRevisionCompletion.completion.messages[1]?.content ===
        `<original_image_prompt>\n${savedGallery.item.prompt}\n</original_image_prompt>` &&
      galleryRevisionCompletion.completion.messages[2]?.content.includes(
        `<revision_instruction>\n${galleryRevisionInstruction}\n</revision_instruction>`,
      ) === true,
    'gallery prompt revision reuses the alternating-safe image edit task without chat context',
  );
  const galleryJobId = 'e2e-gallery-job';
  const galleryProgressAbort = new AbortController();
  const galleryProgressResponse = await fetch(
    `${BASE}/api/gallery/render-progress/${galleryJobId}`,
    { signal: galleryProgressAbort.signal },
  );
  assert(
    galleryProgressResponse.ok && galleryProgressResponse.body != null,
    'gallery render progress SSE opens',
  );
  await expectStatus(
    'POST',
    `/api/gallery/${savedGallery.item.id}/render-image`,
    { prompt: '   ' },
    400,
  );
  const galleryProgressSeen = collectRenderProgress(galleryProgressResponse, 'gallery progress');
  const galleryGenerated = await req<GalleryItem>(
    'POST',
    `/api/gallery/${savedGallery.item.id}/render-image`,
    { jobId: galleryJobId, prompt: galleryRevisedPrompt },
  );
  await galleryProgressSeen;
  galleryProgressAbort.abort();
  const generatedGalleryImageUrl = galleryGenerated.image;
  assert(
    galleryGenerated.id !== savedGallery.item.id &&
      galleryGenerated.prompt === galleryRevisedPrompt.trim() &&
      galleryGenerated.characterName === savedGallery.item.characterName &&
      galleryGenerated.sourceConversationId === null &&
      galleryGenerated.sourceMessageId === null &&
      generatedGalleryImageUrl !== savedGalleryImageUrl &&
      (await fetch(`${BASE}${generatedGalleryImageUrl}`)).status === 200,
    'gallery generation creates a separate saved image from the regenerated prompt instead of a swipe',
  );
  assert(
    (await req<GalleryItem[]>('GET', '/api/gallery')).some(
      (item) => item.id === savedGallery.item.id && item.image === savedGalleryImageUrl,
    ),
    'creating the new gallery image leaves its source gallery item unchanged',
  );

  const beforeImageBranchSwitch = await tree(conv2.id);
  const imageDuplicate = await req<{ messageId: number }>(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/duplicate`,
    {
      expectedActiveLeafId: beforeImageBranchSwitch.activeLeafId,
      expectedMutationRevision: beforeImageBranchSwitch.mutationRevision,
    },
  );
  const imageOffPath = await tree(conv2.id);
  const sourceBeforeImageCopy = beforeImageBranchSwitch.messages.find(
    (message) => message.id === imgRes.toolMessageId,
  )!;
  const duplicatedImageMessage = imageOffPath.messages.find(
    (message) => message.id === imageDuplicate.messageId,
  )!;
  const duplicatedImageUrls = duplicatedImageMessage.images;
  assert(
    duplicatedImageUrls.length === sourceBeforeImageCopy.images.length &&
      duplicatedImageUrls.every(
        (image, index) =>
          image !== sourceBeforeImageCopy.images[index] && image.startsWith('/images/'),
      ) &&
      duplicatedImageMessage.activeImage === sourceBeforeImageCopy.activeImage &&
      duplicatedImageMessage.parentId === imgRes.toolMessageId &&
      imageOffPath.messages.find((message) => message.id === imgRes.toolMessageId)
        ?.activeChildId === imageDuplicate.messageId &&
      imageOffPath.activeLeafId === imageDuplicate.messageId &&
      (await fetch(`${BASE}${duplicatedImageUrls[0]}`)).status === 200,
    'image duplicate inserts below its source with copied images and active selection',
  );
  await expectStatus(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/render-image`,
    {
      expectedActiveLeafId: beforeImageBranchSwitch.activeLeafId,
      expectedMutationRevision: beforeImageBranchSwitch.mutationRevision,
    },
    409,
  );
  await req(
    'DELETE',
    await branchPath(
      conv2.id,
      `/api/messages/${imageDuplicate.messageId}`,
      imageDuplicate.messageId,
    ),
  );
  const afterImageDuplicateDelete = await tree(conv2.id);
  assert(
    (await Promise.all(duplicatedImageUrls.map((image) => fetch(`${BASE}${image}`)))).every(
      (response) => response.status === 404,
    ) &&
      (
        await Promise.all(sourceBeforeImageCopy.images.map((image) => fetch(`${BASE}${image}`)))
      ).every((response) => response.status === 200) &&
      afterImageDuplicateDelete.activeLeafId === imgRes.toolMessageId,
    'deleting an inserted image duplicate restores the source and removes only copied files',
  );

  // Even a current snapshot cannot render or change image selection on an inactive branch.
  const inactiveImageBranch = await req<{ messageId: number }>(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/edit-branch`,
    await branchBodyAt(conv2.id, imgRes.toolMessageId, { content: 'Inactive image branch' }),
  );
  const inactiveImageSnap = await tree(conv2.id);
  await expectStatus(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/render-image`,
    {
      expectedActiveLeafId: inactiveImageSnap.activeLeafId,
      expectedMutationRevision: inactiveImageSnap.mutationRevision,
    },
    400,
  );
  await expectStatus(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/active-image`,
    {
      index: 1,
      expectedActiveLeafId: inactiveImageSnap.activeLeafId,
      expectedMutationRevision: inactiveImageSnap.mutationRevision,
    },
    400,
  );
  await activate(conv2.id, imgRes.toolMessageId);
  await req(
    'DELETE',
    await branchPath(
      conv2.id,
      `/api/messages/${inactiveImageBranch.messageId}/swipe`,
      imgRes.toolMessageId,
    ),
  );

  await setNextComfyOutput('html');
  const filesBeforeRejectedMessageRender = readdirSync(join(dataDir, 'images')).sort().join('\n');
  await req(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/render-image`,
    await branchBody(conv2.id),
  );
  const rejectedMessageRender = await waitForImageState(
    imgRes.toolMessageId,
    (message) => !message.imagePending && !!message.genMeta?.imageError,
    'invalid raster render is rejected',
  );
  assert(
    rejectedMessageRender?.images.length === 2 &&
      rejectedMessageRender.genMeta?.imageError?.includes('unsupported or invalid raster image') ===
        true &&
      readdirSync(join(dataDir, 'images')).sort().join('\n') === filesBeforeRejectedMessageRender,
    'rejected active content creates no image reference or local file',
  );

  return { savedGallery, savedGalleryImageUrl, galleryGenerated, generatedGalleryImageUrl };
}

export type GalleryFixture = Awaited<ReturnType<typeof testGallery>>;
