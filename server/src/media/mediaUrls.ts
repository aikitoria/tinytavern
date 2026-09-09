import { stmt } from '../db/db.ts';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { GalleryItem, Message, MediaAsset, MediaJob } from '@tinytavern/shared';

const keyFile = process.env.MEDIA_SIGNING_KEY_FILE;
const keyText = keyFile ? readFileSync(keyFile, 'utf8').trim() : null;
if (keyText !== null && !/^[a-f0-9]{64}$/.test(keyText)) {
  throw new Error('MEDIA_SIGNING_KEY_FILE must contain 32 bytes encoded as lowercase hex');
}
const key = keyText === null ? null : Buffer.from(keyText, 'hex');
export const caddyEnabled = key !== null;
const cache = new Map<string, { url: string; expires: number }>();

export function signMediaUrl(path: string): string {
  if (!key) return path;
  // Reuse 24-hour URLs until their last hour to avoid signing and snapshot URL churn.
  const now = Math.floor(Date.now() / 1000);
  const cached = cache.get(path);
  if (cached && cached.expires > now + 3600) return cached.url;
  const expiry = now + 86400;
  const signed = `${path}${path.includes('?') ? '&' : '?'}expires=${expiry}`;
  const signature = createHmac('sha256', key).update(signed).digest('base64url');
  const url = `${signed}&sig=${signature}`;
  if (cache.size >= 16384) cache.delete(cache.keys().next().value!);
  cache.set(path, { url, expires: expiry });
  return url;
}
export function publicAvatar<T extends { avatar: string | null }>(
  entity: T,
): T & { avatarThumbnail: string | null } {
  const thumbnail = entity.avatar
    ? stmt('SELECT thumbnail FROM avatar_thumbnails WHERE source = ?').get(entity.avatar)?.thumbnail
    : null;
  return {
    ...entity,
    avatar: entity.avatar ? signMediaUrl(entity.avatar) : null,
    avatarThumbnail: typeof thumbnail === 'string' ? signMediaUrl(thumbnail) : null,
  };
}
export function publicMessage<T extends Message | null | undefined>(message: T): T {
  return key && message?.media.length
    ? {
        ...message,
        media: message.media.map(publicMediaAsset),
      }
    : message;
}
export function publicGalleryItem(item: GalleryItem): GalleryItem {
  return key
    ? {
        ...item,
        image: signMediaUrl(item.image),
        media: item.media ? publicMediaAsset(item.media) : undefined,
        sourceImage: item.sourceImage ? signMediaUrl(item.sourceImage) : null,
      }
    : item;
}

export function publicMediaAsset(asset: MediaAsset): MediaAsset {
  return key
    ? {
        ...asset,
        url: signMediaUrl(asset.url),
        thumbnail: asset.thumbnail ? signMediaUrl(asset.thumbnail) : null,
      }
    : asset;
}

export function publicMediaJob(job: MediaJob): MediaJob {
  return {
    ...job,
    assets: job.assets.map(publicMediaAsset),
    outputs: job.outputs.map(publicMediaAsset),
  };
}
