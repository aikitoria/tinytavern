import { randomUUID } from 'node:crypto';
import { openProgressSocket, parseImageConfig, renderToBuffer } from '../comfy.ts';
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
import { rowById } from './entityUtils.ts';
import type { AvatarKind } from './avatarStore.ts';

/**
 * Interactive avatar generation, driven step by step from the client's
 * popup: the prompt route streams the LLM portrait prompt as SSE (macros
 * expanded from the entity row), the render route turns an (edited) prompt
 * into image bytes. Nothing is stored server-side — saving the result goes
 * through the normal PUT avatar route, so PNG enforcement lives there.
 */

// Generous budget: reasoning models can burn hundreds of tokens before any
// content, and the prompt itself is short — non-reasoning models stop early.
const AVATAR_PROMPT_MAX_TOKENS = 2048;

/** One in-flight prompt stream per entity — a double open 409s. */
const streaming = new Set<string>();

/** Case-insensitive replaceAll of the macros this entity kind supports;
 * unsupported or unknown macros are left untouched. */
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
  const abort = new AbortController();
  const onClose = () => {
    if (!ctx.res.writableEnded) abort.abort();
  };
  ctx.res.on('close', onClose);
  if (ctx.res.destroyed) abort.abort();
  try {
    // Characters have no separate description column — card imports merge the
    // card's description into personality, so {{description}} reads from it.
    const vars: Record<string, string> =
      kind === 'character'
        ? {
            name: row.name as string,
            char: row.name as string,
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
    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    try {
      await streamChatCompletion(
        null,
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        AVATAR_PROMPT_MAX_TOKENS,
        (d) => ctx.res.write(`data: ${JSON.stringify({ d })}\n\n`),
        abort.signal,
      );
      if (!abort.signal.aborted) ctx.res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (err) {
      if (!abort.signal.aborted) {
        ctx.res.write(
          `data: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`,
        );
      }
    }
    ctx.res.end();
  } finally {
    ctx.res.off('close', onClose);
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

/** Stateless render: the (possibly user-edited) prompt in, image bytes out.
 * A caller-provided jobId gets live sampler progress through its private SSE
 * subscription (the modal correlates it and shows a progress bar). */
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
  const clientId = jobId ? randomUUID() : undefined;
  const ws = clientId
    ? await openProgressSocket(
        image.comfyUrl.replace(/\/+$/, ''),
        clientId,
        (value, max) => publishRenderProgress(jobId, value, max),
        (preview) => publishRenderPreview(jobId, preview),
        abort.signal,
      )
    : null;
  let result: { ext: string; data: Buffer };
  try {
    result = await renderToBuffer({
      comfyUrl: image.comfyUrl,
      workflow: image.workflow,
      prompt,
      clientId,
      signal: abort.signal,
    });
  } catch (err) {
    if (abort.signal.aborted) {
      if (!ctx.res.writableEnded) ctx.res.end();
      return;
    }
    throw new HttpError(502, err instanceof Error ? err.message : String(err));
  } finally {
    ws?.close();
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
