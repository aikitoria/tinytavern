import { requireTestIsolation } from './isolation.ts';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

requireTestIsolation();

const keyFile = join(process.env.DATA_DIR!, 'media.key');
const key = Buffer.alloc(32, 0x6b);
writeFileSync(keyFile, key.toString('hex'));
process.env.MEDIA_SIGNING_KEY_FILE = keyFile;
const { signMediaUrl, publicAvatar, publicMessage, publicGalleryItem } =
  await import('../server/src/mediaUrls.ts');
const realNow = Date.now;
Date.now = () => 1_000_000_000;
try {
  for (const path of [
    '/images/a.png',
    '/avatars/character-1.png?v=42',
    '/any/nested/file.txt?download=1',
  ]) {
    const url = signMediaUrl(path);
    const signed = `${path}${path.includes('?') ? '&' : '?'}expires=1086400`;
    assert.equal(
      url,
      `${signed}&sig=${createHmac('sha256', key).update(signed).digest('base64url')}`,
    );
    Date.now = () => 1_010_000_000;
    assert.equal(signMediaUrl(path), url, 'reuse URL across snapshots');
    Date.now = () => 1_000_000_000;
  }
  const avatar = { avatar: '/avatars/character-1.png?v=42', name: 'Example' };
  assert.match(publicAvatar(avatar).avatar!, /&sig=/);
  assert.equal(avatar.avatar, '/avatars/character-1.png?v=42');
  assert.equal(publicMessage(undefined), undefined);
  assert.equal(publicMessage(null), null);
  const { toMessage, toGalleryItem, stmt } = await import('../server/src/db.ts');
  stmt('INSERT INTO avatar_thumbnails(source, thumbnail, thumbnail_size) VALUES (?, ?, 128)').run(
    avatar.avatar,
    '/avatars/avatar-thumb-test.jpg',
  );
  assert.match(
    publicAvatar(avatar).avatarThumbnail!,
    /^\/avatars\/avatar-thumb-test\.jpg\?expires=.*&sig=/,
  );
  const message = toMessage({ id: 1, images_json: '["/images/a.png"]' });
  assert.match(publicMessage(message).images[0]!, /&sig=/);
  assert.deepEqual(message.images, ['/images/a.png']);
  stmt(
    "INSERT INTO media_assets(path, thumbnail) VALUES ('/images/g.png', '/images/thumbnail.jpg')",
  ).run();
  const gallery = toGalleryItem({
    id: 1,
    characters_json: '[]',
    image: '/images/g.png',
    source_image: '/images/a.png',
  });
  assert.match(publicGalleryItem(gallery).image, /&sig=/);
  assert.match(publicGalleryItem(gallery).media?.thumbnail!, /&sig=/);
  assert.equal(gallery.media?.thumbnail, '/images/thumbnail.jpg');
  assert.equal(gallery.image, '/images/g.png');
  const previous = signMediaUrl('/images/a.png');
  Date.now = () => 1_086_400_000;
  const fresh = signMediaUrl('/images/a.png');
  assert.notEqual(fresh, previous);
  assert.equal(new URL(fresh, 'http://test').searchParams.get('expires'), '1172800');
} finally {
  Date.now = realNow;
}
console.log('Signed URLs: 24-hour expiry, reuse, arbitrary paths, immutable DTOs passed');
