import type { GalleryItem } from '@minitavern/shared';
import { BASE, assert, req, expectStatus } from './helpers.ts';
import type { ImagesFixture } from './images.ts';
import type { GalleryFixture } from './gallery.ts';
import type { ImageRevisionsFixture } from './image-revisions.ts';
import type { ChatFixture } from './chat.ts';

export async function testCleanup(
  fixture: Pick<ImagesFixture, 'imageUrl'> &
    Pick<
      GalleryFixture,
      'savedGallery' | 'galleryGenerated' | 'savedGalleryImageUrl' | 'generatedGalleryImageUrl'
    > &
    Pick<ImageRevisionsFixture, 'individuallyDeletedGallery' | 'individuallyDeletedGalleryUrl'> &
    Pick<ChatFixture, 'ws'>,
) {
  const {
    imageUrl,
    savedGallery,
    galleryGenerated,
    individuallyDeletedGallery,
    savedGalleryImageUrl,
    generatedGalleryImageUrl,
    individuallyDeletedGalleryUrl,
    ws,
  } = fixture;

  console.log('== delete all conversations ==');
  const bulkDelete = await req<{ deleted: number }>('DELETE', '/api/conversations');
  assert(bulkDelete.deleted > 0, 'bulk delete reports the number of deleted conversations');
  assert(
    (await req<unknown[]>('GET', '/api/conversations')).length === 0,
    'bulk delete removes every conversation',
  );
  assert(
    (await fetch(`${BASE}${imageUrl}`)).status === 404,
    'bulk delete removes generated images',
  );
  const galleryAfterBulkDelete = await req<GalleryItem[]>('GET', '/api/gallery');
  assert(
    galleryAfterBulkDelete.some(
      (item) => item.id === savedGallery.item.id && item.sourceConversationId === null,
    ) &&
      galleryAfterBulkDelete.some((item) => item.id === galleryGenerated.id) &&
      galleryAfterBulkDelete.some((item) => item.id === individuallyDeletedGallery.item.id) &&
      (await fetch(`${BASE}${savedGalleryImageUrl}`)).status === 200 &&
      (await fetch(`${BASE}${generatedGalleryImageUrl}`)).status === 200 &&
      (await fetch(`${BASE}${individuallyDeletedGalleryUrl}`)).status === 200,
    'bulk conversation deletion leaves independently saved gallery images intact',
  );
  await req('DELETE', `/api/gallery/${individuallyDeletedGallery.item.id}`);
  assert(
    (await fetch(`${BASE}${individuallyDeletedGalleryUrl}`)).status === 404,
    'deleting one gallery item removes its independent image file',
  );
  await expectStatus('POST', '/api/gallery/bulk-delete', { ids: [] }, 400);
  const galleryBulkDelete = await req<{ deleted: number }>('POST', '/api/gallery/bulk-delete', {
    ids: [savedGallery.item.id, galleryGenerated.id],
  });
  assert(
    galleryBulkDelete.deleted === 2 &&
      (await req<GalleryItem[]>('GET', '/api/gallery')).length === 0 &&
      (await fetch(`${BASE}${savedGalleryImageUrl}`)).status === 404 &&
      (await fetch(`${BASE}${generatedGalleryImageUrl}`)).status === 404,
    'bulk deleting selected gallery items removes every row and owned image file',
  );

  ws.close();
}
