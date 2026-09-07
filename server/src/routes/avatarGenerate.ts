import { characterChatName } from '@tinytavern/shared';
import { parseImageConfig, renderToBuffer } from '../comfy.ts';
import { streamChatCompletion } from '../generation.ts';
import { getPersona } from '../prompt.ts';
import { getSettings } from '../settingsStore.ts';
import { route, HttpError } from '../router.ts';
import type { Ctx } from '../router.ts';
import { objectBody, positiveId } from '../validation.ts';
import {
  finishRenderProgress,
  publishRenderPreview,
  publishRenderProgress,
  renderJobId,
  streamRenderProgress,
} from '../renderProgress.ts';
import { streamResponse } from './streamResponse.ts';
import { rowById } from './entityUtils.ts';
import type { AvatarKind } from './avatarStore.ts';

/** Nothing is persisted here; the normal PUT avatar route saves and enforces PNG. */

// Allow reasoning models hundreds of tokens before visible prompt content.
const AVATAR_PROMPT_MAX_TOKENS = 2048;

/** One in-flight prompt stream per entity — a double open 409s. */
const streaming = new Set<string>();

/** Unknown or unsupported macros remain unchanged. */
function expandAvatarMacros(template: string, vars: Record<string, string>): string {
  return template.replaceAll(
    /\{\{(name|char|user|description|personality|scenario|firstMessage)\}\}/gi,
    (match, key: string) =>
      Object.hasOwn(vars, key.toLowerCase()) ? vars[key.toLowerCase()]! : match,
  );
}

function serializeFields(fields: [string, string][]): string {
  return fields
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

async function streamAvatarPrompt(kind: AvatarKind, ctx: Ctx) {
  const id = positiveId(ctx.params.id);
  const b = objectBody(ctx.body);
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt) throw new HttpError(400, 'prompt is required');
  const context = typeof b.context === 'string' ? b.context.trim() : null;
  if (b.context !== undefined && !context) throw new HttpError(400, 'context is required');
  const table = kind === 'character' ? 'characters' : 'personas';
  const row = rowById(table, id);
  const key = `${kind}:${id}`;
  if (streaming.has(key)) {
    throw new HttpError(409, 'an avatar prompt is already streaming for this entity');
  }
  streaming.add(key);
  try {
    // Character card imports merge description into personality.
    const vars: Record<string, string> =
      kind === 'character'
        ? {
            name: row.name as string,
            char: characterChatName({
              name: row.name as string,
              chatName: row.chat_name as string | null,
            }),
            user: getPersona(getSettings().defaultPersonaId)?.name ?? 'User',
            description: row.personality as string,
            personality: row.personality as string,
            scenario: row.scenario as string,
            firstmessage: row.first_message as string,
          }
        : {
            name: row.name as string,
            user: row.name as string,
            description: row.description as string,
            scenario: '',
            firstmessage: '',
          };
    const system = expandAvatarMacros(prompt, vars);
    const user = context
      ? expandAvatarMacros(context, vars)
      : serializeFields(
          kind === 'character'
            ? [
                ['Name', row.name as string],
                ['Avatar details', row.personality as string],
                ['Scenario', row.scenario as string],
                ['First message', row.first_message as string],
              ]
            : [
                ['Name', row.name as string],
                ['Description', row.description as string],
              ],
        );
    if (!user.trim()) throw new HttpError(400, 'context must produce non-empty text');
    // SSE from here on — failures mid-stream go out as error events, not HTTP.
    await streamResponse(ctx.res, async (send, signal) => {
      await streamChatCompletion(
        null,
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        AVATAR_PROMPT_MAX_TOKENS,
        (d) => send({ d }),
        signal,
      );
    });
  } finally {
    streaming.delete(key);
  }
}

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** A caller-provided jobId routes progress to its private SSE subscription. */
async function renderAvatar(ctx: Ctx) {
  const b = objectBody(ctx.body);
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt) throw new HttpError(400, 'prompt is required');
  const jobId = typeof b.jobId === 'string' && b.jobId.trim() ? renderJobId(b.jobId.trim()) : '';
  let image: { workflow: string; comfyUrl: string };
  try {
    image = parseImageConfig(b.image);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : 'invalid image config');
  }
  const abort = new AbortController();
  const onClose = () => {
    if (!ctx.res.writableEnded) abort.abort();
  };
  ctx.res.on('close', onClose);
  if (ctx.res.destroyed) abort.abort();
  let result: { ext: string; data: Buffer };
  try {
    result = await renderToBuffer({
      comfyUrl: image.comfyUrl,
      workflow: image.workflow,
      prompt,
      onProgress: jobId ? (value, max) => publishRenderProgress(jobId, value, max) : undefined,
      onPreview: jobId ? (preview) => publishRenderPreview(jobId, preview) : undefined,
      signal: abort.signal,
    });
  } catch (err) {
    if (abort.signal.aborted) {
      if (!ctx.res.writableEnded) ctx.res.end();
      return;
    }
    throw new HttpError(502, err instanceof Error ? err.message : String(err));
  } finally {
    ctx.res.off('close', onClose);
    if (jobId) finishRenderProgress(jobId);
  }
  ctx.res.writeHead(200, {
    'content-type': IMAGE_CONTENT_TYPES[result.ext] ?? 'application/octet-stream',
  });
  ctx.res.end(result.data);
}

route.post('/api/characters/:id/avatar/prompt', (ctx) => streamAvatarPrompt('character', ctx));
route.post('/api/personas/:id/avatar/prompt', (ctx) => streamAvatarPrompt('persona', ctx));
route.get('/api/avatar/render-progress/:id', (ctx) => streamRenderProgress(ctx));
route.post('/api/avatar/render', (ctx) => renderAvatar(ctx));
