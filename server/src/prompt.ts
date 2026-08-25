import type {
  Character,
  Conversation,
  CustomTemplate,
  Message,
  Persona,
  Role,
  Template,
} from '@minitavern/shared';
import { DEFAULT_PROMPT_TEMPLATE, DEFAULT_STEER_TEMPLATE } from '@minitavern/shared';
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

/** Appends while preserving strict non-empty alternating chat roles. Tree
 * edits and optional prologues can legitimately produce adjacent turns with
 * the same role; fold those into one upstream turn instead of sending a shape
 * rejected by strict OpenAI-compatible APIs. */
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

interface ResolvedTemplate {
  custom: CustomTemplate | null;
  template: Template | null;
}

/**
 * The template chain for a conversation: the character's inline customTemplate
 * wins, then the character's templateId reference, then the global default
 * template. An inline template replaces the referenced template entirely (it
 * carries the same settings a template entity has); per-field built-in
 * defaults (DEFAULT_PROMPT_TEMPLATE, DEFAULT_STEER_TEMPLATE) apply at the
 * point of use when the resolved value is absent or empty.
 */
function resolveTemplate(character: Character | null): ResolvedTemplate {
  const custom = character?.customTemplate ?? null;
  const template = custom
    ? null
    : (getTemplate(character?.templateId ?? null) ?? getTemplate(getSettings().defaultTemplateId));
  return { custom, template };
}

/**
 * The steer format for a conversation, resolved through the same chain as the
 * template itself. An empty steerTemplate (including old inline-template blobs
 * that predate the key) falls back to the built-in DEFAULT_STEER_TEMPLATE.
 */
export function resolveSteerTemplate(conversation: Conversation): string {
  const { custom, template } = resolveTemplate(getCharacter(conversation.characterId));
  const raw = custom ? custom.steerTemplate : (template?.steerTemplate ?? '');
  return raw.trim() || DEFAULT_STEER_TEMPLATE;
}

export function substituteMacros(text: string, charName: string, userName: string): string {
  return text.replaceAll(/\{\{(char|user)\}\}/gi, (_, key: string) =>
    key.toLowerCase() === 'char' ? charName : userName,
  );
}

/**
 * Renders the prompt template: {{#if key}}...{{/if}} blocks are dropped when
 * the slot is empty, {{key}} slots are substituted, and leftover blank runs
 * are collapsed so a natural-looking template produces clean output.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  // Innermost-first (body may not contain another opener), looped to fixpoint so
  // nested blocks resolve outward instead of the first opener grabbing the first closer.
  // vars is a plain object: only own properties are slots, otherwise
  // {{constructor}}/{{hasownproperty}} would resolve to Object.prototype members.
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
  /** Hidden reasoning to seed on a fresh assistant generation. */
  reasoningPrefill: string | null;
  /** Visible assistant content to seed on a fresh generation. */
  messagePrefill: string | null;
  /** "Name:" to prefill the assistant turn with, when the template prefixes speaker names. */
  namePrefill: string | null;
  /** Hidden fallback appended to the final user turn when prefills are disabled. */
  disabledPrefillSpeakerNote: string | null;
  /** {{char}}/{{user}} as this prompt resolved them (persona honors usesPersonas). */
  charName: string;
  userName: string;
}

/**
 * Assembles the upstream chat completion messages: the system message rendered
 * from the (user-editable) prompt template, then the active-path history.
 * `speakerName` is the name the reply being generated was stamped with
 * (defaults to the conversation's current speaker).
 */
export function buildChatMessages(
  conversation: Conversation,
  history: Message[],
  speakerName: string | null = conversation.speakerName,
): BuiltPrompt {
  const character = getCharacter(conversation.characterId);
  const settings = getSettings();
  const { custom, template } = resolveTemplate(character);

  // A template can opt the chat out of personas entirely: {{user}} becomes
  // "User" and the persona description slot renders empty.
  const usesPersonas = custom ? custom.usesPersonas : (template?.usesPersonas ?? true);
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
  const systemContent = renderTemplate(
    (custom ? custom.content.trim() : template?.content.trim()) || DEFAULT_PROMPT_TEMPLATE,
    vars,
  );
  // Optional fake first user message (e.g. introducing the character); empty = not emitted.
  const prologueSource = custom ? custom.userPrologue : (template?.userPrologue ?? '');
  const prologue = prologueSource.trim() ? renderTemplate(prologueSource, vars) : '';
  const reasoningPrefillSource = custom
    ? custom.reasoningPrefill
    : (template?.reasoningPrefill ?? '');
  const reasoningPrefill = reasoningPrefillSource.trim()
    ? renderTemplate(reasoningPrefillSource, vars)
    : '';
  const messagePrefillSource = custom ? custom.messagePrefill : (template?.messagePrefill ?? '');
  const messagePrefill = messagePrefillSource.trim()
    ? renderTemplate(messagePrefillSource, vars)
    : '';

  const prefixNames = custom ? custom.prefixNames : (template?.prefixNames ?? false);
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
    // Reasoning-only assistant turns are still replayed. Some APIs accept
    // empty content alongside reasoning_content; the endpoint decides.
    if (trimmedContent.length === 0 && !reasoning) continue;
    // Stored history only ever carries user/assistant (tool is skipped above),
    // so every prefixed message has a speaker.
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
    // Root assistant generation can have no user history at all. The hidden
    // handoff becomes a synthetic user turn, which both preserves the speaker
    // instruction and gives strict chat APIs a valid turn to answer.
    appendChatMessage(messages, { role: 'user', content: note });
  }
  return messages;
}

/**
 * Upstream request for a plugin tool generation: the normal chat context plus
 * the tool's prompt (macros expanded) as a trailing user turn. No name
 * prefill — tool output is not a character reply.
 */
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
    reasoningPrefill: null,
    messagePrefill: null,
    namePrefill: null,
    disabledPrefillSpeakerNote: null,
  };
}

/**
 * Upstream request for a steered regeneration: the normal chat context (built
 * for the name the new sibling speaks with) plus the rendered steer text as a
 * trailing user message. That keeps strict user/assistant backends happy now
 * that the original assistant reply is included. The steer lives only in this
 * prompt — it is never stored, so later generations are unaffected.
 */
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

/** Revision of an image-tool output. The unchanged roleplay history stays as
 * the request prefix for cache reuse and contextual references. A strongly
 * delimited final user task tells the model that history is reference-only and
 * distinguishes the original image prompt from the requested change. */
export function buildSteeredToolPrompt(
  conversation: Conversation,
  history: Message[],
  original: string,
  originalReasoning: string | null,
  instruction: string,
): BuiltPrompt {
  const built = buildChatMessages(conversation, history);
  const originalBlock = `<original_image_prompt>\n${original.trim()}\n</original_image_prompt>`;
  // Always represent the model-produced tool output as an assistant turn so
  // its reasoning_content can be replayed too. Add a clear bridge only when
  // needed to preserve strict user/assistant alternation.
  if (built.messages.at(-1)?.role !== 'user') {
    appendChatMessage(built.messages, {
      role: 'user',
      content:
        '[IMAGE PROMPT REVISION CONTEXT]\nThe next assistant message is the original image-generation prompt to revise.',
    });
  }
  appendChatMessage(built.messages, {
    role: 'assistant',
    content: originalBlock,
    ...(originalReasoning?.trim() ? { reasoning_content: originalReasoning } : {}),
  });
  appendChatMessage(built.messages, {
    role: 'user',
    content:
      `[IMAGE PROMPT REVISION TASK]\n` +
      `The conversation above is reference context only. Do not continue the roleplay or answer its dialogue. ` +
      `Revise the specified image-generation prompt and return only the complete revised image-generation prompt, with no analysis, commentary, tags, or quotation marks. ` +
      `Preserve every detail that the revision does not explicitly change. Do not modify anything else.\n\n` +
      `The immediately preceding assistant message contains the original image prompt.\n\n` +
      `<revision_instruction>\n${instruction.trim()}\n</revision_instruction>`,
  });
  return {
    ...built,
    reasoningPrefill: null,
    messagePrefill: null,
    namePrefill: null,
    disabledPrefillSpeakerNote: null,
  };
}
