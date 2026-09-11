import type {
  ConversationPromptContext,
  Character,
  Conversation,
  CustomTemplate,
  Message,
  Persona,
  Template,
} from '@tinytavern/shared';
import {
  characterChatName,
  systemNote,
  expandPromptSlots,
  appendChatMessage,
  appendSpeakerHandoff,
  prepareChatMessages,
  type PromptMessage,
  type ImageGenerationSettings,
} from '@tinytavern/shared';
import { stmt, toCharacter, toPersona, toPreset, toTemplate } from '../db/db.ts';
import { getSettings } from '../settings/settingsStore.ts';
import { HttpError } from '../http/router.ts';

export type ChatMessage = PromptMessage;
export { appendChatMessage };

export function getCharacter(id: number | null): Character | null {
  if (id == null) return null;
  const row = stmt('SELECT * FROM characters WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? toCharacter(row) : null;
}

export function getPersona(id: number | null): Persona | null {
  if (id == null) return null;
  const row = stmt('SELECT * FROM personas WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? toPersona(row) : null;
}

function getPresetContent(id: number | null): string | null {
  if (id == null) return null;
  const row = stmt('SELECT * FROM presets WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? toPreset(row).content : null;
}

function getTemplate(id: number | null): Template | null {
  if (id == null) return null;
  const row = stmt('SELECT * FROM templates WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? toTemplate(row) : null;
}

/** Inline templates replace referenced templates entirely. */
function resolveTemplate(character: Character | null): CustomTemplate | null {
  return (
    character?.customTemplate ??
    getTemplate(character?.templateId ?? null) ??
    getTemplate(getSettings().defaultTemplateId)
  );
}

/** Resolve the configured revision instruction without substituting another prompt. */
export function resolveSteerTemplate(conversation: Conversation): string {
  if (conversation.promptMode === 'media')
    return 'Revise the previous prompt following this instruction: {{instruction}}. Return only the complete revised prompt.';
  const raw = resolveTemplate(getCharacter(conversation.characterId))?.steerTemplate ?? '';
  if (!raw.trim())
    throw new HttpError(
      400,
      'Configure a steer template in the selected prompt template before regenerating with an instruction.',
    );
  return raw;
}

export function substituteMacros(text: string, charName: string, userName: string): string {
  return text.replaceAll(/\{\{(char|user)\}\}/gi, (_, key: string) =>
    key.toLowerCase() === 'char' ? charName : userName,
  );
}

/** Render {{#if key}} blocks and {{key}} slots, then collapse excess blank lines. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return expandTemplate(template, vars)
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

/** Expand conditions before values, preserving whitespace and literal macros inside values. */
export function expandTemplate(template: string, vars: Record<string, string>): string {
  // Resolve nested blocks innermost-first; exclude Object.prototype members from slots.
  const lookup = (key: string): string | undefined =>
    Object.hasOwn(vars, key) ? vars[key] : undefined;
  let out = template;
  for (let prev; prev !== out;) {
    prev = out;
    out = out.replaceAll(
      /\{\{#if ([a-z][a-z0-9_]*)\}\}((?:(?!\{\{#if )[\s\S])*?)\{\{\/if\}\}/gi,
      (_, key: string, body: string) => (lookup(key.toLowerCase())?.trim() ? body : ''),
    );
  }
  out = out.replaceAll(
    /\{\{([a-z][a-z0-9_]*)\}\}/gi,
    (match, key: string) => lookup(key.toLowerCase()) ?? match,
  );
  return out;
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  /** Trace-only source IDs; never included in upstream message objects. */
  messageIds?: number[][];
  /** Hidden reasoning seed for fresh generations. */
  reasoningPrefill: string | null;
  /** Visible content seed for fresh generations. */
  messagePrefill: string | null;
  /** "Name:" when the template prefixes speaker names. */
  namePrefill: string | null;
  /** Speaker instruction used when the requested name cannot be prefilled. */
  speakerHandoff: string | null;
  /** {{char}}/{{user}} as this prompt resolved them (persona honors usesPersonas). */
  charName: string;
  userName: string;
}

/** Media histories are already authored for their task; never apply character/persona templates. */
function buildContextMessages(context: ConversationPromptContext, history: Message[]): BuiltPrompt {
  const messages: ChatMessage[] = context.messages.map((message) => ({ ...message }));
  const sources = new Map<ChatMessage, number[]>();
  for (const message of history) {
    if (message.status === 'streaming' || message.role === 'tool') continue;
    if (!message.content.trim() && !message.reasoning?.trim()) continue;
    appendChatMessage(messages, {
      role: message.role,
      content: message.content,
      ...(message.role === 'assistant' && message.reasoning
        ? { reasoning_content: message.reasoning }
        : {}),
    });
    const turn = messages.at(-1)!;
    const ids = sources.get(turn) ?? [];
    ids.push(message.id);
    sources.set(turn, ids);
  }
  return {
    messages,
    messageIds: messages.map((message) => sources.get(message) ?? []),
    reasoningPrefill: context.reasoningPrefill || null,
    messagePrefill: context.messagePrefill || null,
    namePrefill: null,
    speakerHandoff: null,
    charName: 'Assistant',
    userName: 'You',
  };
}

/** Build the system prompt and active-path history for the reply's stamped speakerName. */
export function buildChatMessages(
  conversation: Conversation,
  history: Message[],
  speakerName: string | null = conversation.speakerName,
): BuiltPrompt {
  const captured = stmt('SELECT prompt_context_json FROM conversations WHERE id = ?').get(
    conversation.id,
  )?.prompt_context_json;
  if (captured) return buildContextMessages(JSON.parse(String(captured)), history);
  const character = getCharacter(conversation.characterId);
  const settings = getSettings();
  const template = resolveTemplate(character);

  const usesPersonas = template?.usesPersonas ?? true;
  const persona = usesPersonas ? getPersona(conversation.personaId) : null;
  const charName = characterChatName(character);
  const userName = persona?.name ?? 'User';
  const sub = (text: string) => substituteMacros(text.trim(), charName, userName);

  const systemPrompt =
    character?.customPrompt ??
    getPresetContent(character?.presetId ?? null) ??
    getPresetContent(settings.defaultPresetId) ??
    '';
  const vars = {
    system: sub(systemPrompt),
    personality: sub(character?.personality ?? ''),
    persona: sub(persona?.description ?? ''),
    scenario: sub(conversation.scenarioOverride ?? character?.scenario ?? ''),
    examples: sub(character?.examples ?? ''),
    char: charName,
    user: userName,
  };
  const systemContent = renderTemplate(template?.content ?? '', vars);
  const prologueSource = template?.userPrologue ?? '';
  const prologue = prologueSource.trim() ? renderTemplate(prologueSource, vars) : '';
  const reasoningPrefillSource = template?.reasoningPrefill ?? '';
  const reasoningPrefill = reasoningPrefillSource.trim()
    ? renderTemplate(reasoningPrefillSource, vars)
    : '';
  const messagePrefillSource = template?.messagePrefill ?? '';
  const messagePrefill = messagePrefillSource.trim()
    ? renderTemplate(messagePrefillSource, vars)
    : '';

  const prefixNames = template?.prefixNames ?? false;
  const speakerFor = (msg: Message) =>
    msg.role === 'user' ? userName : msg.name?.trim() || charName;
  const handoff = (speaker: string) =>
    expandPromptSlots(template?.speakerHandoffTemplate ?? '', { speaker });
  let previousSpeaker = charName;

  const messages: ChatMessage[] = [];
  const sources = new Map<ChatMessage, number[]>();
  if (systemContent) appendChatMessage(messages, { role: 'system', content: systemContent });
  if (prologue) appendChatMessage(messages, { role: 'user', content: prologue });
  for (const msg of history) {
    if (msg.status === 'streaming') continue;
    if (msg.role === 'tool') continue; // tool output is chat-visible only, never sent upstream
    const trimmedContent = msg.content.trim();
    const reasoning = msg.role === 'assistant' ? msg.reasoning?.trim() : '';
    // Preserve reasoning-only assistant turns in history.
    if (trimmedContent.length === 0 && !reasoning) continue;
    const speaker = speakerFor(msg).trim();
    if (msg.role === 'assistant') {
      if (speaker !== previousSpeaker) appendSpeakerHandoff(messages, handoff(speaker));
      previousSpeaker = speaker;
    }
    const content = prefixNames
      ? `${speaker}: ${trimmedContent}`
      : trimmedContent || '(No visible response)';
    appendChatMessage(messages, {
      role: msg.role,
      content,
      ...(reasoning ? { reasoning_content: msg.reasoning! } : {}),
    });
    if (msg.role === 'assistant') {
      const turn = messages.at(-1)!;
      const ids = sources.get(turn);
      if (ids) ids.push(msg.id);
      else sources.set(turn, [msg.id]);
    }
  }

  const currentSpeaker = speakerName?.trim() || charName;
  return {
    messages,
    messageIds: messages.map((message) => sources.get(message) ?? []),
    reasoningPrefill: reasoningPrefill || null,
    messagePrefill: messagePrefill || null,
    namePrefill: prefixNames ? `${currentSpeaker}:` : null,
    speakerHandoff: currentSpeaker !== previousSpeaker ? handoff(currentSpeaker) : null,
    charName,
    userName,
  };
}

/** Copies a prompt and appends its upstream-only speaker handoff to the final user turn. */
export function withDisabledPrefillSpeakerNote(built: BuiltPrompt): ChatMessage[] {
  return prepareChatMessages(built, { prefillMode: 'disabled' }).messages;
}

/** Tool prompts retain chat context and reasoning prefill, but omit character reply prefills. */
export function buildToolPrompt(
  conversation: Conversation,
  history: Message[],
  prompt: string,
): BuiltPrompt {
  const built = buildChatMessages(conversation, history);
  appendChatMessage(built.messages, {
    role: 'user',
    content: substituteMacros(systemNote(prompt.trim()), built.charName, built.userName),
  });
  return {
    ...built,
    reasoningPrefill: built.reasoningPrefill,
    messagePrefill: null,
    namePrefill: null,
    speakerHandoff: null,
  };
}

/** The one-off steer follows the original reply as a user turn for strict chat APIs.
 * It is never stored in history. */
export function buildSteeredPrompt(
  conversation: Conversation,
  history: Message[],
  steer: string,
  speakerName: string | null,
): BuiltPrompt {
  const built = buildChatMessages(conversation, history, speakerName);
  appendChatMessage(built.messages, { role: 'user', content: systemNote(steer) });
  return built;
}

/** Append an image revision task, optionally retaining existing roleplay context. */
export function appendImagePromptRevisionTask(
  messages: ChatMessage[],
  original: string,
  originalReasoning: string | null,
  instruction: string,
  settings: Pick<
    ImageGenerationSettings,
    'promptRevisionTemplate' | 'promptRevisionContext' | 'promptRevisionOriginal'
  >,
): void {
  const originalBlock = expandImageRevisionTemplate(
    settings.promptRevisionOriginal,
    original,
    instruction,
  );
  // Replay the original prompt's reasoning as an assistant turn; bridge for strict alternation.
  if (messages.at(-1)?.role !== 'user' && settings.promptRevisionContext.trim()) {
    appendChatMessage(messages, {
      role: 'user',
      content: expandImageRevisionTemplate(
        systemNote(settings.promptRevisionContext),
        original,
        instruction,
      ),
    });
  }
  appendChatMessage(messages, {
    role: 'assistant',
    content: originalBlock,
    ...(originalReasoning?.trim() ? { reasoning_content: originalReasoning } : {}),
  });
  appendChatMessage(messages, {
    role: 'user',
    // One pass keeps macro-looking text inside the user's input literal.
    content: expandImageRevisionTemplate(
      systemNote(settings.promptRevisionTemplate),
      original,
      instruction,
    ),
  });
}

function expandImageRevisionTemplate(
  template: string,
  original: string,
  instruction: string,
): string {
  return template.replace(/\{\{(instruction|prompt)\}\}/gi, (_, key: string) =>
    key.toLowerCase() === 'instruction' ? instruction.trim() : original.trim(),
  );
}

/** Keep history as an unchanged prefix for cache reuse and references; delimit the revision task. */
export function buildSteeredToolPrompt(
  conversation: Conversation,
  history: Message[],
  original: string,
  originalReasoning: string | null,
  instruction: string,
): BuiltPrompt {
  const built = buildChatMessages(conversation, history);
  appendImagePromptRevisionTask(
    built.messages,
    original,
    originalReasoning,
    instruction,
    getSettings().imageGeneration,
  );
  return {
    ...built,
    reasoningPrefill: built.reasoningPrefill,
    messagePrefill: null,
    namePrefill: null,
    speakerHandoff: null,
  };
}
