import { rasterImageFormat } from './images.ts';

const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;

/** ComfyUI binary event ids (protocol.py). Legacy preview frames are:
 * event u32, image type u32, encoded raster bytes. Metadata frames are:
 * event u32, metadata length u32, metadata JSON, encoded raster bytes. */
const COMFY_PREVIEW_IMAGE = 1;
const COMFY_PREVIEW_IMAGE_WITH_METADATA = 4;

export function parsePreviewFrame(frame: Buffer): string | null {
  if (frame.length < 9) return null;
  const event = frame.readUInt32BE(0);
  let image: Buffer;
  if (event === COMFY_PREVIEW_IMAGE) {
    image = frame.subarray(8);
  } else if (event === COMFY_PREVIEW_IMAGE_WITH_METADATA) {
    const metadataLength = frame.readUInt32BE(4);
    const imageOffset = 8 + metadataLength;
    if (imageOffset > frame.length) return null;
    image = frame.subarray(imageOffset);
  } else {
    return null;
  }
  if (image.length === 0 || image.length > MAX_PREVIEW_BYTES) return null;
  const format = rasterImageFormat(image);
  return format ? `data:${format.mime};base64,${image.toString('base64')}` : null;
}
