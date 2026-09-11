import { newRequestId } from '@tinytavern/shared';
import type { MediaVideoPreview } from '@tinytavern/shared';
import { rasterImageFormat } from '../images.ts';

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_FRAMES = 512;

/** Installed VHS protocol: event, JPEG type, VHS marker, index, 16-byte Pascal node ID, JPEG. */
export function parseVideoPreviewFrame(frame: Buffer) {
  if (frame.length <= 32 || frame.length > MAX_FRAME_BYTES + 32) return null;
  if (frame.readUInt32BE(0) !== 1 || frame.readUInt32BE(4) !== 1 || frame.readUInt32BE(8) !== 1)
    return null;
  const index = frame.readUInt32BE(12);
  const length = frame[16]!;
  if (length < 1 || length > 15 || index >= MAX_FRAMES) return null;
  const nodeBytes = frame.subarray(17, 17 + length);
  if (nodeBytes.some((byte) => byte < 32 || byte > 126)) return null;
  const image = frame.subarray(32);
  if (rasterImageFormat(image)?.mime !== 'image/jpeg') return null;
  return {
    index,
    nodeId: nodeBytes.toString('ascii'),
    image: `data:image/jpeg;base64,${image.toString('base64')}`,
  };
}

/** Track sequence identity; the live job owns the complete cached frame strings. */
export class ComfyVideoPreview {
  readonly metadata: Omit<MediaVideoPreview, 'frames' | 'sequence'>;
  private sequence = newRequestId();

  private constructor(metadata: Omit<MediaVideoPreview, 'frames' | 'sequence'>) {
    this.metadata = metadata;
  }

  /** Reuse the clip and sequence identity across worker reconnects. */
  static restore(metadata: Omit<MediaVideoPreview, 'frames' | 'sequence'>, sequence?: string) {
    const { id, nodeId, frameCount, frameRate } = metadata;
    const preview = new ComfyVideoPreview({ id, nodeId, frameCount, frameRate });
    if (sequence) preview.sequence = sequence;
    return preview;
  }

  static fromEvent(data: unknown, executingNode: string | null): ComfyVideoPreview | null {
    if (!data || typeof data !== 'object') return null;
    const { id, length, rate } = data as Record<string, unknown>;
    if (typeof id !== 'string' || id !== executingNode) return null;
    if (
      typeof length !== 'number' ||
      !Number.isInteger(length) ||
      length < 1 ||
      length > MAX_FRAMES
    )
      return null;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 60) return null;
    return new ComfyVideoPreview({
      id: newRequestId(),
      nodeId: id,
      frameCount: length,
      frameRate: rate,
    });
  }

  accept(frame: Buffer): MediaVideoPreview | null {
    const decoded = parseVideoPreviewFrame(frame);
    if (
      !decoded ||
      decoded.nodeId !== this.metadata.nodeId.slice(0, 15) ||
      decoded.index >= this.metadata.frameCount
    )
      return null;
    // The installed VHS previewer sends every denoise update in order, starting at zero.
    if (decoded.index === 0) {
      this.sequence = newRequestId();
    }
    const frames: MediaVideoPreview['frames'] = { [decoded.index]: decoded.image };
    return { ...this.metadata, sequence: this.sequence, frames };
  }
}
