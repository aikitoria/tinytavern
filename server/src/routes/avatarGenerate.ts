import { characterChatName, expandPromptSlots } from '@tinytavern/shared';
import { streamChatCompletion } from '../generation/generation.ts';
import { getPersona } from '../generation/prompt.ts';
import { getSettings } from '../settings/settingsStore.ts';
import { route, HttpError } from '../http/router.ts';
import type { Ctx } from '../http/router.ts';
import { objectBody, positiveId } from '../http/validation.ts';
import { streamResponse } from '../http/streamResponse.ts';
import { rowById } from './shared/entityUtils.ts';
import type { AvatarKind } from '../characters/avatarStore.ts';

/** Entity-specific prompt context; rendering uses the shared media job routes. */

// Allow reasoning models hundreds of tokens before visible prompt content.
const AVATAR_PROMPT_MAX_TOKENS = 2048;

/** One in-flight prompt stream per entity — a double open 409s. */
const streaming = new Set<string>();

function streamAvatarPrompt(kind: AvatarKind, ctx: Ctx) {
  const id = positiveId(ctx.params.id);
  const b = objectBody(ctx.body);
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt) throw new HttpError(400, 'prompt is required');
  const context = typeof b.context === 'string' ? b.context.trim() : '';
  if (!context) throw new HttpError(400, 'context is required');
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
    const system = expandPromptSlots(prompt, vars);
    const user = expandPromptSlots(context, vars);
    if (!user.trim()) throw new HttpError(400, 'context must produce non-empty text');
    // SSE from here on — failures mid-stream go out as error events, not HTTP.
    return streamResponse(
      ctx.req,
      async (send, signal) => {
        await streamChatCompletion(
          null,
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          AVATAR_PROMPT_MAX_TOKENS,
          (d) => send({ d }),
          signal,
          { onReasoning: (r) => send({ r }) },
        );
      },
      () => streaming.delete(key),
    );
  } catch (err) {
    streaming.delete(key);
    throw err;
  }
}

route.post('/api/characters/:id/avatar/prompt', (ctx) => streamAvatarPrompt('character', ctx));
route.post('/api/personas/:id/avatar/prompt', (ctx) => streamAvatarPrompt('persona', ctx));
