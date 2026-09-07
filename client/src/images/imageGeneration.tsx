import SettingLabel, { createDefaultField } from '../components/SettingField.tsx';
import {
  faCheck,
  faChevronLeft,
  faChevronRight,
  faImages as faImagesSolid,
  faPlus,
  faSpinner,
  faXmark,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import { faFileLines, faImage, faImages } from '@fortawesome/free-regular-svg-icons';
import FontAwesomeIcon from '../components/FontAwesomeIcon.tsx';
import { For, Show, createSignal, onMount, type JSX } from 'solid-js';
import {
  DEFAULT_CHAT_IMAGE_REVISION_TEMPLATE,
  imageRevisionTemplateError,
  workflowValidationError,
  type Message,
} from '@tinytavern/shared';
import type { ComposerCommand } from '../composerCommands.ts';
import { api, ApiError } from '../state/api.ts';
import {
  activePath,
  applyGalleryItem,
  applySettings,
  imageProgress,
  navigateTree,
  openModal,
  state,
  toast,
} from '../state/store.ts';
import { createSavedFlash, errorMessage } from '../util.ts';
import ImageViewer from '../components/ImageViewer.tsx';
import MacroHelp from '../components/MacroHelp.tsx';
import MacroTextarea from '../components/MacroTextarea.tsx';
import Markdown from '../components/Markdown.tsx';
import Select from '../components/Select.tsx';
import { useSettingsGuard } from '../components/SettingsGuard.tsx';
import CrossfadeImage from './CrossfadeImage.tsx';
import SamplerProgress from './SamplerProgress.tsx';
import './imageGeneration.css';

interface ImageWorkflow {
  name: string;
  /** ComfyUI workflow (API format JSON) with {{prompt}}/{{seed}} slots. */
  json: string;
}

interface ImagePromptPreset {
  name: string;
  prompt: string;
  /** Optional second message paired with this preset (avatar presets only). */
  context?: string;
}

interface ImagePromptPresetSet {
  presets: ImagePromptPreset[];
  /** Name of the selected preset; '' selects the built-in default. */
  active: string;
}

type ImagePromptKind =
  'describe' | 'characterInstruction' | 'face' | 'faceInstruction' | 'instruction' | 'avatar';

const IMAGE_PROMPT_SECTIONS = [
  {
    key: 'character',
    title: 'Character images',
    hint: 'Prompts used by `/imagechar`, with and without an instruction.',
  },
  {
    key: 'face',
    title: 'Face images',
    hint: 'Prompts used by `/imageface`, with and without an instruction.',
  },
  {
    key: 'generic',
    title: 'Generic images',
    hint: 'The instruction-based prompt used by `/image`.',
  },
  {
    key: 'avatar',
    title: 'Avatars',
    hint: 'Prompt, context, and rendering workflow used by Generate avatar.',
  },
] as const;

interface ImageGenSettings extends Record<string, unknown> {
  promptRevisionTemplate: string;
  promptPresets: Record<ImagePromptKind, ImagePromptPresetSet>;
  comfyUrl: string;
  workflows: ImageWorkflow[];
  /** Name of the workflow /image renders with; '' = describe only, no image. */
  activeWorkflow: string;
  /** Name of the workflow avatars render with; '' = same as activeWorkflow. */
  avatarWorkflow: string;
}

const DEFAULT_PROMPTS: Record<ImagePromptKind, string> = {
  describe:
    "Describe {{char}}'s current appearance and surroundings as a single detailed image-generation prompt. Reply with only the prompt.",
  characterInstruction:
    "Describe {{char}}'s current appearance and surroundings as a single detailed image-generation prompt. Apply this instruction: {{instruction}}. Reply with only the prompt.",
  face: "Describe {{char}}'s face and current appearance as a single detailed close-up portrait image-generation prompt. Focus on facial features, hair, expression, and lighting. Reply with only the prompt.",
  faceInstruction:
    "Describe {{char}}'s face and current appearance as a single detailed close-up portrait image-generation prompt. Focus on facial features, hair, expression, and lighting, and apply this instruction: {{instruction}}. Reply with only the prompt.",
  instruction: '{{instruction}}',
  avatar:
    'Write an image-generation prompt for a portrait avatar. Head and shoulders, facing forward. Reply with only the prompt.',
};

const DEFAULT_AVATAR_CONTEXT =
  'Name: {{name}}\nAvatar details: {{description}}\nScenario: {{scenario}}\nFirst message: {{firstMessage}}';

const WORKFLOW_MACROS: [string, string][] = [
  ['{{prompt}}', 'The generated image description (JSON-string-escaped into the workflow)'],
  ['{{seed}}', 'A random integer seed, fresh per render'],
];

const AVATAR_MACROS: [string, string][] = [
  ['{{name}}', 'Character or persona name'],
  ['{{char}}', 'Character name (characters only)'],
  ['{{user}}', 'Persona name (the default persona for characters)'],
  ['{{description}}', 'Character personality / persona description'],
  ['{{personality}}', 'Character personality (characters only)'],
  ['{{scenario}}', 'Character scenario (characters only)'],
  ['{{firstMessage}}', 'Character first message (characters only)'],
];

const PROMPT_EDITORS: {
  kind: ImagePromptKind;
  section: (typeof IMAGE_PROMPT_SECTIONS)[number]['key'];
  label: string;
  legacyKey?: 'describePrompt' | 'instructionPrompt' | 'avatarPrompt';
  command?: string;
}[] = [
  {
    kind: 'describe',
    section: 'character',
    label: 'Without an instruction',
    legacyKey: 'describePrompt',
  },
  {
    kind: 'characterInstruction',
    section: 'character',
    label: 'With an instruction',
    command: '/imagechar',
  },
  {
    kind: 'face',
    section: 'face',
    label: 'Without an instruction',
  },
  {
    kind: 'faceInstruction',
    section: 'face',
    label: 'With an instruction',
    command: '/imageface',
  },
  {
    kind: 'instruction',
    section: 'generic',
    label: 'Prompt template',
    command: '/image',
    legacyKey: 'instructionPrompt',
  },
  {
    kind: 'avatar',
    section: 'avatar',
    label: 'Avatar prompt',
    legacyKey: 'avatarPrompt',
  },
];
const AVATAR_EXTRA_KEYS = ['name', 'description', 'personality', 'scenario', 'firstMessage'];

function promptRecord<T>(
  read: (editor: (typeof PROMPT_EDITORS)[number]) => T,
): Record<ImagePromptKind, T> {
  const values = {} as Record<ImagePromptKind, T>;
  for (const editor of PROMPT_EDITORS) values[editor.kind] = read(editor);
  return values;
}

const DEFAULTS: ImageGenSettings = {
  promptRevisionTemplate: DEFAULT_CHAT_IMAGE_REVISION_TEMPLATE,
  promptPresets: promptRecord(() => ({ presets: [], active: '' })),
  comfyUrl: 'http://comfy:8588',
  workflows: [],
  activeWorkflow: '',
  avatarWorkflow: '',
};

function normalizePromptPresets(
  cfg: Record<string, unknown>,
  kind: ImagePromptKind,
  legacyKey?: 'describePrompt' | 'instructionPrompt' | 'avatarPrompt',
): ImagePromptPresetSet {
  const allPresets = cfg.promptPresets;
  const raw =
    typeof allPresets === 'object' && allPresets !== null
      ? (allPresets as Partial<Record<ImagePromptKind, ImagePromptPresetSet>>)[kind]
      : undefined;
  if (raw && Array.isArray(raw.presets)) {
    const presets = raw.presets.filter(
      (preset): preset is ImagePromptPreset =>
        typeof preset?.name === 'string' &&
        typeof preset.prompt === 'string' &&
        (preset.context === undefined || typeof preset.context === 'string'),
    );
    const active =
      typeof raw.active === 'string' && presets.some((preset) => preset.name === raw.active)
        ? raw.active
        : '';
    return { presets, active };
  }

  // Preserve legacy customizations as presets; keep built-in defaults unsaved.
  const legacy = legacyKey ? cfg[legacyKey] : undefined;
  if (typeof legacy === 'string' && legacy !== DEFAULT_PROMPTS[kind]) {
    return { presets: [{ name: 'Custom', prompt: legacy }], active: 'Custom' };
  }
  return { presets: [], active: '' };
}

function settings(): ImageGenSettings {
  const stored = state.settings.imageGeneration;
  const cfg = { ...DEFAULTS, ...stored } as ImageGenSettings;
  const promptPresets = promptRecord(({ kind, legacyKey }) =>
    normalizePromptPresets(stored, kind, legacyKey),
  );
  // Migrate the pre-multi-workflow shape (single workflowJson string).
  const legacy = (cfg as Record<string, unknown>).workflowJson;
  if (cfg.workflows.length === 0 && typeof legacy === 'string' && legacy.trim()) {
    return {
      ...cfg,
      promptPresets,
      workflows: [{ name: 'Default', json: legacy }],
      activeWorkflow: 'Default',
    };
  }
  return { ...cfg, promptPresets };
}

function selectedPrompt(
  cfg: ImageGenSettings,
  kind: ImagePromptKind,
  /** undefined = active setting; null = built-in Default; string = named preset. */
  presetName?: string | null,
): string {
  const selection = cfg.promptPresets[kind];
  const name = presetName === undefined ? selection.active : presetName;
  return selection.presets.find((preset) => preset.name === name)?.prompt ?? DEFAULT_PROMPTS[kind];
}

/** Validate at save time with the server's rules; allow empty placeholders. */
function workflowError(workflow: string): string | null {
  return workflow.trim() ? workflowValidationError(workflow) : null;
}

/** {{char}}/{{user}} expand server-side using the conversation context. */
function composePrompt(
  kind: Exclude<ImagePromptKind, 'avatar'>,
  instruction = '',
  presetName?: string | null,
): string {
  const template = selectedPrompt(settings(), kind, presetName);
  // A callback preserves literal $-sequences in the instruction.
  return template.replaceAll(/\{\{instruction\}\}/gi, () => instruction);
}

export function activeImageRenderConfig(): { workflow: string; comfyUrl: string } | undefined {
  const cfg = settings();
  const active = cfg.workflows.find((workflow) => workflow.name === cfg.activeWorkflow);
  return active?.json.trim() ? { workflow: active.json, comfyUrl: cfg.comfyUrl } : undefined;
}

/** Fall back to the /image workflow when no avatar workflow resolves. */
export function avatarRenderConfig(): { workflow: string; comfyUrl: string } | undefined {
  const cfg = settings();
  const avatar = cfg.workflows.find((workflow) => workflow.name === cfg.avatarWorkflow);
  return avatar?.json.trim()
    ? { workflow: avatar.json, comfyUrl: cfg.comfyUrl }
    : activeImageRenderConfig();
}

export function avatarGenerationAvailable(): boolean {
  return avatarRenderConfig() != null;
}

/** Both templates expand server-side using authoritative entity fields. */
export function avatarPromptTemplates(): { prompt: string; context: string } {
  const selection = settings().promptPresets.avatar;
  const preset = selection.presets.find((candidate) => candidate.name === selection.active);
  return {
    prompt: preset?.prompt ?? DEFAULT_PROMPTS.avatar,
    context: preset?.context ?? DEFAULT_AVATAR_CONTEXT,
  };
}

/** Stream a tool prompt, then render it if a workflow is selected. */
async function generate(
  kind: Exclude<ImagePromptKind, 'avatar'>,
  instruction = '',
  presetName?: string | null,
): Promise<boolean> {
  if (state.selectedId == null) {
    toast('No conversation selected.', 'warning');
    return false;
  }
  return navigateTree(() =>
    api.toolGenerate(
      state.selectedId!,
      composePrompt(kind, instruction, presetName),
      'Image prompt',
      state.tree,
      activeImageRenderConfig(),
    ),
  );
}

/** Preset actions override the selection for one generation only. */
function promptTools(kind: 'describe' | 'face', subject: 'Character' | 'Face') {
  const presets = settings().promptPresets[kind].presets;
  const baseLabel = `Generate ${subject} Image`;
  if (presets.length === 0) {
    return [
      {
        label: baseLabel,
        icon: () => <FontAwesomeIcon icon={faImage} size={16} />,
        run: () => void generate(kind),
      },
    ];
  }
  return [
    { name: 'Default', presetName: null },
    ...presets.map((preset) => ({ name: preset.name, presetName: preset.name })),
  ].map(({ name, presetName }) => ({
    label: `${baseLabel} — ${name}`,
    icon: () => <FontAwesomeIcon icon={faImage} size={16} />,
    run: () => void generate(kind, '', presetName),
  }));
}

export function imageGenerationTools() {
  return [...promptTools('describe', 'Character'), ...promptTools('face', 'Face')];
}

/** Names identify active selections, so copies must have unique names. */
function copyName(base: string, taken: (name: string) => boolean): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base} (copy)` : `${base} (copy ${n})`;
    if (!taken(candidate)) return candidate;
  }
}

/** The same available built-in name is used when adding an item or reverting its name. */
function numberedName(prefix: string, items: readonly { name: string }[], index = items.length) {
  let number = index + 1;
  while (items.some((item, i) => i !== index && item.name === `${prefix} ${number}`)) number++;
  return `${prefix} ${number}`;
}

interface PromptPresetEditorHandle {
  value: ImagePromptPresetSet;
}

/** Never serialize Default, so updated defaults remain available alongside saved prompts. */
function PromptPresetEditor(props: {
  label: JSX.Element;
  defaultPrompt: string;
  extraKeys?: string[];
  defaultContext?: string;
  contextLabel?: JSX.Element;
  contextExtraKeys?: string[];
  ref?: PromptPresetEditorHandle | ((handle: PromptPresetEditorHandle) => void);
}) {
  const [presets, setPresets] = createSignal<ImagePromptPreset[]>([]);
  /** Index into presets(); -1 = built-in Default. */
  const [selected, setSelected] = createSignal(-1);
  const [renaming, setRenaming] = createSignal(false);
  const nameEl = createDefaultField(() =>
    selected() < 0 ? '' : numberedName('Preset', presets(), selected()),
  );
  const promptEl = createDefaultField(() => props.defaultPrompt);
  const contextEl = createDefaultField(() => props.defaultContext ?? '');
  const pickerEl = createDefaultField(() => '-1');

  const currentPresets = () => {
    const idx = selected();
    return presets().map((preset, i) => {
      if (i !== idx) return preset;
      return {
        name: nameEl.value.trim() || preset.name,
        prompt: promptEl.value,
        ...(props.defaultContext === undefined ? {} : { context: contextEl.value }),
      };
    });
  };

  const stash = () => setPresets(currentPresets());

  const showPreset = (idx: number) => {
    setSelected(idx);
    setRenaming(false);
    pickerEl.value = String(idx);
    const preset = presets()[idx];
    nameEl.value = preset?.name ?? '';
    promptEl.value = preset?.prompt ?? props.defaultPrompt;
    (promptEl.element() as HTMLTextAreaElement).readOnly = idx === -1;
    if (props.defaultContext !== undefined) {
      contextEl.value = preset?.context ?? props.defaultContext;
      (contextEl.element() as HTMLTextAreaElement).readOnly = idx === -1;
    }
  };

  const pick = (idx: number) => {
    stash();
    showPreset(idx);
  };

  const add = () => {
    const startingPrompt = promptEl.value;
    const startingContext = props.defaultContext === undefined ? undefined : contextEl.value;
    stash();
    setPresets((list) => {
      return [
        ...list,
        {
          name: numberedName('Preset', list),
          prompt: startingPrompt,
          ...(startingContext === undefined ? {} : { context: startingContext }),
        },
      ];
    });
    showPreset(presets().length - 1);
    rename();
  };

  const duplicate = () => {
    const idx = selected();
    if (idx === -1) return;
    stash();
    const source = presets()[idx]!;
    const name = copyName(source.name, (candidate) =>
      presets().some((preset) => preset.name === candidate),
    );
    setPresets((list) => [...list, { ...source, name }]);
    showPreset(presets().length - 1);
  };

  const remove = () => {
    const idx = selected();
    if (idx === -1) return;
    setPresets((list) => list.filter((_, i) => i !== idx));
    showPreset(-1);
  };

  const rename = () => {
    setRenaming(true);
    queueMicrotask(() => {
      const input = nameEl.element() as HTMLInputElement;
      input.focus({ preventScroll: true });
      input.select();
    });
  };

  const finishRename = () => {
    stash();
    setRenaming(false);
  };

  const handle: PromptPresetEditorHandle = {
    get value() {
      const current = currentPresets();
      return { presets: current, active: current[selected()]?.name ?? '' };
    },
    set value(next: ImagePromptPresetSet) {
      setPresets(next.presets);
      showPreset(next.presets.findIndex((preset) => preset.name === next.active));
    },
  };
  if (typeof props.ref === 'function') props.ref(handle);

  return (
    <div class="form-stack prompt-preset-editor">
      <SettingLabel field={pickerEl}>{props.label}</SettingLabel>
      <div class="key-row prompt-preset-toolbar">
        <Select
          ref={pickerEl.ref}
          ariaLabel="Prompt preset"
          onChange={(value) => pick(Number(value))}
          options={[
            { value: '-1', label: 'Default' },
            ...presets().map((preset, i) => ({
              value: String(i),
              label: preset.name || `Preset ${i + 1}`,
            })),
          ]}
        />
        <button onClick={add}>
          <FontAwesomeIcon icon={faPlus} size={12} /> New
        </button>
        <Show when={selected() !== -1}>
          <button onClick={duplicate}>Duplicate</button>
          <button onClick={rename}>Rename</button>
          <button class="danger-btn" onClick={remove}>
            Delete
          </button>
        </Show>
      </div>
      {/* Stays mounted so switching/default loads can keep using the imperative ref. */}
      <div class="prompt-preset-rename" classList={{ hidden: !renaming() }}>
        <SettingLabel field={nameEl}>Preset name</SettingLabel>
        <div class="key-row">
          <input ref={nameEl.ref} placeholder="Preset name" />
          <button onClick={finishRename}>Done</button>
        </div>
      </div>
      <SettingLabel field={promptEl}>
        {props.defaultContext !== undefined ? 'System instruction' : 'Prompt text'}
      </SettingLabel>
      <MacroTextarea
        ref={promptEl.ref}
        extraKeys={props.extraKeys}
        classList={{ 'prompt-default': selected() === -1 }}
      />
      <Show when={props.defaultContext !== undefined}>
        <SettingLabel field={contextEl}>{props.contextLabel ?? 'Context'}</SettingLabel>
        <MacroTextarea
          ref={contextEl.ref}
          extraKeys={props.contextExtraKeys}
          classList={{ 'prompt-default': selected() === -1 }}
        />
      </Show>
      <Show when={selected() === -1}>
        <span class="prompt-preset-status">Built-in default · create a preset to customize</span>
      </Show>
    </div>
  );
}

export function ImageGenerationSettingsPage() {
  const editors = {} as Record<ImagePromptKind, PromptPresetEditorHandle>;
  let errorEl: HTMLParagraphElement | undefined;
  const [saved, flashSaved] = createSavedFlash();
  const [error, setError] = createSignal('');
  const [workflows, setWorkflows] = createSignal<ImageWorkflow[]>([]);
  /** Index into workflows(); -1 = none (describe only). Selected = active for /image. */
  const [selected, setSelected] = createSignal(-1);
  const [workflowText, setWorkflowText] = createSignal('');
  /** Workflow name for avatar generation; '' = same as the /image selection. */
  const [avatarSel, setAvatarSel] = createSignal('');
  const comfyUrlEl = createDefaultField(() => DEFAULTS.comfyUrl);
  const nameEl = createDefaultField(() =>
    selected() < 0 ? '' : numberedName('Workflow', workflows(), selected()),
  );
  const workflowEl = createDefaultField(() => '');
  const pickerEl = createDefaultField(() => '-1');
  const avatarPickerEl = createDefaultField(() => '');
  const revisionEl = createDefaultField(() => DEFAULT_CHAT_IMAGE_REVISION_TEMPLATE);
  let baseline = '';
  /** Save with the form's loaded revision: invalidation can update the store
   * without refreshing these fields, allowing a stale form to overwrite newer edits. */
  let baseRevision = state.settings.revision;

  const showError = (message: string) => {
    setError(message);
    queueMicrotask(() => errorEl?.scrollIntoView({ block: 'nearest' }));
  };

  const currentWorkflows = () => {
    const idx = selected();
    return workflows().map((workflow, i) =>
      i === idx ? { name: nameEl.value.trim() || workflow.name, json: workflowEl.value } : workflow,
    );
  };
  const stash = () => {
    if (selected() !== -1) setWorkflows(currentWorkflows());
  };

  const showWorkflow = (idx: number) => {
    setSelected(idx);
    pickerEl.value = String(idx);
    const workflow = workflows()[idx];
    nameEl.value = workflow?.name ?? '';
    workflowEl.value = workflow?.json ?? '';
  };

  const pick = (idx: number) => {
    stash();
    showWorkflow(idx);
  };

  const addWorkflow = () => {
    stash();
    setWorkflows((list) => {
      return [...list, { name: numberedName('Workflow', list), json: '' }];
    });
    showWorkflow(workflows().length - 1);
  };

  const duplicateWorkflow = () => {
    const idx = selected();
    if (idx === -1) return;
    stash();
    const source = workflows()[idx]!;
    const name = copyName(source.name, (candidate) =>
      workflows().some((workflow) => workflow.name === candidate),
    );
    setWorkflows((list) => [...list, { name, json: source.json }]);
    showWorkflow(workflows().length - 1);
  };

  const deleteWorkflow = () => {
    const idx = selected();
    if (idx === -1) return;
    setWorkflows((list) => list.filter((_, i) => i !== idx));
    showWorkflow(-1);
  };

  const draft = (): ImageGenSettings => {
    const idx = selected();
    const current = currentWorkflows();
    return {
      promptRevisionTemplate: revisionEl.value,
      promptPresets: promptRecord(({ kind }) => editors[kind].value),
      comfyUrl: comfyUrlEl.value.trim() || DEFAULTS.comfyUrl,
      workflows: current,
      activeWorkflow: current[idx]?.name ?? '',
      avatarWorkflow: current.some((workflow) => workflow.name === avatarSel()) ? avatarSel() : '',
    };
  };

  const load = () => {
    const cfg = settings();
    revisionEl.value = cfg.promptRevisionTemplate;
    for (const { kind } of PROMPT_EDITORS) editors[kind].value = cfg.promptPresets[kind];
    comfyUrlEl.value = cfg.comfyUrl;
    setWorkflows(cfg.workflows);
    showWorkflow(cfg.workflows.findIndex((workflow) => workflow.name === cfg.activeWorkflow));
    const avatarName = cfg.workflows.some((workflow) => workflow.name === cfg.avatarWorkflow)
      ? cfg.avatarWorkflow
      : '';
    setAvatarSel(avatarName);
    avatarPickerEl.value = avatarName;
    baseline = JSON.stringify(draft());
    baseRevision = state.settings.revision;
  };
  onMount(load);

  const save = async () => {
    const values = draft();
    const invalidRevision = imageRevisionTemplateError(values.promptRevisionTemplate);
    if (invalidRevision) {
      showError(invalidRevision);
      return false;
    }
    setWorkflows(values.workflows);
    for (const { kind } of PROMPT_EDITORS) {
      const selection = values.promptPresets[kind];
      const names = selection.presets.map((preset) => preset.name);
      if (new Set(names).size !== names.length) {
        showError(`${kind[0]!.toUpperCase()}${kind.slice(1)} prompt preset names must be unique.`);
        return false;
      }
      if (names.some((name) => name.toLowerCase() === 'default')) {
        showError('“Default” is reserved for the built-in prompt. Choose another preset name.');
        return false;
      }
    }
    const names = values.workflows.map((workflow) => workflow.name);
    if (new Set(names).size !== names.length) {
      showError(
        'Workflow names must be unique — the selected name identifies the /image workflow.',
      );
      return false;
    }
    for (const workflow of values.workflows) {
      const invalid = workflowError(workflow.json);
      if (invalid) {
        showError(`Workflow "${workflow.name}" ${invalid}`);
        return false;
      }
    }
    try {
      const next = await api.putSettings({ imageGeneration: values }, baseRevision);
      applySettings(next);
      baseRevision = next.revision;
      baseline = JSON.stringify(values);
      setError('');
      flashSaved();
      return true;
    } catch (err) {
      showError(
        err instanceof ApiError && err.status === 409
          ? 'Image generation settings changed elsewhere. Discard to load the latest version, then review your changes.'
          : errorMessage(err),
      );
      return false;
    }
  };

  const discard = () => {
    load();
    setError('');
  };

  useSettingsGuard({
    isDirty: () => JSON.stringify(draft()) !== baseline,
    save,
    discard,
  });

  const hasPrompt = () => /\{\{prompt\}\}/i.test(workflowText());
  const hasSeed = () => /\{\{seed\}\}/i.test(workflowText());

  return (
    <>
      <Show when={error()}>
        <p ref={errorEl} class="notice notice-error image-settings-notice" role="alert">
          {error()}
        </p>
      </Show>

      <section
        id="image-settings-panel-rendering"
        class="settings-section image-settings-panel"
        aria-labelledby="image-settings-title-rendering"
      >
        <h3 id="image-settings-title-rendering">Image rendering</h3>
        <p class="hint">ComfyUI connection and default workflow for chat, gallery, and avatars.</p>
        <SettingLabel field={comfyUrlEl}>ComfyUI URL</SettingLabel>
        <input ref={comfyUrlEl.ref} placeholder={DEFAULTS.comfyUrl} />

        <SettingLabel field={pickerEl}>Workflow used by /image</SettingLabel>
        <p class="hint">Choose none to generate descriptions without rendering an image.</p>
        <div class="key-row">
          <Select
            ref={pickerEl.ref}
            ariaLabel="Image workflow"
            onChange={(value) => pick(Number(value))}
            options={[
              { value: '-1', label: '— none (describe only) —' },
              ...workflows().map((workflow, i) => ({
                value: String(i),
                label: workflow.name || `Workflow ${i + 1}`,
              })),
            ]}
          />
          <button onClick={addWorkflow}>
            <FontAwesomeIcon icon={faPlus} size={12} /> Add
          </button>
          <Show when={selected() !== -1}>
            <button onClick={duplicateWorkflow}>Duplicate</button>
            <button class="danger-btn" onClick={deleteWorkflow}>
              Delete
            </button>
          </Show>
        </div>

        {/* Stays mounted (hidden by class) so the imperative refs survive selection changes. */}
        <div
          class="form-stack field-group workflow-detail"
          classList={{ hidden: selected() === -1 }}
        >
          <SettingLabel field={nameEl}>Name</SettingLabel>
          <input ref={nameEl.ref} placeholder="Workflow name" />
          <SettingLabel field={workflowEl}>
            Workflow JSON — export via ComfyUI's "Save (API Format)"{' '}
            <MacroHelp rows={WORKFLOW_MACROS} />
          </SettingLabel>
          <MacroTextarea
            ref={workflowEl.ref}
            keys={['prompt', 'seed']}
            class="mono"
            rows={12}
            onText={setWorkflowText}
            placeholder='{"3": {"class_type": "KSampler", "inputs": {"seed": {{seed}}, …}}, "6": {"inputs": {"text": "{{prompt}}", …}}, …}'
          />
          <Show when={workflowText().trim()}>
            <div class="macro-checks">
              <span classList={{ warn: !hasPrompt() }}>
                <FontAwesomeIcon icon={hasPrompt() ? faCheck : faXmark} size={12} />{' '}
                {hasPrompt()
                  ? '{{prompt}} found'
                  : '{{prompt}} missing — the generated description would not be used'}
              </span>
              <span classList={{ soft: !hasSeed() }}>
                <FontAwesomeIcon icon={hasSeed() ? faCheck : faTriangleExclamation} size={12} />{' '}
                {hasSeed()
                  ? '{{seed}} found'
                  : "{{seed}} missing — every render will reuse the workflow's fixed seed"}
              </span>
            </div>
          </Show>
        </div>
      </section>

      <For each={IMAGE_PROMPT_SECTIONS}>
        {(section) => (
          <section
            id={`image-settings-panel-${section.key}`}
            class="settings-section image-settings-panel"
            aria-labelledby={`image-settings-title-${section.key}`}
          >
            <h3 id={`image-settings-title-${section.key}`}>{section.title}</h3>
            <p class="hint">{section.hint}</p>
            <For each={PROMPT_EDITORS.filter((editor) => editor.section === section.key)}>
              {(editor) => (
                <PromptPresetEditor
                  ref={(handle) => (editors[editor.kind] = handle)}
                  defaultPrompt={DEFAULT_PROMPTS[editor.kind]}
                  extraKeys={
                    editor.kind === 'avatar'
                      ? AVATAR_EXTRA_KEYS
                      : editor.command
                        ? ['instruction']
                        : undefined
                  }
                  defaultContext={editor.kind === 'avatar' ? DEFAULT_AVATAR_CONTEXT : undefined}
                  contextExtraKeys={AVATAR_EXTRA_KEYS}
                  contextLabel="Character context"
                  label={
                    <>
                      {editor.label}{' '}
                      <MacroHelp
                        extra={
                          editor.kind === 'avatar'
                            ? AVATAR_MACROS
                            : editor.command
                              ? [['{{instruction}}', `The ${editor.command} command argument`]]
                              : undefined
                        }
                      />
                    </>
                  }
                />
              )}
            </For>
            <Show when={section.key === 'avatar'}>
              <SettingLabel field={avatarPickerEl}>Avatar workflow</SettingLabel>
              <p class="hint">Defaults to the selected `/image` workflow.</p>
              <Select
                ref={avatarPickerEl.ref}
                ariaLabel="Avatar image workflow"
                onChange={(value) => setAvatarSel(value)}
                options={[
                  { value: '', label: '— same as /image workflow —' },
                  ...workflows().map((workflow) => ({
                    value: workflow.name,
                    label: workflow.name,
                  })),
                ]}
              />
            </Show>
          </section>
        )}
      </For>

      <section
        id="image-settings-panel-revision"
        class="settings-section image-settings-panel"
        aria-labelledby="image-settings-title-revision"
      >
        <h3 id="image-settings-title-revision">Chat image revision</h3>
        <p class="hint">
          Used when you regenerate an image prompt inside a chat. The existing conversation and its
          system prompt remain as context; the original image prompt is supplied as the preceding
          assistant message. This setting applies to every chat.
        </p>
        <SettingLabel field={revisionEl} for="image-revision-template">
          Revision instruction{' '}
          <MacroHelp
            rows={[
              ['{{instruction}}', 'The requested change'],
              ['{{prompt}}', 'The original image prompt'],
            ]}
          />
        </SettingLabel>
        <MacroTextarea
          ref={(el) => {
            revisionEl.ref(el);
            el.id = 'image-revision-template';
          }}
          keys={['instruction', 'prompt']}
          rows={10}
        />
      </section>

      <div class="form-actions">
        <button class="primary-btn" onClick={() => void save()}>
          Save
        </button>
        <button onClick={discard}>Discard</button>
        <Show when={saved()}>
          <span class="saved-flash">
            <FontAwesomeIcon icon={faCheck} size={12} /> Saved
          </span>
        </Show>
      </div>
    </>
  );
}

const imageSwipeBusy = new Set<number>();

const imageOnActivePath = (message: Message) =>
  activePath().some((active) => active.id === message.id);

const canRenderImage = (message: Message) =>
  !state.treeNavigationPending &&
  imageOnActivePath(message) &&
  !message.imagePending &&
  (message.hasImageRender || activeImageRenderConfig() != null);

/** Shared by header buttons and ChatView's Left/Right shortcut. */
async function swipeImage(message: Message, dir: 1 | -1): Promise<void> {
  // Swiping forward skips this prompt; stopping clears imagePending to prevent a partial render.
  if (message.status === 'streaming') {
    if (
      dir !== 1 ||
      message.generationToken == null ||
      imageSwipeBusy.has(message.id) ||
      state.treeNavigationPending
    )
      return;
    imageSwipeBusy.add(message.id);
    try {
      await api.stopGeneration(message.id, message.generationToken);
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      imageSwipeBusy.delete(message.id);
    }
    return;
  }
  const activeImage = Math.min(message.activeImage, message.images.length - 1);
  const index = activeImage + dir;
  if (index < 0 || imageSwipeBusy.has(message.id) || state.treeNavigationPending) return;
  imageSwipeBusy.add(message.id);
  try {
    if (index >= message.images.length) {
      if (!canRenderImage(message)) return;
      await navigateTree(() =>
        api.renderImage(
          message.id,
          state.tree,
          // Use the current workflow; the server falls back to the snapshot if none is selected.
          activeImageRenderConfig(),
        ),
      );
    } else {
      if (!imageOnActivePath(message)) return;
      await navigateTree(() => api.setActiveImage(message.id, index, state.tree));
    }
  } finally {
    imageSwipeBusy.delete(message.id);
  }
}

export const imageMessage = {
  matches: (message: Message) =>
    message.role === 'tool' &&
    (message.images.length > 0 ||
      message.imagePending ||
      message.hasImageRender ||
      message.name === 'Image prompt'),
  currentImageConfig: activeImageRenderConfig,
  swipe: (message: Message, dir: 1 | -1) => {
    void swipeImage(message, dir);
  },
  canDeleteSwipe: (message: Message) =>
    message.images.length > 1 && !message.imagePending && imageOnActivePath(message),
  deleteSwipe: (message: Message) =>
    api.deleteImage(
      message.id,
      Math.min(message.activeImage, message.images.length - 1),
      state.tree,
    ),
  create: (message: () => Message, ctx: { streaming: () => boolean }) => {
    const [showPrompt, setShowPrompt] = createSignal(false);
    const [viewerOpen, setViewerOpen] = createSignal(false);
    const [savingToGallery, setSavingToGallery] = createSignal(false);
    const images = () => message().images;
    const activeImage = () => Math.min(message().activeImage, images().length - 1);
    const currentImage = () => images()[activeImage()];
    const renderProgress = () => imageProgress()[message().id];
    const livePreview = () => (message().imagePending ? renderProgress()?.preview : undefined);
    const displayedImage = () => livePreview() ?? currentImage();
    // Collapse the prompt on the first preview to keep the render in focus.
    const promptCollapsed = () => images().length > 0 || livePreview() != null;
    const onActivePath = () => activePath().some((active) => active.id === message().id);
    const canRender = () => canRenderImage(message());
    const savedItem = () => {
      const image = currentImage();
      return image
        ? state.gallery.find(
            (item) => item.sourceMessageId === message().id && item.sourceImage === image,
          )
        : undefined;
    };
    const saveToGallery = async () => {
      if (savedItem()) {
        openModal('gallery');
        return;
      }
      if (!currentImage() || savingToGallery()) return;
      setSavingToGallery(true);
      try {
        const result = await api.saveGalleryImage(message().id, activeImage());
        applyGalleryItem(result.item);
        if (result.created) toast('Saved image to gallery.', 'success');
        else openModal('gallery');
      } catch (err) {
        toast(errorMessage(err));
      } finally {
        setSavingToGallery(false);
      }
    };

    const Header = () => (
      <Show when={promptCollapsed()}>
        <button
          class="reasoning-chip icon-btn"
          classList={{ 'icon-btn-active': showPrompt() }}
          title={showPrompt() ? 'Hide image prompt' : 'Show image prompt'}
          aria-label={showPrompt() ? 'Hide image prompt' : 'Show image prompt'}
          aria-expanded={showPrompt()}
          onClick={() => setShowPrompt(!showPrompt())}
        >
          <FontAwesomeIcon icon={faFileLines} size={15} />
        </button>
      </Show>
    );

    const HeaderTools = () => (
      <>
        <Show when={message().imagePending && !ctx.streaming()}>
          <span class="msg-image-pending">
            <FontAwesomeIcon icon={faSpinner} size={10} class="spinner" />
            <SamplerProgress
              progress={renderProgress()}
              stepsLabel="Step"
              fallback={<span>Rendering…</span>}
            />
          </span>
        </Show>
        <Show when={images().length > 0}>
          <span class="msg-actions">
            <button
              class="icon-btn gallery-save-btn"
              classList={{ 'icon-btn-active': savedItem() != null }}
              title={savedItem() ? 'Open saved image in gallery' : 'Save image to gallery'}
              aria-label={savedItem() ? 'Open saved image in gallery' : 'Save image to gallery'}
              disabled={savingToGallery()}
              onClick={() => void saveToGallery()}
            >
              <FontAwesomeIcon icon={savedItem() != null ? faImagesSolid : faImages} />
            </button>
          </span>
          <span class="branch-nav">
            <button
              class="icon-btn"
              title="Previous image"
              aria-label="Previous image"
              disabled={state.treeNavigationPending || !onActivePath() || activeImage() <= 0}
              onClick={() => void swipeImage(message(), -1)}
            >
              <FontAwesomeIcon icon={faChevronLeft} size={12} />
            </button>
            <span
              class="branch-count"
              aria-label={`Image ${activeImage() + 1} of ${images().length}`}
            >
              {activeImage() + 1}/{images().length}
            </span>
            <button
              class="icon-btn"
              disabled={
                state.treeNavigationPending ||
                !onActivePath() ||
                (activeImage() >= images().length - 1 && !canRender())
              }
              title={
                activeImage() >= images().length - 1
                  ? 'Generate another image (same prompt, new seed)'
                  : 'Next image'
              }
              aria-label={
                activeImage() >= images().length - 1
                  ? 'Generate another image with a new seed'
                  : 'Next image'
              }
              onClick={() => void swipeImage(message(), 1)}
            >
              <FontAwesomeIcon icon={faChevronRight} size={12} />
            </button>
          </span>
        </Show>
      </>
    );

    const Body = () => (
      <>
        <Show when={!promptCollapsed() || showPrompt()}>
          <div class="msg-content">
            <Markdown content={message().content} streaming={ctx.streaming()} />
          </div>
        </Show>
        <Show when={displayedImage()}>
          <CrossfadeImage
            class="msg-image"
            classList={{ 'msg-image-live': livePreview() != null }}
            src={displayedImage()}
            alt={livePreview() ? 'Image rendering preview' : 'Generated image'}
            wrapperClass="msg-image-crossfade"
            onClick={() => {
              if (!livePreview()) setViewerOpen(true);
            }}
          />
          <Show when={viewerOpen() && !livePreview()}>
            <ImageViewer src={currentImage()!} onClose={() => setViewerOpen(false)} />
          </Show>
        </Show>
        <Show when={message().genMeta?.imageError && !message().imagePending}>
          <div class="msg-error">
            Image render failed: {message().genMeta!.imageError}{' '}
            <Show when={canRender()}>
              <button onClick={() => void swipeImage(message(), 1)}>Retry</button>
            </Show>
          </div>
        </Show>
      </>
    );

    return {
      RailIcon: () => <FontAwesomeIcon icon={faImage} size={16} />,
      Header,
      HeaderTools,
      Body,
      hideName: true,
      fullBleed: () => displayedImage() != null,
    };
  },
};

export const imageGenerationCommands: ComposerCommand[] = [
  {
    name: 'image',
    params: '<instruction>',
    description:
      'Generate an image from the generic instruction prompt; {{instruction}} expands to the command argument',
    allowDuringGeneration: true,
    // Returning navigateTree's result keeps the composer text on failure.
    run: (args) => generate('instruction', args.trim()),
  },
  {
    name: 'imagechar',
    params: '[instruction]',
    description: 'Generate a character image, optionally using the character-instruction prompt',
    allowDuringGeneration: true,
    run: (args) => {
      const instruction = args.trim();
      return generate(instruction ? 'characterInstruction' : 'describe', instruction);
    },
  },
  {
    name: 'imageface',
    params: '[instruction]',
    description: 'Generate a face image, optionally using the face-instruction prompt',
    allowDuringGeneration: true,
    run: (args) => {
      const instruction = args.trim();
      return generate(instruction ? 'faceInstruction' : 'face', instruction);
    },
  },
];
