export type MediaWorkflowValues = Record<string, number | string | boolean>;

interface WorkflowInputBase {
  key: string;
  nodeId: string;
  input: string;
  label: string;
  /** Optional display suffix for numeric controls; never changes the submitted value. */
  unit?: string;
}

export type MediaWorkflowInput = WorkflowInputBase &
  (
    | { type: 'int' | 'float'; value: number; min?: number; max?: number; step: number }
    | { type: 'string'; value: string; multiline: boolean }
    | { type: 'boolean'; value: boolean }
    | { type: 'select'; value: string; options: readonly string[] }
  );

const INPUT_NODES: Record<
  string,
  { type: 'int' | 'float' | 'string' | 'boolean'; input: string; multiline?: boolean }
> = {
  ResolutionSelector: { type: 'float', input: 'megapixels' },
  PrimitiveInt: { type: 'int', input: 'value' },
  PrimitiveFloat: { type: 'float', input: 'value' },
  PrimitiveBoolean: { type: 'boolean', input: 'value' },
  BOOLConstant: { type: 'boolean', input: 'value' },
  PrimitiveString: { type: 'string', input: 'value' },
  PrimitiveStringMultiline: { type: 'string', input: 'value', multiline: true },
  INTConstant: { type: 'int', input: 'value' },
  FloatConstant: { type: 'float', input: 'value' },
  StringConstant: { type: 'string', input: 'string' },
  StringConstantMultiline: { type: 'string', input: 'string', multiline: true },
};

// ComfyUI/comfy_extras/nodes_resolution.py: values must match its AspectRatio enum.
const RESOLUTION_ASPECT_RATIOS = [
  '1:1 (Square)',
  '2:3 (Portrait Photo)',
  '3:2 (Photo)',
  '3:4 (Portrait Standard)',
  '4:3 (Standard)',
  '9:16 (Portrait Widescreen)',
  '16:9 (Widescreen)',
  '21:9 (Ultrawide)',
];

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

/** Only explicitly annotated, supported nodes become user controls. */
export function discoverWorkflowInputs(graph: Record<string, unknown>): MediaWorkflowInput[] {
  const controls: MediaWorkflowInput[] = [];
  const orders = new Map<string, number>();
  for (const [nodeId, raw] of Object.entries(graph)) {
    const node = object(raw);
    if (!node) continue;
    const title = object(node?._meta)?.title;
    if (typeof title !== 'string' || !/\[input\b/.test(title)) continue;
    const fail: (message: string) => never = (message) => {
      throw new Error(`Workflow node ${nodeId} (${title}): ${message}`);
    };
    const match = title.match(/^(.+?)\s*\[input(?:(?::\s*|\s+)([^\]]*))?\]\s*$/);
    if (!match || !match[1]!.trim()) fail('Use Label [input: parameter=value, ...]');
    const classType = String(node.class_type);
    const resolution = classType === 'ResolutionSelector';
    const spec = Object.hasOwn(INPUT_NODES, classType) ? INPUT_NODES[classType] : undefined;
    if (!spec) fail('Expose a supported constant node or Resolution Selector');
    const parameters = new Map<string, string>();
    if (match[2]?.trim()) {
      for (const part of match[2].split(',')) {
        const parameter = part.trim().match(/^(\w+)\s*=\s*(\S+)$/);
        if (!parameter) fail('Parameters must be comma-separated name=value pairs');
        const [, key, value] = parameter;
        if (parameters.has(key!)) fail(`Duplicate parameter ${key}`);
        parameters.set(key!, value!);
      }
    }
    const allowed =
      spec.type === 'int' || spec.type === 'float'
        ? ['min', 'max', 'step', 'order', 'unit']
        : ['order'];
    for (const key of parameters.keys()) {
      if (!allowed.includes(key)) fail(`Unknown ${spec.type} parameter ${key}`);
    }
    const number = (key: string): number | undefined => {
      const raw = parameters.get(key);
      if (raw === undefined) return undefined;
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) {
        fail(`${key} must be a finite number`);
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) fail(`${key} must be a finite number`);
      if ((key === 'order' || spec.type !== 'float') && !Number.isInteger(value)) {
        fail(`${key} must be an integer`);
      }
      return value;
    };
    const order = number('order');
    if (order !== undefined) orders.set(nodeId, order);
    const value = object(node.inputs)?.[spec.input];
    const label = match[1]!.trim();
    const defaultResolutionLabel = resolution && label.toLowerCase() === 'resolution';
    const base = {
      key: resolution ? `${nodeId}.megapixels` : nodeId,
      nodeId,
      input: spec.input,
      label: defaultResolutionLabel ? 'Megapixels' : resolution ? `${label} megapixels` : label,
      unit: parameters.get('unit') ?? (resolution ? 'MP' : undefined),
    };
    let control: MediaWorkflowInput;
    if (spec.type === 'boolean') {
      control = { ...base, type: 'boolean', value: value as boolean };
    } else if (spec.type === 'string') {
      if (typeof value !== 'string' || value.includes('\u001fTT:')) {
        fail('The string input must contain a literal default, without workflow macros or links');
      }
      control = {
        ...base,
        type: 'string',
        value,
        multiline: spec.multiline === true,
      };
    } else {
      const min = number('min') ?? (resolution ? 0.1 : undefined);
      const max = number('max') ?? (resolution ? 16 : undefined);
      if (resolution && (min! < 0.1 || max! > 16)) {
        fail('Resolution megapixel limits must be within 0.1–16');
      }
      const step = number('step') ?? (spec.type === 'int' ? 1 : 0.1);
      if (min !== undefined && max !== undefined && min > max) fail('min must not exceed max');
      if (step <= 0) fail('step must be positive');
      control = { ...base, type: spec.type, value: value as number, min, max, step };
    }
    const error = workflowInputError(control, value);
    if (error) fail(`Invalid default: ${error}`);
    if (resolution) {
      const aspectRatio: MediaWorkflowInput = {
        key: `${nodeId}.aspect_ratio`,
        nodeId,
        input: 'aspect_ratio',
        label: defaultResolutionLabel ? 'Aspect ratio' : `${label} aspect ratio`,
        type: 'select',
        value: object(node.inputs)?.aspect_ratio as string,
        options: RESOLUTION_ASPECT_RATIOS,
      };
      const error = workflowInputError(aspectRatio, aspectRatio.value);
      if (error) fail(`Invalid default: ${error}`);
      controls.push(aspectRatio);
    }
    controls.push(control);
  }
  const keys = new Set<string>();
  for (const control of controls) {
    if (keys.has(control.key)) throw new Error(`Duplicate workflow input key ${control.key}`);
    keys.add(control.key);
  }
  return controls.sort((a, b) => {
    const first = orders.get(a.nodeId);
    const second = orders.get(b.nodeId);
    if (first === undefined) return second === undefined ? 0 : 1;
    if (second === undefined) return -1;
    return first - second;
  });
}

export function workflowInputError(control: MediaWorkflowInput, value: unknown): string | null {
  if (control.type === 'select') {
    return typeof value === 'string' && control.options.includes(value)
      ? null
      : `Choose a valid ${control.label}`;
  }
  if (control.type === 'boolean') {
    return typeof value === 'boolean' ? null : `${control.label} must be true or false`;
  }
  if (control.type === 'string') {
    if (typeof value !== 'string') return `${control.label} must be text`;
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value))
    return `${control.label} must be a number`;
  if (control.type === 'int' && !Number.isInteger(value))
    return `${control.label} must be an integer`;
  if (control.min !== undefined && value < control.min)
    return `${control.label} must be at least ${control.min}`;
  if (control.max !== undefined && value > control.max)
    return `${control.label} must be at most ${control.max}`;
  const steps = (value - (control.min ?? 0)) / control.step;
  if (!Number.isFinite(steps) || Math.abs(steps - Math.round(steps)) > 1e-7) {
    return `${control.label} must use steps of ${control.step} from ${control.min ?? 0}`;
  }
  return null;
}

/** Validate overrides without coercing types or changing omitted defaults. */
export function validateWorkflowValues(
  controls: MediaWorkflowInput[],
  raw: unknown,
): MediaWorkflowValues {
  const values = object(raw);
  if (!values) throw new Error('Workflow values must be an object');
  const byId = new Map(controls.map((control) => [control.key, control]));
  const entries: [string, string | number | boolean][] = [];
  for (const [id, value] of Object.entries(values)) {
    const control = byId.get(id);
    if (!control) throw new Error(`Unknown workflow input node ${id}`);
    const error = workflowInputError(control, value);
    if (error) throw new Error(error);
    entries.push([id, value as string | number | boolean]);
  }
  return Object.fromEntries(entries);
}

/** Keep the graph's wiring; linked seed constants are updated at their source. */
export function randomizeWorkflowSeeds(
  graph: Record<string, unknown>,
  seed: number,
  controls: MediaWorkflowInput[],
): void {
  const exposed = new Set(controls.map((control) => control.nodeId));
  for (const [nodeId, raw] of Object.entries(graph)) {
    const inputs = object(object(raw)?.inputs);
    if (!inputs || exposed.has(nodeId)) continue;
    for (const key of Object.keys(inputs)) {
      if (
        key !== 'seed' &&
        key !== 'noise_seed' &&
        !key.endsWith('.seed') &&
        !key.endsWith('.noise_seed')
      )
        continue;
      const value = inputs[key];
      if (typeof value === 'number') {
        inputs[key] = seed;
      } else if (Array.isArray(value) && value.length === 2 && value[1] === 0) {
        const sourceId = String(value[0]);
        const source = object(graph[sourceId]);
        const spec = INPUT_NODES[String(source?.class_type)];
        const sourceInputs = object(source?.inputs);
        if (
          !exposed.has(sourceId) &&
          spec?.type === 'int' &&
          sourceInputs &&
          typeof sourceInputs[spec.input] === 'number'
        ) {
          sourceInputs[spec.input] = seed;
        }
      }
    }
  }
}
