import type { MediaImageConfig } from '@tinytavern/shared';
import { parseMediaWorkflow, parseComfyUrl } from './mediaSettings.ts';
import { stmt } from './db.ts';
import { getMessage, markMessageDirty } from './tree.ts';
import { broadcastTree } from './sync.ts';
import { bumpConversationRevision } from './conversationRevision.ts';
import { startMessageImageRender } from './mediaImageAdapter.ts';
export { parsePreviewFrame } from './comfyPreview.ts';
export { renderImageBuffer as renderToBuffer } from './mediaImageAdapter.ts';
export type { ImageRenderRequest as RenderRequest } from './mediaImageAdapter.ts';

/** Reject invalid workflows at route/save time before rendering starts. */
export function parseImageConfig(raw: unknown): MediaImageConfig {
  const obj =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const comfyUrl = parseComfyUrl(obj.comfyUrl);
  const workflow = parseMediaWorkflow(obj.workflow);
  if (workflow.operation !== 'image' || !workflow.json.trim()) {
    throw new Error('Choose a configured Create image workflow');
  }
  return { workflow, comfyUrl };
}

/** Fire-and-forget; failures surface as genMeta.imageError. */
export function startImageRender(mid: number): void {
  const message = getMessage(mid);
  if (!message) return;
  try {
    startMessageImageRender(message);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[comfy] render failed for message ${mid}: ${error}`);
    const row = getMessage(mid);
    if (!row) return;
    const meta = JSON.stringify({ ...(row.genMeta ?? {}), imageError: error });
    stmt(
      'UPDATE messages SET image_pending = 0, gen_meta_json = ? WHERE id = ? AND image_pending = 1',
    ).run(meta, mid);
    bumpConversationRevision(message.conversationId);
    markMessageDirty(message.conversationId, mid);
    broadcastTree(message.conversationId);
  }
}
