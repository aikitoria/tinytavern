import type { StandalonePromptTemplate } from './index.ts';
import {
  discoverWorkflowInputs,
  randomizeWorkflowSeeds,
  validateWorkflowValues,
  type MediaWorkflowInput,
  type MediaWorkflowValues,
} from './workflowInputs.ts';
export * from './workflowInputs.ts';

export const MEDIA_OPERATIONS = [
  { id: 'image', label: 'Create image', kind: 'image', slots: [] },
  { id: 'image-describe', label: 'Describe image', kind: 'text', slots: ['source'] },
  { id: 'image-edit', label: 'Image from references', kind: 'image', slots: [] },
  { id: 'video', label: 'Create video', kind: 'video', slots: [] },
  { id: 'video-first', label: 'Video from first frame', kind: 'video', slots: ['first_frame'] },
  { id: 'video-references', label: 'Video from references', kind: 'video', slots: [] },
] as const;

export type MediaOperation = (typeof MEDIA_OPERATIONS)[number]['id'];
export type MediaKind = 'image' | 'video';
export type MediaInputSlot = 'source' | 'first_frame' | 'reference1' | 'reference2' | 'reference3';
export type MediaReferenceCount = 0 | 1 | 2 | 3;

export interface MediaWorkflow {
  id: string;
  name: string;
  operation: MediaOperation;
  referenceCount: MediaReferenceCount;
  json: string;
  galleryPromptPresetId: string | null;
  chatPromptPresetId: string | null;
}

export interface MediaRenderingSettings {
  comfyUrl: string;
  workflows: MediaWorkflow[];
  /** Keys are mediaWorkflowKey(operation, referenceCount). */
  defaults: Record<string, string>;
  /** Null inherits the default Create image workflow. */
  avatarWorkflowId: string | null;
  jobTimeoutSeconds: number;
}

interface MediaPromptIdentity {
  id: string;
  name: string;
  operation: MediaOperation;
}

export type MediaPromptPreset = MediaPromptIdentity &
  (StandalonePromptTemplate | { chatPrompt: string });

export const MEDIA_PROMPT_SETTINGS_KEYS = [
  'galleryImagePrompts',
  'galleryVideoPrompts',
  'chatVideoPrompts',
] as const;
export type MediaPromptSettingsKey = (typeof MEDIA_PROMPT_SETTINGS_KEYS)[number];

export function mediaPromptSettingsKey(
  operation: MediaOperation,
  chat: boolean,
): MediaPromptSettingsKey {
  if (!operation.startsWith('video')) return 'galleryImagePrompts';
  return chat ? 'chatVideoPrompts' : 'galleryVideoPrompts';
}

/** Complete workflow selection used by the image prompt and avatar commands. */
export interface MediaImageConfig {
  workflow: MediaWorkflow;
  comfyUrl: string;
}

export interface MediaPromptSettings {
  presets: MediaPromptPreset[];
  defaults: Partial<Record<MediaOperation, string>>;
}

export const DEFAULT_MEDIA_RENDERING: MediaRenderingSettings = {
  comfyUrl: 'http://comfy:8588',
  workflows: [],
  defaults: {},
  avatarWorkflowId: null,
  jobTimeoutSeconds: 0,
};

export const DEFAULT_MEDIA_PROMPTS: MediaPromptSettings = { presets: [], defaults: {} };

export function mediaWorkflowKey(operation: MediaOperation, references: number): string {
  return `${operation}:${references}`;
}

export function operationHasReferences(operation: MediaOperation): boolean {
  return operation === 'image-edit' || operation === 'video-references';
}

export function mediaInputSlots(operation: MediaOperation, references: number): MediaInputSlot[] {
  const spec = MEDIA_OPERATIONS.find((item) => item.id === operation);
  if (!spec) throw new Error('Unknown media operation');
  if (
    !Number.isInteger(references) ||
    (operationHasReferences(operation) ? references < 1 || references > 3 : references !== 0)
  ) {
    throw new Error('Invalid reference count for this operation');
  }
  return [
    ...spec.slots,
    ...Array.from({ length: references }, (_, i) => `reference${i + 1}`),
  ] as MediaInputSlot[];
}

export function defaultChatMediaPrompt(operation: MediaOperation): string {
  const kind = operation.startsWith('video') ? 'video' : 'image';
  return `[System Note]\nUse the preceding conversation as reference context to write a detailed ${kind}-generation prompt. Return only the complete final prompt, without analysis or commentary.\n\n<generation_instruction>\n{{instruction}}\n</generation_instruction>`;
}

export function defaultMediaPrompt(operation: MediaOperation): StandalonePromptTemplate {
  const kind = operation.startsWith('video') ? 'video' : 'image';
  return {
    systemPrompt: `Write a detailed ${kind}-generation prompt from the supplied instruction. Return only the complete final prompt, without analysis or commentary.`,
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

export interface MediaJobDraft {
  workflowValues?: MediaWorkflowValues;
  reviewBeforeSave?: boolean;
  operation: MediaOperation;
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
  /** Captured render associations, or current input/chat associations before capture. */
  characterIds: number[];
  workflowValues: MediaWorkflowValues;
  id: number;
  draft: MediaDraft | null;
  revision: number;
  operation: MediaOperation;
  workflowId: string | null;
  workflowSnapshot: MediaWorkflow | null;
  presetId: string | null;
  state: MediaJobState;
  instruction: string;
  prompt: string;
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

export type WorkflowValues = { prompt: string; seed: number; job_id: string } & Partial<
  Record<MediaInputSlot, string>
>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const SLOTS = new Set([
  'prompt',
  'seed',
  'job_id',
  'source',
  'first_frame',
  'reference1',
  'reference2',
  'reference3',
]);
const MARKER = '\u001fTT:';

interface CompiledMediaWorkflow {
  graph: JsonValue;
  slots: ReadonlySet<string>;
  controls: MediaWorkflowInput[];
}

// Bound both small-workflow count and retained source size. Cache by content so
// editing a saved workflow never replaces a running job's captured graph.
const compiledWorkflows = new Map<string, CompiledMediaWorkflow>();
const MAX_COMPILED_WORKFLOWS = 64;
const MAX_COMPILED_SOURCE_LENGTH = 8 * 1024 * 1024;
let compiledSourceLength = 0;

/** Reuse the read-only compilation; expansion creates a fresh graph for every job. */
export function compileMediaWorkflow(json: string): CompiledMediaWorkflow {
  const cached = compiledWorkflows.get(json);
  if (cached) return cached;
  let inString = false;
  let escaped = false;
  let encoded = '';
  const slots = new Set<string>();
  for (let i = 0; i < json.length; i++) {
    const match = json.slice(i).match(/^\{\{([a-z_0-9]+)\}\}/i);
    if (match) {
      const key = match[1]!.toLowerCase();
      if (!SLOTS.has(key)) throw new Error(`Unknown workflow macro {{${key}}}`);
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
  // Reserved sample filenames let Comfy workflows run locally and export unchanged.
  for (const node of Object.values(graph)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    if (node.class_type !== 'LoadImage' && node.class_type !== 'LoadImageMask') continue;
    const inputs = node.inputs;
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) continue;
    if (typeof inputs.image !== 'string') continue;
    const match = inputs.image.match(
      /(?:^|\/)(source|first_frame|reference[123])\.png(?: \[input\])?$/,
    );
    if (!match) continue;
    const slot = match[1]!;
    inputs.image = `${MARKER}${slot}\u001f`;
    slots.add(slot);
  }
  const compiled = { graph, slots, controls: discoverWorkflowInputs(graph) };
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
      if (value === `${MARKER}seed\u001f`) return values.seed;
      return value.replace(/\u001fTT:([a-z_0-9]+)\u001f/g, (_, key: keyof WorkflowValues) => {
        const replacement = values[key];
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
    const required = mediaInputSlots(workflow.operation, workflow.referenceCount);
    if (!workflow.json.trim()) return 'Paste a Comfy API-format workflow';
    const compiled = compileMediaWorkflow(workflow.json);
    if (workflow.operation !== 'image-describe' && !compiled.slots.has('prompt'))
      return 'Include {{prompt}} in the workflow';
    if (workflow.operation === 'image-describe') {
      const nodes = Object.values(compiled.graph as Record<string, { class_type?: string }>);
      if (nodes.filter((node) => node?.class_type === 'PreviewAny').length !== 1)
        return 'Use exactly one Preview as Text node for the generated prompt';
    }
    for (const slot of required) {
      if (!compiled.slots.has(slot)) {
        return `Use ${slot}.png in a Load Image node, or include {{${slot}}} in the workflow`;
      }
    }
    for (const slot of compiled.slots) {
      if (
        !['prompt', 'seed', 'job_id'].includes(slot) &&
        !required.includes(slot as MediaInputSlot)
      )
        return `${slot} is not an input of this operation`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
