import type { StandalonePromptTemplate } from './index.ts';
import {
  discoverWorkflowInputs,
  randomizeWorkflowSeeds,
  validateWorkflowValues,
  type MediaWorkflowInput,
  type MediaWorkflowValues,
} from './workflowInputs.ts';
export * from './workflowInputs.ts';

export type MediaKind = 'image' | 'video';
/** Numbered media binding (input1–input64). */
export type MediaInputSlot = string;
export type MediaInputContext = 'standalone' | 'chat' | 'avatar';
export type MediaInputSource = `selected:${number}` | 'character-avatar' | 'persona-avatar';
export type MediaInputBindings = Partial<Record<MediaInputContext, Record<string, MediaInputSource>>>;

export interface MediaWorkflow {
  folderId?: string | null;
  revision?: number;
  id: string;
  name: string;
  json: string;
  standalonePromptPresetId: string | null;
  chatPromptPresetId: string | null;
  inputBindings: MediaInputBindings;
  /** Explicit history output binding for text consumers; media assets need no output kind. */
  textOutputNodeId: string | null;
}

export interface MediaWorkflowShortcut {
  revision?: number;
  position?: number;
  id: string;
  name: string;
  workflowId: string;
}

export interface MediaFavorite extends MediaWorkflowShortcut {
  presetId: string;
}

export interface MediaCollectionFolder {
  id: string;
  name: string;
}
export type MediaWorkflowFolder = MediaCollectionFolder;
export type MediaPromptFolder = MediaCollectionFolder;

export interface MediaRenderingSettings {
  folders: MediaWorkflowFolder[];
  comfyUrl: string;
  workflows: MediaWorkflow[];
  defaultWorkflowId: string | null;
  /** Null inherits the default workflow. */
  avatarWorkflowId: string | null;
  descriptionWorkflowId: string | null;
  shortcuts: MediaWorkflowShortcut[];
  jobTimeoutSeconds: number;
}

interface MediaPromptIdentity {
  folderId?: string | null;
  revision?: number;
  id: string;
  name: string;
}

export type MediaPromptPreset = MediaPromptIdentity & (StandalonePromptTemplate | { chatPrompt: string });

/** Maximum number of saved presets in each media prompt library. */
export const MAX_MEDIA_PRESETS = 4096;

export const MEDIA_PROMPT_SETTINGS_KEYS = ['mediaStandalonePrompts', 'mediaChatPrompts'] as const;
export type MediaPromptSettingsKey = (typeof MEDIA_PROMPT_SETTINGS_KEYS)[number];

export function mediaPromptSettingsKey(chat: boolean): MediaPromptSettingsKey {
  return chat ? 'mediaChatPrompts' : 'mediaStandalonePrompts';
}

/** Complete workflow selection used by quick prompts and avatar commands. */
export interface MediaImageConfig {
  workflow: MediaWorkflow;
  comfyUrl: string;
}

export interface MediaPromptSettings {
  folders: MediaPromptFolder[];
  presets: MediaPromptPreset[];
  defaultPresetId: string | null;
}

export const DEFAULT_MEDIA_RENDERING: MediaRenderingSettings = {
  folders: [],
  comfyUrl: 'http://comfy:8588',
  workflows: [],
  defaultWorkflowId: null,
  avatarWorkflowId: null,
  descriptionWorkflowId: null,
  shortcuts: [],
  jobTimeoutSeconds: 0,
};

export const DEFAULT_MEDIA_PROMPTS: MediaPromptSettings = {
  folders: [],
  presets: [],
  defaultPresetId: null,
};

export function mediaInputSlots(workflow: Pick<MediaWorkflow, 'json'>): MediaInputSlot[] {
  return workflow.json.trim() ? compileMediaWorkflow(workflow.json).mediaInputs.map((input) => input.name) : [];
}

export function defaultChatMediaPrompt(): string {
  return `<system_instruction>\nUse the preceding conversation as reference context to write a detailed media-generation prompt. Follow the supplied instruction and the requirements of the selected workflow. Return only the complete final prompt, without analysis or commentary.\n\n<generation_instruction>\n{{instruction}}\n</generation_instruction>\n</system_instruction>`;
}

export function defaultMediaPrompt(): StandalonePromptTemplate {
  return {
    systemPrompt:
      'Write a detailed media-generation prompt from the supplied instruction. Return only the complete final prompt, without analysis or commentary.',
    userMessage: '{{instruction}}',
    reasoningPrefill: '',
    messagePrefill: '',
  };
}

export interface MediaAsset {
  id: number;
  kind: MediaKind;
  url: string;
  mime: string;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  thumbnail: string | null;
  thumbnailRevision: number;
  recipeId: number | null;
}

export interface MediaJobInput {
  slot: MediaInputSlot;
  assetId: number;
}

/** Server-captured metadata for the selected media; clients submit only the selection. */
export interface MediaJobInputSnapshot extends MediaJobInput {
  prompt: string;
}

export interface MediaAssetInput {
  slot: MediaInputSlot;
  asset: MediaAsset | null;
}

/** Original render metadata, independent of editable gallery annotations. */
export interface MediaResultDetails {
  workflowName?: string | null;
  workflowParameters?: { label: string; value: string | number | boolean }[];
  workflowId: string | null;
  instruction: string;
  prompt: string;
  workflowValues: MediaWorkflowValues;
  seed: number | null;
}

export interface MediaDraft {
  conversationId?: number | null;
  id: number;
  revision: number;
  state: 'open' | 'accepted' | 'discarding';
  selectedAssetId: number | null;
  /** Results already owned by a chat or the gallery; saving keeps the draft open. */
  savedAssetIds: number[];
}

export interface MediaAvatarContext {
  kind: 'character' | 'persona';
  id: number;
}

export interface MediaInputFillContext {
  selectedAssetIds?: number[];
  avatar?: MediaAvatarContext;
}

export interface MediaJobDraft {
  /** Null selects a fresh random seed for each render. */
  seedOverride?: number | null;
  avatarContext?: MediaAvatarContext | null;
  fillInputs?: MediaInputFillContext;
  workflowValues?: MediaWorkflowValues;
  reviewBeforeSave?: boolean;
  workflowId?: string | null;
  presetId?: string | null;
  instruction?: string;
  prompt?: string;
  inputs?: MediaJobInput[];
  contextConversationId?: number | null;
  galleryFolderId?: number | null;
  destination?: 'gallery' | 'chat';
}

export type MediaJobState =
  | 'draft'
  | 'preparing'
  | 'ready'
  | 'submitting'
  | 'reconciling'
  | 'queued'
  | 'rendering'
  | 'downloading'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface MediaVideoPreview {
  /** Changes for each sampler preview sequence, even when a node runs again. */
  id: string;
  /** One complete denoise update; frame zero starts a new sequence. */
  sequence: string;
  nodeId: string;
  frameCount: number;
  frameRate: number;
  /** Job snapshots contain all cached frames; progress events carry changes only. */
  frames: Record<string, string | null>;
}

export interface ImageDescriptionProgress {
  state: MediaJobState;
  progress: MediaProgress;
}

export interface MediaProgress {
  value?: number;
  max?: number;
  preview?: string;
  videoPreview?: MediaVideoPreview | null;
  node?: { id: string; name: string } | null;
  graph?: { value: number; max: number };
}

/** Merge indexed frame updates without retaining frames from a previous sampler. */
export function mergeMediaProgress(current: MediaProgress | undefined, update: MediaProgress): MediaProgress {
  const next = { ...current, ...update };
  if (update.videoPreview) {
    const frames =
      current?.videoPreview?.id === update.videoPreview.id &&
      current.videoPreview.sequence === update.videoPreview.sequence
        ? { ...current.videoPreview.frames, ...update.videoPreview.frames }
        : { ...update.videoPreview.frames };
    for (const [index, frame] of Object.entries(frames)) {
      if (frame === null) delete frames[index];
    }
    next.videoPreview = { ...update.videoPreview, frames };
  }
  return next;
}

export interface MediaJob {
  workflowName?: string | null;
  workflowParameters?: { label: string; value: string | number | boolean }[];
  seedOverride?: number | null;
  promptMessageId?: number | null;
  avatarContext?: MediaAvatarContext | null;
  /** Captured render associations, or current input/chat associations before capture. */
  characterIds: number[];
  workflowValues: MediaWorkflowValues;
  id: number;
  draft: MediaDraft | null;
  revision: number;
  workflowId: string | null;
  presetId: string | null;
  state: MediaJobState;
  instruction: string;
  prompt: string;
  textResult: string | null;
  temporary: boolean;
  /** Transient prompt reasoning; cleared when content starts and never persisted. */
  reasoning?: string;
  inputs: MediaJobInputSnapshot[];
  assets: MediaAsset[];
  outputs: MediaAsset[];
  contextConversationId: number | null;
  galleryFolderId: number | null;
  messageId: number | null;
  destination: 'gallery' | 'chat';
  sourceJobId: number | null;
  seed: number | null;
  comfyPromptId: string | null;
  submitted: boolean;
  retrievalAvailable: boolean;
  error: string | null;
  cleanupPending: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  progress?: MediaProgress;
}

export function mediaJobActive(state: MediaJobState): boolean {
  return state !== 'draft' && state !== 'ready' && state !== 'succeeded' && state !== 'failed' && state !== 'cancelled';
}

export type WorkflowValues = { prompt: string; seed: number; job_id: string } & Record<
  string,
  string | number | undefined
>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const SYSTEM_SLOTS = new Set(['prompt', 'job_id']);
export const MAX_MEDIA_INPUTS = 64;
export const NUMBERED_MEDIA_INPUT = /^input([1-9]|[1-5][0-9]|6[0-4])$/;
/** A prompt macro uses the same number as its media binding, including sparse inputs. */
export const MEDIA_INPUT_PROMPT_KEYS = Array.from(
  { length: MAX_MEDIA_INPUTS },
  (_, index) => `input${index + 1}_prompt`,
);
export function mediaInputLabel(name: string): string {
  return `Input ${name.slice(5)}`;
}

const MARKER = '\u001fTT:';

interface CompiledMediaWorkflow {
  graph: JsonValue;
  slots: ReadonlySet<string>;
  controls: MediaWorkflowInput[];
  mediaInputs: { name: string; label: string; kind: MediaKind }[];
}

// Bound cached workflow count and source size; reuse each compiled definition across submissions.
const compiledWorkflows = new Map<string, CompiledMediaWorkflow>();
const MAX_COMPILED_WORKFLOWS = 64;
const MAX_COMPILED_SOURCE_LENGTH = 8 * 1024 * 1024;
let compiledSourceLength = 0;

/** Reuse the read-only compilation; expansion creates a fresh graph for every job. */
export function compileMediaWorkflow(json: string): CompiledMediaWorkflow {
  const cached = compiledWorkflows.get(json);
  if (cached) return cached;
  const slots = new Set<string>();
  const graph = JSON.parse(json, (_key, value: JsonValue) =>
    typeof value === 'string'
      ? value.replace(/\{\{([a-z_0-9]+)\}\}/gi, (_, key: string) => `${MARKER}${key.toLowerCase()}\u001f`)
      : value,
  ) as JsonValue;
  if (!graph || typeof graph !== 'object' || Array.isArray(graph))
    throw new Error('Workflow must be an API-format JSON object');
  // Macros belong in input values, never node IDs or property names.
  const checkKeys = (value: JsonValue): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key.includes(MARKER) || /\{\{[a-z_0-9]+\}\}/i.test(key))
        throw new Error('Workflow macros cannot appear in object keys');
      checkKeys(child);
    }
  };
  checkKeys(graph);
  const labels = new Map<string, string>();
  const kinds = new Map<string, MediaKind>();
  const bindKind = (slot: string, kind: MediaKind) => {
    if (kinds.has(slot) && kinds.get(slot) !== kind)
      throw new Error(`Media input ${slot} cannot be both image and video`);
    kinds.set(slot, kind);
  };
  // Titles override sample filenames. Only literal fields are bindable; never sever graph links.
  for (const [nodeId, node] of Object.entries(graph)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const inputs = node.inputs;
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) continue;
    const meta = node._meta;
    const title = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta.title : undefined;
    const annotation = typeof title === 'string' && /\[(?:image|video|prompt)\b/.test(title);
    if (annotation) {
      const match = title.match(
        /^(.*?)\s*\[((?:image|video):([a-z][a-z0-9_]*)|prompt)(?:,\s*field=([a-zA-Z_][a-zA-Z0-9_]*))?\]\s*$/,
      );
      if (!match)
        throw new Error(
          `Workflow node ${nodeId}: use Label [image:input1] or [video:input1] through input64, or Label [prompt], optionally with , field=input_name`,
        );
      const slot = match[3] ?? 'prompt';
      if (match[3] && !NUMBERED_MEDIA_INPUT.test(slot))
        throw new Error(`Workflow node ${nodeId}: media inputs must be input1 through input64`);
      const kind: MediaKind = match[2]!.startsWith('video:') ? 'video' : 'image';
      const field =
        match[4] ??
        (match[3]
          ? kind === 'video'
            ? 'file'
            : 'image'
          : ['value', 'text', 'string'].find((key) => typeof inputs[key] === 'string'));
      if (!field || typeof inputs[field] !== 'string')
        throw new Error(`Workflow node ${nodeId}: bind a literal string field, or specify field=... in the title`);
      inputs[field] = `${MARKER}${slot}\u001f`;
      if (match[3]) {
        bindKind(slot, kind);
        const label = match[1]!.trim() || `Input ${slot.slice(5)}`;
        if (labels.has(slot) && labels.get(slot) !== label)
          throw new Error(`Media input ${slot} has conflicting labels`);
        labels.set(slot, label);
      }
    }
  }
  for (const node of Object.values(graph)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const kind =
      node.class_type === 'LoadVideo'
        ? 'video'
        : node.class_type === 'LoadImage' || node.class_type === 'LoadImageMask'
          ? 'image'
          : null;
    const inputs = node.inputs;
    if (!kind || !inputs || typeof inputs !== 'object' || Array.isArray(inputs)) continue;
    const value = inputs[kind === 'video' ? 'file' : 'image'];
    if (typeof value === 'string')
      for (const match of value.matchAll(/\u001fTT:([a-z_0-9]+)\u001f/g))
        if (!SYSTEM_SLOTS.has(match[1]!)) bindKind(match[1]!, kind);
  }
  // Recompute after title bindings so overridden sample macros do not leave phantom inputs.
  slots.clear();
  const discoverSlots = (value: JsonValue): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\u001fTT:([a-z_0-9]+)\u001f/g)) {
        const name = match[1]!;
        if (!SYSTEM_SLOTS.has(name) && !NUMBERED_MEDIA_INPUT.test(name))
          throw new Error(`Unknown workflow macro {{${name}}}; use input1 through input64 for media bindings`);
        slots.add(name);
      }
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) discoverSlots(child);
    }
  };
  discoverSlots(graph);
  const mediaInputs = [...slots]
    .filter((slot) => !SYSTEM_SLOTS.has(slot))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .map((name) => ({
      name,
      label: labels.get(name) ?? `Input ${name.slice(5)}`,
      kind: kinds.get(name) ?? 'image',
    }));
  if (mediaInputs.length > MAX_MEDIA_INPUTS)
    throw new Error(`Workflows support at most ${MAX_MEDIA_INPUTS} media inputs`);
  const compiled = { graph, slots, mediaInputs, controls: discoverWorkflowInputs(graph) };
  if (json.length <= MAX_COMPILED_SOURCE_LENGTH) {
    while (
      compiledWorkflows.size >= MAX_COMPILED_WORKFLOWS ||
      compiledSourceLength + json.length > MAX_COMPILED_SOURCE_LENGTH
    ) {
      const oldest = compiledWorkflows.keys().next().value!;
      compiledWorkflows.delete(oldest);
      compiledSourceLength -= oldest.length;
    }
    compiledWorkflows.set(json, compiled);
    compiledSourceLength += json.length;
  }
  return compiled;
}

export function expandMediaWorkflow(
  compiled: ReturnType<typeof compileMediaWorkflow>,
  values: WorkflowValues,
  workflowValues: MediaWorkflowValues = {},
): Record<string, unknown> {
  const expand = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') {
      return value.replace(/\u001fTT:([a-z_0-9]+)\u001f/g, (_, key: keyof WorkflowValues) => {
        const replacement = Object.hasOwn(values, key) ? values[key] : undefined;
        if (replacement == null) throw new Error(`Missing workflow input: ${key}`);
        return String(replacement);
      });
    }
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)]));
    return value;
  };
  const overrides = validateWorkflowValues(compiled.controls, workflowValues);
  const graph = expand(compiled.graph) as Record<string, { inputs: Record<string, unknown> }>;
  randomizeWorkflowSeeds(graph, values.seed, compiled.controls);
  for (const control of compiled.controls) {
    if (Object.hasOwn(overrides, control.key)) {
      graph[control.nodeId]!.inputs[control.input] = overrides[control.key];
    }
  }
  return graph;
}

export function mediaWorkflowError(workflow: MediaWorkflow): string | null {
  try {
    if (!workflow.json.trim()) return 'Paste a Comfy API-format workflow';
    const compiled = compileMediaWorkflow(workflow.json);
    if (workflow.textOutputNodeId !== null) {
      const node = (compiled.graph as Record<string, unknown>)[workflow.textOutputNodeId];
      if (!node || typeof node !== 'object') return 'Choose an existing node for the text output';
    }
    const names = new Map(compiled.mediaInputs.map((input) => [input.name, input.kind]));
    for (const bindings of Object.values(workflow.inputBindings)) {
      for (const [name, source] of Object.entries(bindings)) {
        if (!names.has(name)) return `Automatic binding ${name} is not an input of this workflow`;
        if (names.get(name) === 'video' && !source.startsWith('selected:'))
          return `Video input ${name} requires selected video media, not an avatar`;
      }
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
