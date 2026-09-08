import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GalleryItem, MediaJob } from '@tinytavern/shared';
import {
  BASE,
  assert,
  req,
  expectStatus,
  tree,
  branchBody,
  branchBodyAt,
  branchPath,
  activate,
} from './helpers.ts';
import { waitForJob } from './media-jobs.ts';
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
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
  const jpeg = readFileSync(new URL('../fixtures/image.jpg', import.meta.url));
  const uploaded: GalleryItem[] = [];
  for (const [bytes, ext] of [
    [png, 'png'],
    [jpeg, 'jpg'],
    [webp, 'webp'],
  ] as const) {
    const response = await fetch(`${BASE}/api/gallery/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    assert(response.status === 200, `upload accepts ${ext} by its bytes`);
    const item = (await response.json()) as GalleryItem;
    uploaded.push(item);
    const download = await fetch(`${BASE}${item.image}`);
    assert(
      item.characterName === 'Uploads' &&
        item.characters.length === 0 &&
        item.sourceMessageId === null &&
        item.sourceConversationId === null &&
        !item.media?.recipeId &&
        item.image.endsWith(`.${ext}`) &&
        item.imageWidth! > 0 &&
        item.imageHeight! > 0 &&
        Buffer.from(await download.arrayBuffer()).equals(bytes),
      `uploaded ${ext} retains its original bytes and dimensions without source ownership`,
    );
  }
  const uploadedPrompt =
    '  An uploaded landscape\nwith **literal markdown** and {{reference1_prompt}}.  ';
  const editedUpload = await req<GalleryItem>('PATCH', `/api/gallery/${uploaded[0]!.id}`, {
    prompt: uploadedPrompt,
    expectedPrompt: '',
  });
  assert(
    editedUpload.prompt === uploadedPrompt && !editedUpload.media?.recipeId,
    'uploaded image saves verbatim prompt without inventing a generation recipe',
  );
  await expectStatus(
    'PATCH',
    `/api/gallery/${editedUpload.id}`,
    {
      prompt: 'Stale edit',
      expectedPrompt: '',
    },
    409,
  );
  await expectStatus('PATCH', `/api/gallery/${editedUpload.id}`, { prompt: 'Missing guard' }, 400);
  await expectStatus(
    'PATCH',
    `/api/gallery/${editedUpload.id}`,
    {
      prompt: 123,
      expectedPrompt: uploadedPrompt,
    },
    400,
  );
  assert(
    (await req<GalleryItem[]>('GET', '/api/gallery')).find((item) => item.id === editedUpload.id)
      ?.prompt === uploadedPrompt,
    'saved prompt survives reload and rejected stale writes',
  );
  const clearedUpload = await req<GalleryItem>('PATCH', `/api/gallery/${editedUpload.id}`, {
    prompt: '',
    expectedPrompt: uploadedPrompt,
  });
  assert(clearedUpload.prompt === '', 'saved prompts can be cleared');

  const uploadCharacter = await req<{ id: number }>('POST', '/api/characters', {
    name: 'Upload owner',
  });
  const secondCharacter = await req<{ id: number }>('POST', '/api/characters', {
    name: 'Second owner',
  });
  const organized = await req<GalleryItem>('PATCH', `/api/gallery/${clearedUpload.id}`, {
    characterIds: [uploadCharacter.id, secondCharacter.id, uploadCharacter.id],
    expectedCharacterIds: [],
    prompt: 'Organized prompt',
    expectedPrompt: '',
  });
  assert(
    organized.characters.length === 2 && organized.characterName === 'Second owner, Upload owner',
    'gallery media can belong to multiple characters without duplicate associations',
  );
  assert(
    organized.image === clearedUpload.image &&
      organized.sourceMessageId === clearedUpload.sourceMessageId,
    'organizing media preserves the original asset and provenance',
  );
  await expectStatus(
    'PATCH',
    `/api/gallery/${organized.id}`,
    {
      characterIds: [],
      expectedCharacterIds: [],
      prompt: 'Stale change',
      expectedPrompt: 'Organized prompt',
    },
    409,
  );
  await expectStatus(
    'PATCH',
    `/api/gallery/${organized.id}`,
    {
      characterIds: [99999999],
      expectedCharacterIds: organized.characters.map((character) => character.id),
    },
    404,
  );
  await expectStatus(
    'PATCH',
    `/api/gallery/${organized.id}`,
    { characterIds: [uploadCharacter.id] },
    400,
  );
  const retainedOrganization = (await req<GalleryItem[]>('GET', '/api/gallery')).find(
    (item) => item.id === organized.id,
  )!;
  assert(
    retainedOrganization.prompt === 'Organized prompt' &&
      retainedOrganization.characters.length === 2,
    'rejected organization changes are atomic and associations survive reload',
  );
  const unassigned = await req<GalleryItem>('PATCH', `/api/gallery/${organized.id}`, {
    characterIds: [],
    expectedCharacterIds: organized.characters.map((character) => character.id),
  });
  assert(
    unassigned.characters.length === 0 &&
      unassigned.characterName === 'Uploads' &&
      unassigned.prompt === 'Organized prompt',
    'clearing associations keeps uploaded media and its prompt',
  );
  await req('DELETE', `/api/characters/${secondCharacter.id}`);
  const assignedResponse = await fetch(
    `${BASE}/api/gallery/upload?characterId=${uploadCharacter.id}`,
    {
      method: 'POST',
      body: png,
    },
  );
  const assigned = (await assignedResponse.json()) as GalleryItem;
  assert(
    assignedResponse.ok &&
      assigned.characters.some((character) => character.id === uploadCharacter.id) &&
      assigned.characterName === 'Upload owner',
    'upload can use the selected character',
  );
  await req('DELETE', `/api/characters/${uploadCharacter.id}`);
  const detachedUpload = (await req<GalleryItem[]>('GET', '/api/gallery')).find(
    (item) => item.id === assigned.id,
  )!;
  assert(
    detachedUpload.characters.length === 0 &&
      detachedUpload.characterName === 'Upload owner' &&
      (await fetch(`${BASE}${assigned.image}`)).ok,
    'character deletion preserves uploads and their saved identity',
  );
  const beforeRejectedUploads = readdirSync(join(dataDir, 'images'))
    .filter((name) => !name.startsWith('thumb-'))
    .sort()
    .join('\n');
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from('<svg onload="alert(1)"></svg>'),
    png.subarray(0, 30),
    Buffer.concat([png, Buffer.from('<script>bad</script>')]),
  ]) {
    const response = await fetch(`${BASE}/api/gallery/upload`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    });
    assert(
      response.status === 400,
      'upload rejects empty, active-content, truncated and trailing-content files',
    );
  }
  for (const value of ['0', '-1', 'invalid', '999999999']) {
    const response = await fetch(`${BASE}/api/gallery/upload?characterId=${value}`, {
      method: 'POST',
      body: png,
    });
    assert(
      response.status === (value === '999999999' ? 404 : 400),
      'upload validates the character before saving',
    );
  }
  assert(
    readdirSync(join(dataDir, 'images'))
      .filter((name) => !name.startsWith('thumb-'))
      .sort()
      .join('\n') === beforeRejectedUploads,
    'rejected uploads leave no files',
  );
  await req('POST', '/api/gallery/bulk-delete', {
    ids: [...uploaded.map((item) => item.id), assigned.id],
  });
  assert(
    (await Promise.all([...uploaded, assigned].map((item) => fetch(`${BASE}${item.image}`)))).every(
      (response) => response.status === 404,
    ),
    'bulk deletion removes uploaded originals',
  );
  const savedGallery = await req<{ item: GalleryItem; created: boolean }>('POST', '/api/gallery', {
    messageId: branchedImageMessage.id,
    index: branchedImageMessage.activeImage,
  });
  const savedGalleryImageUrl = savedGallery.item.image;
  assert(
    savedGallery.created &&
      savedGallery.item.imageWidth! > 0 &&
      savedGallery.item.imageHeight! > 0 &&
      savedGallery.item.prompt === branchedImageMessage.content &&
      savedGallery.item.sourceConversationId === imageBranch.id &&
      savedGallery.item.sourceMessageId === branchedImageMessage.id &&
      savedGallery.item.sourceImage ===
        branchedImageMessage.media[branchedImageMessage.activeImage]!.url &&
      savedGalleryImageUrl !== branchedImageMessage.media[branchedImageMessage.activeImage]!.url &&
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
    await branchPath(
      imageBranch.id,
      `/api/conversations/${imageBranch.id}`,
      imageBranch.activeLeafId,
    ),
  );
  assert(
    (await fetch(`${BASE}${branchedImageMessage.media[0]!.url}`)).status === 404 &&
      (await fetch(`${BASE}${regenMsg.media[0]!.url}`)).status === 200,
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
  const galleryRevisedPrompt = 'A new gallery variation through the shared media tools';
  const editedGenerated = await req<GalleryItem>('PATCH', `/api/gallery/${savedGallery.item.id}`, {
    prompt: galleryRevisedPrompt,
    expectedPrompt: detachedGallery.prompt,
  });
  assert(
    editedGenerated.prompt === galleryRevisedPrompt &&
      editedGenerated.media?.recipeId === detachedGallery.media?.recipeId,
    'generated image prompt is editable without replacing its recipe',
  );

  const galleryDraft = await req<MediaJob>(
    'POST',
    `/api/media/assets/${savedGallery.item.media!.id}/rerun`,
    {
      requestKey: 'e2e-gallery-rerun',
      reviewBeforeSave: true,
    },
  );
  assert(
    galleryDraft.prompt === galleryRevisedPrompt,
    'Gallery rerun starts with the edited saved prompt',
  );
  await req('POST', `/api/media/jobs/${galleryDraft.id}/render`, {
    expectedRevision: galleryDraft.revision,
  });
  const completed = await waitForJob(galleryDraft.id, 'succeeded');
  assert(
    !(await req<GalleryItem[]>('GET', '/api/gallery')).some(
      (item) => item.media?.id === completed.outputs[0]!.id,
    ),
    'Gallery variations remain drafts until accepted',
  );
  const savedVariation = await req<MediaJob>('POST', `/api/media/jobs/${completed.id}/accept`, {
    expectedRevision: completed.revision,
    expectedDraftRevision: completed.draft!.revision,
    assetId: completed.outputs[0]!.id,
  });
  assert(savedVariation.draft!.state === 'open', 'Gallery save keeps the generation session open');
  await req('POST', `/api/media/jobs/${completed.id}/discard`, {
    expectedRevision: savedVariation.revision,
    expectedDraftRevision: savedVariation.draft!.revision,
  });
  const galleryGenerated = (await req<GalleryItem[]>('GET', '/api/gallery')).find(
    (item) => item.media?.id === completed.outputs[0]!.id,
  )!;
  const generatedGalleryImageUrl = galleryGenerated.image;
  assert(
    galleryGenerated.id !== savedGallery.item.id &&
      galleryGenerated.prompt === galleryRevisedPrompt,
    'Gallery rerun saves its selected result through the shared media flow',
  );
  assert(
    (await fetch(`${BASE}${generatedGalleryImageUrl}`)).status === 200,
    'The accepted gallery variation can be viewed',
  );
  assert(
    (await req<GalleryItem[]>('GET', '/api/gallery')).some(
      (item) => item.id === savedGallery.item.id && item.image === savedGalleryImageUrl,
    ),
    'Creating a variation leaves the original gallery item unchanged',
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
  const duplicatedImageUrls = duplicatedImageMessage.media.map((asset) => asset.url);
  assert(
    duplicatedImageUrls.length === sourceBeforeImageCopy.media.length &&
      duplicatedImageUrls.every(
        (image, index) =>
          image !== sourceBeforeImageCopy.media[index]!.url && image.startsWith('/images/'),
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
        await Promise.all(sourceBeforeImageCopy.media.map((asset) => fetch(`${BASE}${asset.url}`)))
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
  const filesBeforeRejectedMessageRender = readdirSync(join(dataDir, 'images'))
    .filter((name) => !name.startsWith('thumb-'))
    .sort()
    .join('\n');
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
    rejectedMessageRender?.media.length === 2,
    'rejected active content creates no image reference',
  );
  assert(
    /invalid raster image|no final image/.test(rejectedMessageRender.genMeta?.imageError ?? ''),
    `invalid raster rejection explains the error: ${rejectedMessageRender.genMeta?.imageError}`,
  );
  assert(
    readdirSync(join(dataDir, 'images'))
      .filter((name) => !name.startsWith('thumb-'))
      .sort()
      .join('\n') === filesBeforeRejectedMessageRender,
    'rejected active content creates no local file',
  );

  return { savedGallery, savedGalleryImageUrl, galleryGenerated, generatedGalleryImageUrl };
}

export type GalleryFixture = Awaited<ReturnType<typeof testGallery>>;
