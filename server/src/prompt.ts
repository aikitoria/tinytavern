import type {
  Character,
  Conversation,
  CustomTemplate,
  Message,
  Persona,
  Role,
  Template,
} from '@tinytavern/shared';
import { DEFAULT_PROMPT_TEMPLATE, DEFAULT_STEER_TEMPLATE } from '@tinytavern/shared';
import { stmt, toCharacter, toPersona, toPreset, toTemplate } from './db.ts';
import { getSettings } from './settingsStore.ts';

export interface ChatMessage {
  /** Upstream chat roles only — 'tool' messages never leave the server. */
  role: Exclude<Role, 'tool'>;
  /** Empty only for a reasoning-only assistant prefill. */
  content: string;
  /** Preserve model reasoning when replaying assistant history/continuations. */
  reasoning_content?: string;
}

/** Merge adjacent same-role turns from tree edits/prologues for strict upstream APIs. */
export function appendChatMessage(messages: ChatMessage[], message: ChatMessage): void {
  if (message.role === 'system' && messages.length > 0) {
    const leading = messages[0]?.role === 'system' ? messages[0] : null;
    if (leading) {
      if (message.content) {
        leading.content = leading.content
          ? `${leading.content}\n\n${message.content}`
          : message.content;
      }
      return;
    }
    messages.unshift(message);
    return;
  }
  const previous = messages.at(-1);
  if (previous && previous.role === message.role) {
    if (message.content) {
      previous.content = previous.content
        ? `${previous.content}\n\n${message.content}`
        : message.content;
    }
    if (message.reasoning_content) {
      previous.reasoning_content = previous.reasoning_content
        ? `${previous.reasoning_content}\n\n${message.reasoning_content}`
        : message.reasoning_content;
    }
    return;
  }
  messages.push(message);
}

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

/** Inline templates replace referenced templates entirely; field defaults apply at use sites. */
function resolveTemplate(character: Character | null): CustomTemplate | null {
  return (
    character?.customTemplate ??
    getTemplate(character?.templateId ?? null) ??
    getTemplate(getSettings().defaultTemplateId)
  );
}

/** Old inline templates may lack steerTemplate; empty values also use the built-in default. */
export function resolveSteerTemplate(conversation: Conversation): string {
  const raw = resolveTemplate(getCharacter(conversation.characterId))?.steerTemplate ?? '';
  return raw.trim() || DEFAULT_STEER_TEMPLATE;
}

export function substituteMacros(text: string, charName: string, userName: string): string {
  return text.replaceAll(/\{\{(char|user)\}\}/gi, (_, key: string) =>
    key.toLowerCase() === 'char' ? charName : userName,
  );
}

/** Render {{#if key}} blocks and {{key}} slots, then collapse excess blank lines. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  // Resolve nested blocks innermost-first; exclude Object.prototype members from slots.
  const lookup = (key: string): string | undefined =>
    Object.hasOwn(vars, key) ? vars[key] : undefined;
  let out = template;
  for (let prev; prev !== out;) {
    prev = out;
    out = out.replaceAll(
      /\{\{#if ([a-z]+)\}\}((?:(?!\{\{#if )[\s\S])*?)\{\{\/if\}\}/gi,
      (_, key: string, body: string) => (lookup(key.toLowerCase())?.trim() ? body : ''),
    );
  }
  out = out.replaceAll(
    /\{\{([a-z]+)\}\}/gi,
    (match, key: string) => lookup(key.toLowerCase()) ?? match,
  );
  return out.replaceAll(/\n{3,}/g, '\n\n').trim();
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  /** Hidden reasoning seed for fresh generations. */
  reasoningPrefill: string | null;
  /** Visible content seed for fresh generations. */
  messagePrefill: string | null;
  /** "Name:" when the template prefixes speaker names. */
  namePrefill: string | null;
  /** Hidden fallback appended to the final user turn when prefills are disabled. */
  disabledPrefillSpeakerNote: string | null;
  /** {{char}}/{{user}} as this prompt resolved them (persona honors usesPersonas). */
  charName: string;
  userName: string;
}

/** Build the system prompt and active-path history for the reply's stamped speakerName. */
export function buildChatMessages(
  conversation: Conversation,
  history: Message[],
  speakerName: string | null = conversation.speakerName,
): BuiltPrompt {
  const character = getCharacter(conversation.characterId);
  const settings = getSettings();
  const template = resolveTemplate(character);

  const usesPersonas = template?.usesPersonas ?? true;
  const persona = usesPersonas ? getPersona(conversation.personaId) : null;
  const charName = character?.name ?? 'Assistant';
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
  const systemContent = renderTemplate(template?.content.trim() || DEFAULT_PROMPT_TEMPLATE, vars);
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

  const messages: ChatMessage[] = [];
  if (systemContent) appendChatMessage(messages, { role: 'system', content: systemContent });
  if (prologue) appendChatMessage(messages, { role: 'user', content: prologue });
  for (const msg of history) {
    if (msg.status === 'streaming') continue;
    if (msg.role === 'tool') continue; // plugin output is chat-visible only, never sent upstream
    const trimmedContent = msg.content.trim();
    const reasoning = msg.role === 'assistant' ? msg.reasoning?.trim() : '';
    // Preserve reasoning-only assistant turns in history.
    if (trimmedContent.length === 0 && !reasoning) continue;
    const content = prefixNames
      ? `${speakerFor(msg).trim()}: ${trimmedContent}`
      : trimmedContent || '(No visible response)';
    appendChatMessage(messages, {
      role: msg.role,
      content,
      ...(reasoning ? { reasoning_content: msg.reasoning! } : {}),
    });
  }

  const currentSpeaker = speakerName?.trim() || charName;
  const previousAssistant = history.findLast(
    (message) =>
      message.role === 'assistant' &&
      message.status !== 'streaming' &&
      (message.content.trim().length > 0 || !!message.reasoning?.trim()),
  );
  const previousSpeaker = previousAssistant ? speakerFor(previousAssistant).trim() : null;
  const needsDisabledPrefillSpeakerNote =
    prefixNames &&
    (currentSpeaker !== charName ||
      (currentSpeaker === charName && previousSpeaker != null && previousSpeaker !== charName));
  return {
    messages,
    reasoningPrefill: reasoningPrefill || null,
    messagePrefill: messagePrefill || null,
    namePrefill: prefixNames ? `${currentSpeaker}:` : null,
    disabledPrefillSpeakerNote: needsDisabledPrefillSpeakerNote
      ? `<Note: Reply as ${currentSpeaker}>`
      : null,
    charName,
    userName,
  };
}

/** Copies a prompt and appends its upstream-only speaker handoff to the final user turn. */
export function withDisabledPrefillSpeakerNote(built: BuiltPrompt): ChatMessage[] {
  const messages = built.messages.map((message) => ({ ...message }));
  const note = built.disabledPrefillSpeakerNote;
  if (!note) return messages;
  const userIndex = messages.findLastIndex((message) => message.role === 'user');
  if (userIndex !== -1) {
    const message = messages[userIndex]!;
    messages[userIndex] = { ...message, content: `${message.content}\n${note}` };
  } else {
    // Without user history, the handoff supplies a user turn for strict chat APIs.
    appendChatMessage(messages, { role: 'user', content: note });
  }
  return messages;
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
    content: substituteMacros(prompt.trim(), built.charName, built.userName),
  });
  return {
    ...built,
    reasoningPrefill: built.reasoningPrefill,
    messagePrefill: null,
    namePrefill: null,
    disabledPrefillSpeakerNote: null,
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
  appendChatMessage(built.messages, { role: 'user', content: steer });
  return built;
}

/** Append an image revision task, optionally retaining existing roleplay context. */
export function appendImagePromptRevisionTask(
  messages: ChatMessage[],
  original: string,
  originalReasoning: string | null,
  instruction: string,
): void {
  const originalBlock = `<original_image_prompt>\n${original.trim()}\n</original_image_prompt>`;
  // Replay the original prompt's reasoning as an assistant turn; bridge for strict alternation.
  if (messages.at(-1)?.role !== 'user') {
    appendChatMessage(messages, {
      role: 'user',
      content:
        '[IMAGE PROMPT REVISION CONTEXT]\nThe next assistant message is the original image-generation prompt to revise.',
    });
  }
  appendChatMessage(messages, {
    role: 'assistant',
    content: originalBlock,
    ...(originalReasoning?.trim() ? { reasoning_content: originalReasoning } : {}),
  });
  appendChatMessage(messages, {
    role: 'user',
    content:
      `[IMAGE PROMPT REVISION TASK]\n` +
      `The conversation above is reference context only. Do not continue the roleplay or answer its dialogue. ` +
      `Revise the specified image-generation prompt and return only the complete revised image-generation prompt, with no analysis, commentary, tags, or quotation marks. ` +
      `Preserve every detail that the revision does not explicitly change. Do not modify anything else.\n\n` +
      `The immediately preceding assistant message contains the original image prompt.\n\n` +
      `<revision_instruction>\n${instruction.trim()}\n</revision_instruction>`,
  });
}

/** Gallery revisions work even after the source conversation is deleted. */
export function buildImagePromptRevisionMessages(
  original: string,
  instruction: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  appendImagePromptRevisionTask(messages, original, null, instruction);
  return messages;
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
  appendImagePromptRevisionTask(built.messages, original, originalReasoning, instruction);
  return {
    ...built,
    reasoningPrefill: built.reasoningPrefill,
    messagePrefill: null,
    namePrefill: null,
    disabledPrefillSpeakerNote: null,
  };
}
