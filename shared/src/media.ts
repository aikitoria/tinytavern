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
/** Numbered image binding (input1–input64); legacy names are accepted during import. */
export type MediaInputSlot = string;
export type MediaInputContext = 'standalone' | 'chat' | 'avatar';
export type MediaInputSource = `selected:${number}` | 'character-avatar' | 'persona-avatar';
export type MediaInputBindings = Partial<
  Record<MediaInputContext, Record<string, MediaInputSource>>
>;

export interface MediaWorkflow {
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
  id: string;
  name: string;
  workflowId: string;
}

export interface MediaFavorite {
  id: string;
  name: string;
  presetId: string;
  workflowId: string;
}

export type MediaCollectionFolder<K extends string> = { id: string; name: string } & Record<
  K,
  string[]
>;
export type MediaWorkflowFolder = MediaCollectionFolder<'workflowIds'>;
export type MediaPromptFolder = MediaCollectionFolder<'presetIds'>;

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
  id: string;
  name: string;
}

export type MediaPromptPreset = MediaPromptIdentity &
  (StandalonePromptTemplate | { chatPrompt: string });

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
  return workflow.json.trim()
    ? compileMediaWorkflow(workflow.json).imageInputs.map((input) => input.name)
    : [];
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

/** Server-captured metadata for the selected image; clients submit only the selection. */
export interface MediaJobInputSnapshot extends MediaJobInput {
  prompt: string;
}

export interface MediaAssetInput {
  slot: MediaInputSlot;
  asset: MediaAsset | null;
}

/** Original render metadata, independent of editable gallery annotations. */
export interface MediaResultDetails {
  instruction: string;
  prompt: string;
  workflowSnapshot: MediaWorkflow | null;
  workflowValues: MediaWorkflowValues;
  seed: number | null;
}

export interface MediaDraft {
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
export function mergeMediaProgress(
  current: MediaProgress | undefined,
  update: MediaProgress,
): MediaProgress {
  const next = { ...current, ...update };
  if (update.videoPreview) {
    const frames =
      current?.videoPreview?.id === update.videoPreview.id
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
  avatarContext?: MediaAvatarContext | null;
  /** Captured render associations, or current input/chat associations before capture. */
  characterIds: number[];
  workflowValues: MediaWorkflowValues;
  id: number;
  draft: MediaDraft | null;
  revision: number;
  workflowId: string | null;
  workflowSnapshot: MediaWorkflow | null;
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
  return (
    state !== 'draft' &&
    state !== 'ready' &&
    state !== 'succeeded' &&
    state !== 'failed' &&
    state !== 'cancelled'
  );
}

export type WorkflowValues = { prompt: string; seed: number; job_id: string } & Record<
  string,
  string | number | undefined
>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const SYSTEM_SLOTS = new Set(['prompt', 'seed', 'job_id']);
export const MEDIA_INPUT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_MEDIA_INPUTS = 64;
export const NUMBERED_MEDIA_INPUT = /^input([1-9]|[1-5][0-9]|6[0-4])$/;
/** A prompt macro uses the same number as its image binding, including sparse inputs. */
export const MEDIA_INPUT_PROMPT_KEYS = Array.from(
  { length: MAX_MEDIA_INPUTS },
  (_, index) => `input${index + 1}_prompt`,
);
const legacyImageSlot = (name: string) =>
  /^(?:source|first_frame|reference[1-9][0-9]*)$/.test(name);

export function mediaInputLabel(name: string): string {
  if (NUMBERED_MEDIA_INPUT.test(name)) return `Input ${name.slice(5)}`;
  if (name === 'source') return 'Source image';
  if (name === 'first_frame') return 'First frame';
  const reference = /^reference([0-9]+)$/.exec(name);
  return reference ? `Reference ${reference[1]}` : name.replaceAll('_', ' ');
}

const MARKER = '\u001fTT:';

interface CompiledMediaWorkflow {
  graph: JsonValue;
  slots: ReadonlySet<string>;
  controls: MediaWorkflowInput[];
  imageInputs: { name: string; label: string }[];
}

// Bound both small-workflow count and retained source size. Cache by content so
// editing a saved workflow never replaces a running job's captured graph.
const compiledWorkflows = new Map<string, CompiledMediaWorkflow>();
const MAX_COMPILED_WORKFLOWS = 64;
const MAX_COMPILED_SOURCE_LENGTH = 8 * 1024 * 1024;
let compiledSourceLength = 0;

/** Reuse the read-only compilation; expansion creates a fresh graph for every job. */
export function compileMediaWorkflow(json: string, legacyOrder = false): CompiledMediaWorkflow {
  const cacheKey = legacyOrder ? `legacy:${json}` : json;
  const cached = compiledWorkflows.get(cacheKey);
  if (cached) return cached;
  let inString = false;
  let escaped = false;
  let encoded = '';
  const slots = new Set<string>();
  for (let i = 0; i < json.length; i++) {
    const match = json.slice(i).match(/^\{\{([a-z_0-9]+)\}\}/i);
    if (match) {
      const key = match[1]!.toLowerCase();
      if (escaped) throw new Error(`{{${key}}} must not follow an unpaired backslash`);
      if (key === 'seed' ? inString : !inString)
        throw new Error(
          key === 'seed'
            ? '{{seed}} must be a JSON number value'
            : `{{${key}}} must be inside a JSON string`,
        );
      const marker = JSON.stringify(`${MARKER}${key}\u001f`);
      encoded += inString ? marker.slice(1, -1) : marker;
      slots.add(key);
      i += match[0].length - 1;
      continue;
    }
    const char = json[i]!;
    encoded += char;
    if (escaped) escaped = false;
    else if (inString && char === '\\') escaped = true;
    else if (char === '"') inString = !inString;
  }
  const graph = JSON.parse(encoded) as JsonValue;
  if (!graph || typeof graph !== 'object' || Array.isArray(graph))
    throw new Error('Workflow must be an API-format JSON object');
  // Macros belong in input values, never node IDs or property names.
  const checkKeys = (value: JsonValue): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key.includes(MARKER)) throw new Error('Workflow macros cannot appear in object keys');
      checkKeys(child);
    }
  };
  checkKeys(graph);
  const labels = new Map<string, string>();
  // Titles override sample filenames. Only literal fields are bindable; never sever graph links.
  for (const [nodeId, node] of Object.entries(graph)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const inputs = node.inputs;
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) continue;
    const meta = node._meta;
    const title = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta.title : undefined;
    const annotation = typeof title === 'string' && /\[(?:image|prompt)\b/.test(title);
    if (annotation) {
      const match = title.match(
        /^(.*?)\s*\[(image:([a-z][a-z0-9_]*)|prompt)(?:,\s*field=([a-zA-Z_][a-zA-Z0-9_]*))?\]\s*$/,
      );
      if (!match)
        throw new Error(
          `Workflow node ${nodeId}: use Label [image:input1] through [image:input64], or Label [prompt], optionally with , field=input_name`,
        );
      const slot = match[3] ?? 'prompt';
      if (!legacyOrder && /^input\d/.test(slot) && !NUMBERED_MEDIA_INPUT.test(slot))
        throw new Error(`Workflow node ${nodeId}: image inputs must be input1 through input64`);
      if (!MEDIA_INPUT_NAME.test(slot) || (match[3] && SYSTEM_SLOTS.has(slot)))
        throw new Error(`Workflow node ${nodeId}: invalid image input name ${slot}`);
      const field =
        match[4] ??
        (match[3]
          ? 'image'
          : ['value', 'text', 'string'].find((key) => typeof inputs[key] === 'string'));
      if (!field || typeof inputs[field] !== 'string')
        throw new Error(
          `Workflow node ${nodeId}: bind a literal string field, or specify field=... in the title`,
        );
      inputs[field] = `${MARKER}${slot}\u001f`;
      if (match[3]) {
        const label = match[1]!.trim() || mediaInputLabel(slot);
        if (labels.has(slot) && labels.get(slot) !== label)
          throw new Error(`Image input ${slot} has conflicting labels`);
        labels.set(slot, label);
      }
      continue;
    }
    if (node.class_type !== 'LoadImage' && node.class_type !== 'LoadImageMask') continue;
    if (typeof inputs.image !== 'string') continue;
    const match = inputs.image.match(
      /(?:^|\/)(source|first_frame|reference[1-9][0-9]*)\.png(?: \[input\])?$/,
    );
    if (match) inputs.image = `${MARKER}${match[1]}\u001f`;
  }
  // Recompute after title bindings so overridden sample macros do not leave phantom inputs.
  slots.clear();
  const discoverSlots = (value: JsonValue): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\u001fTT:([a-z_0-9]+)\u001f/g)) {
        const name = match[1]!;
        if (
          !SYSTEM_SLOTS.has(name) &&
          !NUMBERED_MEDIA_INPUT.test(name) &&
          !legacyImageSlot(name) &&
          !labels.has(name)
        )
          throw new Error(
            `Unknown workflow macro {{${name}}}; use input1 through input64 for image bindings`,
          );
        slots.add(name);
      }
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) discoverSlots(child);
    }
  };
  discoverSlots(graph);
  const inputOrder = (name: string) =>
    !legacyOrder && NUMBERED_MEDIA_INPUT.test(name)
      ? Number(name.slice(5))
      : name === 'source'
        ? 0
        : name === 'first_frame'
          ? 1
          : /^reference[1-9][0-9]*$/.test(name)
            ? Number(name.slice(9)) + 1
            : Infinity;
  const imageInputs = [...slots]
    .filter((slot) => !SYSTEM_SLOTS.has(slot))
    .sort((a, b) => inputOrder(a) - inputOrder(b))
    .map((name) => ({ name, label: labels.get(name) ?? mediaInputLabel(name) }));
  if (imageInputs.length > MAX_MEDIA_INPUTS)
    throw new Error(`Workflows support at most ${MAX_MEDIA_INPUTS} image inputs`);
  const compiled = { graph, slots, imageInputs, controls: discoverWorkflowInputs(graph) };
  if (cacheKey.length <= MAX_COMPILED_SOURCE_LENGTH) {
    while (
      compiledWorkflows.size >= MAX_COMPILED_WORKFLOWS ||
      compiledSourceLength + cacheKey.length > MAX_COMPILED_SOURCE_LENGTH
    ) {
      const oldest = compiledWorkflows.keys().next().value!;
      compiledWorkflows.delete(oldest);
      compiledSourceLength -= oldest.length;
    }
    compiledWorkflows.set(cacheKey, compiled);
    compiledSourceLength += cacheKey.length;
  }
  return compiled;
}

/** Upgrade legacy bindings once at persistence/import boundaries; graph links stay intact. */
export function normalizeMediaWorkflowInputs(workflow: MediaWorkflow, legacyOrder = false) {
  let compiled = workflow.json.trim() ? compileMediaWorkflow(workflow.json, legacyOrder) : null;
  if (
    !legacyOrder &&
    compiled?.imageInputs.some((input) => !NUMBERED_MEDIA_INPUT.test(input.name))
  ) {
    legacyOrder = true;
    compiled = compileMediaWorkflow(workflow.json, true);
  }
  const inputs = compiled?.imageInputs ?? [];
  const slots = new Map(
    inputs.map((input, index) => [input.name, legacyOrder ? `input${index + 1}` : input.name]),
  );
  if (!compiled || [...slots].every(([before, after]) => before === after))
    return { workflow, slots };
  const graph = structuredClone(compiled.graph) as Record<
    string,
    { class_type?: string; inputs?: Record<string, JsonValue>; _meta?: { title?: string } }
  >;
  for (const node of Object.values(graph)) {
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    if (typeof node._meta?.title === 'string') {
      node._meta.title = node._meta.title.replace(
        /\[image:([a-z][a-z0-9_]*)/,
        (match, name: string) => (slots.has(name) ? `[image:${slots.get(name)}` : match),
      );
    }
    if (node.class_type === 'LoadImage' || node.class_type === 'LoadImageMask') {
      const input = inputs.find((input) => node.inputs!.image === `${MARKER}${input.name}\u001f`);
      if (input) {
        const name = slots.get(input.name)!;
        node.inputs.image = `${name}.png`;
        if (!node._meta?.title?.includes('[image:'))
          node._meta = { ...node._meta, title: `${input.label} [image:${name}]` };
      }
    }
  }
  const json = JSON.stringify(graph, null, 2)
    .replace(
      /\\u001fTT:([a-z_0-9]+)\\u001f/g,
      (_, name: string) => `{{${slots.get(name) ?? name}}}`,
    )
    .replace(/"\{\{seed\}\}"/g, '{{seed}}');
  const inputBindings = Object.fromEntries(
    Object.entries(workflow.inputBindings).map(([context, bindings]) => [
      context,
      Object.fromEntries(
        Object.entries(bindings).map(([slot, source]) => [slots.get(slot) ?? slot, source]),
      ),
    ]),
  );
  return { workflow: { ...workflow, json, inputBindings }, slots };
}

export function expandMediaWorkflow(
  compiled: ReturnType<typeof compileMediaWorkflow>,
  values: WorkflowValues,
  workflowValues: MediaWorkflowValues = {},
): Record<string, unknown> {
  const expand = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') {
      if (value === `${MARKER}seed\u001f`) return values.seed;
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
    const names = new Set(compiled.imageInputs.map((input) => input.name));
    for (const bindings of Object.values(workflow.inputBindings)) {
      for (const name of Object.keys(bindings)) {
        if (!names.has(name)) return `Automatic binding ${name} is not an input of this workflow`;
      }
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
