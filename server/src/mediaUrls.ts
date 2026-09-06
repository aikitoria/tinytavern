import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { GalleryItem, Message } from '@minitavern/shared';

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
export function publicAvatar<T extends { avatar: string | null }>(entity: T): T {
  return key && entity.avatar ? { ...entity, avatar: signMediaUrl(entity.avatar) } : entity;
}
export function publicMessage<T extends Message | null | undefined>(message: T): T {
  return key && message?.images.length
    ? { ...message, images: message.images.map(signMediaUrl) }
    : message;
}
export function publicGalleryItem(item: GalleryItem): GalleryItem {
  return key
    ? {
        ...item,
        image: signMediaUrl(item.image),
        sourceImage: item.sourceImage ? signMediaUrl(item.sourceImage) : null,
      }
    : item;
}
