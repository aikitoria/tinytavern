import type { GalleryItem } from '@tinytavern/shared';
import {
  BASE,
  MOCK_CONTROL,
  assert,
  req,
  expectStatus,
  tree,
  fetchTrace,
  branchBody,
  branchBodyAt,
  branchQuery,
  branchPath,
  treeLinkShape,
} from './helpers.ts';
import type { TemplatesFixture } from './templates.ts';
import type { ImagesFixture } from './images.ts';
import type { ChatFixture } from './chat.ts';

export async function testImageRevisions(
  fixture: Pick<TemplatesFixture, 'conv2'> &
    Pick<
      ImagesFixture,
      'imgRes' | 'regenMsg' | 'waitForImageState' | 'imageUrl' | 'secondImageUrl'
    > &
    Pick<ChatFixture, 'ws'>,
) {
  const { conv2, imgRes, ws, regenMsg, waitForImageState, imageUrl, secondImageUrl } = fixture;

  console.log('== regenerate image tool with instruction ==');
  const imageRevisionTrace = await fetchTrace(conv2.id);
  const STEER_CURRENT_WORKFLOW =
    '{"3":{"class_type":"KSampler","inputs":{"seed":{{seed}}}},"6":{"inputs":{"text":"STEER-LATEST {{prompt}}"}}}';
  const steeredImage = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/regenerate`,
    await branchBody(conv2.id, {
      instruction: 'Make the scene moonlit.',
      image: { workflow: STEER_CURRENT_WORKFLOW, comfyUrl: MOCK_CONTROL },
    }),
  );
  const steeredImageFinal = await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === steeredImage.assistantMessageId,
    'steered image prompt finished',
  );
  const imageSteerSeen = (await (
    await fetch(`${MOCK_CONTROL}/control/last-completion`)
  ).json()) as {
    completion: {
      messages: { role: string; content: string; reasoning_content?: string }[];
      lastMessageRole: string | null;
      lastMessageContent: string | null;
    } | null;
  };
  assert(
    imageSteerSeen.completion?.messages.at(-2)?.role === 'assistant' &&
      imageSteerSeen.completion.messages.at(-2)?.content.includes('<original_image_prompt>') ===
        true &&
      imageSteerSeen.completion.messages.at(-2)?.content.includes(regenMsg.content) === true &&
      Boolean(imageSteerSeen.completion.messages.at(-2)?.reasoning_content),
    'image steer sends the original generated prompt and reasoning as the preceding assistant turn',
  );
  assert(
    imageSteerSeen.completion?.lastMessageRole === 'user' &&
      imageSteerSeen.completion.lastMessageContent?.includes('[IMAGE PROMPT REVISION TASK]') ===
        true &&
      imageSteerSeen.completion.lastMessageContent.includes('reference context only') &&
      imageSteerSeen.completion.lastMessageContent.includes('Do not continue the roleplay') &&
      imageSteerSeen.completion.lastMessageContent.includes('Do not modify anything else.') &&
      imageSteerSeen.completion.lastMessageContent.includes('immediately preceding assistant') &&
      imageSteerSeen.completion.lastMessageContent.includes('<revision_instruction>') &&
      imageSteerSeen.completion.lastMessageContent?.includes('Make the scene moonlit.') === true,
    'image steer clearly separates the original prompt from the constrained instruction',
  );
  assert(
    JSON.stringify(
      imageSteerSeen.completion?.messages.slice(0, imageRevisionTrace.messages.length),
    ) === JSON.stringify(imageRevisionTrace.messages),
    'image steer preserves the exact roleplay-history prefix for context and caching',
  );
  const imageSteerAlternating = imageSteerSeen.completion!.messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  );
  assert(
    imageSteerAlternating.every(
      (message, index) =>
        message.content.trim().length > 0 &&
        (index === 0 || message.role !== imageSteerAlternating[index - 1]!.role),
    ),
    'steered image request keeps contextual user/assistant history alternating',
  );
  assert(
    steeredImageFinal.t === 'final' &&
      steeredImageFinal.message.role === 'tool' &&
      steeredImageFinal.message.parentId === imgRes.toolMessageId &&
      steeredImageFinal.message.hasImageRender,
    'steered image prompt is appended after the source with its render configuration retained',
  );
  const steeredImageRendered = await waitForImageState(
    steeredImage.assistantMessageId,
    (message) => !message.imagePending && message.images.length === 1,
    'steered image prompt renders',
  );
  assert(steeredImageRendered != null, 'steered image prompt automatically renders a fresh image');
  const { workflow: steeredRenderWorkflow } = (await (
    await fetch(`${MOCK_CONTROL}/control/last-workflow`)
  ).json()) as { workflow: { 6: { inputs: { text: string } } } };
  assert(
    steeredRenderWorkflow[6].inputs.text.startsWith('STEER-LATEST '),
    'steered image regeneration uses the currently selected workflow',
  );
  // Restore the source image as the leaf for the following deletion checks.
  await req(
    'DELETE',
    await branchPath(
      conv2.id,
      `/api/messages/${steeredImage.assistantMessageId}`,
      steeredImage.assistantMessageId,
    ),
  );
  assert(
    (await tree(conv2.id)).activeLeafId === imgRes.toolMessageId,
    'removing the revised image returns to the source image message',
  );

  const chained = await req<{ toolMessageId: number }>(
    'POST',
    `/api/conversations/${conv2.id}/tool`,
    await branchBodyAt(conv2.id, imgRes.toolMessageId, {
      prompt: 'Another one.',
      label: 'Image prompt',
    }),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === chained.toolMessageId,
    'chained tool generation finished',
  );
  const chainSnap = await tree(conv2.id);
  assert(
    chainSnap.messages.find((m) => m.id === chained.toolMessageId)?.parentId ===
      imgRes.toolMessageId,
    'consecutive tool messages chain parent→child',
  );

  console.log('== regenerate image tool in the middle of an existing chain ==');
  const insertedRevision = await req<{ assistantMessageId: number }>(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/regenerate`,
    await branchBody(conv2.id, { instruction: 'Make the scene warmer.' }),
  );
  await ws.waitFor(
    (e) => e.t === 'final' && e.message.id === insertedRevision.assistantMessageId,
    'inserted image revision prompt finished',
  );
  const insertedSnap = await tree(conv2.id);
  const sourceAfterInsert = insertedSnap.messages.find((m) => m.id === imgRes.toolMessageId)!;
  const insertedMessage = insertedSnap.messages.find(
    (m) => m.id === insertedRevision.assistantMessageId,
  )!;
  const chainedAfterInsert = insertedSnap.messages.find((m) => m.id === chained.toolMessageId)!;
  assert(
    insertedMessage.parentId === imgRes.toolMessageId &&
      chainedAfterInsert.parentId === insertedMessage.id &&
      sourceAfterInsert.activeChildId === insertedMessage.id &&
      insertedMessage.activeChildId === chained.toolMessageId &&
      insertedSnap.activeLeafId === chained.toolMessageId,
    'image revision splices into the chain and preserves the active continuation',
  );
  const insertedRendered = await waitForImageState(
    insertedRevision.assistantMessageId,
    (message) => !message.imagePending && message.images.length === 1,
    'inserted image revision renders',
  );
  assert(insertedRendered != null, 'inserted image revision renders normally');
  const insertedCopy = await req<{ id: number }>(
    'POST',
    `/api/conversations/${conv2.id}/duplicate`,
  );
  assert(
    JSON.stringify(treeLinkShape(await tree(insertedCopy.id))) ===
      JSON.stringify(treeLinkShape(await tree(conv2.id))),
    'conversation duplicate preserves links through a newer inserted parent',
  );
  const beforeSoleSwipeDelete = await tree(conv2.id);
  await expectStatus(
    'DELETE',
    `/api/messages/${insertedRevision.assistantMessageId}/swipe?${branchQuery(beforeSoleSwipeDelete)}`,
    undefined,
    400,
  );
  assert(
    JSON.stringify(treeLinkShape(await tree(conv2.id))) ===
      JSON.stringify(treeLinkShape(beforeSoleSwipeDelete)),
    'Delete swipe rejects a sole child and preserves its continuation',
  );
  await req(
    'DELETE',
    await branchPath(
      conv2.id,
      `/api/messages/${insertedRevision.assistantMessageId}`,
      chained.toolMessageId,
    ),
  );
  const restoredChain = await tree(conv2.id);
  assert(
    restoredChain.messages.find((m) => m.id === chained.toolMessageId)?.parentId ===
      imgRes.toolMessageId && restoredChain.activeLeafId === chained.toolMessageId,
    'deleting the inserted revision restores the original chain',
  );

  const sourceBeforeImageSwipeDelete = restoredChain.messages.find(
    (message) => message.id === imgRes.toolMessageId,
  )!;
  const removedImageUrl =
    sourceBeforeImageSwipeDelete.images[sourceBeforeImageSwipeDelete.activeImage]!;
  const survivingImageUrl = sourceBeforeImageSwipeDelete.images.find(
    (_, index) => index !== sourceBeforeImageSwipeDelete.activeImage,
  )!;
  await req('POST', `/api/messages/${imgRes.toolMessageId}/delete-image`, {
    index: sourceBeforeImageSwipeDelete.activeImage,
    expectedActiveLeafId: restoredChain.activeLeafId,
    expectedMutationRevision: restoredChain.mutationRevision,
  });
  await expectStatus(
    'POST',
    `/api/messages/${imgRes.toolMessageId}/delete-image`,
    {
      index: 0,
      expectedActiveLeafId: restoredChain.activeLeafId,
      expectedMutationRevision: restoredChain.mutationRevision,
    },
    409,
  );
  const afterImageSwipeDelete = await tree(conv2.id);
  const sourceAfterImageSwipeDelete = afterImageSwipeDelete.messages.find(
    (message) => message.id === imgRes.toolMessageId,
  )!;
  assert(
    sourceAfterImageSwipeDelete.images.length === 1 &&
      sourceAfterImageSwipeDelete.images[0] === survivingImageUrl &&
      sourceAfterImageSwipeDelete.activeImage === 0 &&
      (await fetch(`${BASE}${removedImageUrl}`)).status === 404 &&
      (await fetch(`${BASE}${survivingImageUrl}`)).status === 200,
    'Delete swipe removes only the selected image file and selects the nearest survivor',
  );
  const individuallyDeletedGallery = await req<{ item: GalleryItem; created: boolean }>(
    'POST',
    '/api/gallery',
    { messageId: imgRes.toolMessageId, index: 0 },
  );
  const individuallyDeletedGalleryUrl = individuallyDeletedGallery.item.image;
  assert(
    individuallyDeletedGallery.created &&
      individuallyDeletedGalleryUrl !== survivingImageUrl &&
      (await fetch(`${BASE}${individuallyDeletedGalleryUrl}`)).status === 200,
    'a second source image can be saved as another independent gallery item',
  );

  const imgParent = chainSnap.messages.find((m) => m.id === imgRes.toolMessageId)!.parentId;
  await req(
    'DELETE',
    await branchPath(conv2.id, `/api/messages/${imgRes.toolMessageId}`, chained.toolMessageId),
  );
  const splicedSnap = await tree(conv2.id);
  const survivor = splicedSnap.messages.find((m) => m.id === chained.toolMessageId);
  assert(
    survivor?.parentId === imgParent && splicedSnap.activeLeafId === chained.toolMessageId,
    'deleting a tool message splices it out, keeping its descendants',
  );
  const afterDelete = await fetch(`${BASE}${imageUrl}`);
  const afterDelete2 = await fetch(`${BASE}${secondImageUrl}`);
  assert(
    afterDelete.status === 404 && afterDelete2.status === 404,
    'deleting the tool message deletes all its image files from disk',
  );

  return { individuallyDeletedGallery, individuallyDeletedGalleryUrl };
}

export type ImageRevisionsFixture = Awaited<ReturnType<typeof testImageRevisions>>;
