import { Show, createSignal, onMount, type JSX } from 'solid-js';
import { workflowValidationError, type Message } from '@minitavern/shared';
import type { Plugin, PluginMessageView, PluginTool } from './api.ts';
import { pluginSettings } from './api.ts';
import { api, ApiError } from '../state/api.ts';
import {
  activePath,
  applySettings,
  imageProgress,
  navigateTree,
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
import type { SelectHandle } from '../components/Select.tsx';
import CrossfadeImage from './CrossfadeImage.tsx';
import './imageGeneration.css';

const PromptIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="15"
    height="15"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M6 2h9l4 4v16H6z" />
    <path d="M14 2v5h5" />
    <path d="M9 12h6M9 16h6" />
  </svg>
);

const ID = 'imageGeneration';

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

interface ImageGenSettings extends Record<string, unknown> {
  /** Independently selected saved prompts for chat image and avatar generation. */
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

const DEFAULTS: ImageGenSettings = {
  promptPresets: {
    describe: { presets: [], active: '' },
    characterInstruction: { presets: [], active: '' },
    face: { presets: [], active: '' },
    faceInstruction: { presets: [], active: '' },
    instruction: { presets: [], active: '' },
    avatar: { presets: [], active: '' },
  },
  comfyUrl: 'http://comfy:8588',
  workflows: [],
  activeWorkflow: '',
  avatarWorkflow: '',
};

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

  // Migrate the former single editable field. A value equal to the built-in
  // default needs no saved copy; a customization becomes the active preset.
  const legacy = legacyKey ? cfg[legacyKey] : undefined;
  if (typeof legacy === 'string' && legacy !== DEFAULT_PROMPTS[kind]) {
    return { presets: [{ name: 'Custom', prompt: legacy }], active: 'Custom' };
  }
  return { presets: [], active: '' };
}

function settings(): ImageGenSettings {
  const stored = (state.settings.pluginSettings[ID] ?? {}) as Record<string, unknown>;
  const cfg = pluginSettings(ID, DEFAULTS);
  const promptPresets: ImageGenSettings['promptPresets'] = {
    describe: normalizePromptPresets(stored, 'describe', 'describePrompt'),
    characterInstruction: normalizePromptPresets(stored, 'characterInstruction'),
    face: normalizePromptPresets(stored, 'face'),
    faceInstruction: normalizePromptPresets(stored, 'faceInstruction'),
    instruction: normalizePromptPresets(stored, 'instruction', 'instructionPrompt'),
    avatar: normalizePromptPresets(stored, 'avatar', 'avatarPrompt'),
  };
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

/** The server's route-time check (shared implementation) so a broken paste
 * fails at save time; an empty workflow is allowed as a placeholder. */
function workflowError(workflow: string): string | null {
  return workflow.trim() ? workflowValidationError(workflow) : null;
}

/** Selects one prompt variant and expands its optional command instruction.
 * {{char}}/{{user}} expand server-side, where the conversation context lives. */
function composePrompt(
  kind: Exclude<ImagePromptKind, 'avatar'>,
  instruction = '',
  presetName?: string | null,
): string {
  const template = selectedPrompt(settings(), kind, presetName);
  // Callback replacement: a string would interpret $-sequences in the
  // user's instruction ("$$99" → "$99", "$&" → the matched macro).
  return template.replaceAll(/\{\{instruction\}\}/gi, () => instruction);
}

/** The active workflow as a render config; undefined when none is configured. */
function activeRenderConfig(): { workflow: string; comfyUrl: string } | undefined {
  const cfg = settings();
  const active = cfg.workflows.find((workflow) => workflow.name === cfg.activeWorkflow);
  return active?.json.trim() ? { workflow: active.json, comfyUrl: cfg.comfyUrl } : undefined;
}

/** The avatar workflow as a render config: the dedicated avatarWorkflow
 * selection, falling back to the /image one; undefined when none resolves. */
export function avatarRenderConfig(): { workflow: string; comfyUrl: string } | undefined {
  const cfg = settings();
  const avatar = cfg.workflows.find((workflow) => workflow.name === cfg.avatarWorkflow);
  return avatar?.json.trim()
    ? { workflow: avatar.json, comfyUrl: cfg.comfyUrl }
    : activeRenderConfig();
}

/** Avatar generation is available once a workflow resolves (dedicated avatar
 * selection or the /image fallback). */
export function avatarGenerationAvailable(): boolean {
  return avatarRenderConfig() != null;
}

/** The active avatar preset's paired system/context templates. Both expand
 * server-side, where the entity fields are authoritative. */
export function avatarPromptTemplates(): { prompt: string; context: string } {
  const selection = settings().promptPresets.avatar;
  const preset = selection.presets.find((candidate) => candidate.name === selection.active);
  return {
    prompt: preset?.prompt ?? DEFAULT_PROMPTS.avatar,
    context: preset?.context ?? DEFAULT_AVATAR_CONTEXT,
  };
}

/** Streams the image description into a tool message as a foreground
 * generation; with an active workflow, ComfyUI then renders the image. */
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
      state.tree.activeLeafId,
      state.tree.mutationRevision,
      activeRenderConfig(),
    ),
  );
}

/** One direct action per available prompt. With no saved presets, retain the
 * original compact label; otherwise name Default and every saved variant so a
 * click selects that prompt for this generation only. */
function promptTools(kind: 'describe' | 'face', subject: 'Character' | 'Face'): PluginTool[] {
  const presets = settings().promptPresets[kind].presets;
  const baseLabel = `Generate ${subject} Image`;
  if (presets.length === 0) {
    return [{ label: baseLabel, icon: ImageIcon, run: () => void generate(kind) }];
  }
  return [
    { name: 'Default', presetName: null },
    ...presets.map((preset) => ({ name: preset.name, presetName: preset.name })),
  ].map(({ name, presetName }) => ({
    label: `${baseLabel} — ${name}`,
    icon: ImageIcon,
    run: () => void generate(kind, '', presetName),
  }));
}

function imageGenerationTools(): PluginTool[] {
  return [...promptTools('describe', 'Character'), ...promptTools('face', 'Face')];
}

const ImageIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M21 16l-5-5-9 9" />
  </svg>
);

/** "Name (copy)", then "Name (copy 2)", ...: names are the item identity in
 * these lists (active selections refer to one), so a copy must never collide. */
function copyName(base: string, taken: (name: string) => boolean): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base} (copy)` : `${base} (copy ${n})`;
    if (!taken(candidate)) return candidate;
  }
}

interface PromptPresetEditorHandle {
  value: ImagePromptPresetSet;
}

/** One independently selected prompt-preset editor. The built-in Default is
 * always present but never serialized, so future default improvements remain
 * available without overwriting a user's saved prompts. */
function PromptPresetEditor(props: {
  label: JSX.Element;
  defaultPrompt: string;
  extraKeys?: string[];
  defaultContext?: string;
  contextLabel?: JSX.Element;
  contextExtraKeys?: string[];
  ref?: PromptPresetEditorHandle | ((handle: PromptPresetEditorHandle) => void);
}) {
  let nameEl!: HTMLInputElement;
  let promptEl!: HTMLTextAreaElement;
  let contextEl!: HTMLTextAreaElement;
  let pickerEl!: SelectHandle;
  const [presets, setPresets] = createSignal<ImagePromptPreset[]>([]);
  /** Index into presets(); -1 = built-in Default. */
  const [selected, setSelected] = createSignal(-1);
  const [renaming, setRenaming] = createSignal(false);

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
    promptEl.readOnly = idx === -1;
    if (props.defaultContext !== undefined) {
      contextEl.value = preset?.context ?? props.defaultContext;
      contextEl.readOnly = idx === -1;
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
      let n = list.length + 1;
      while (list.some((preset) => preset.name === `Preset ${n}`)) n++;
      return [
        ...list,
        {
          name: `Preset ${n}`,
          prompt: startingPrompt,
          ...(startingContext === undefined ? {} : { context: startingContext }),
        },
      ];
    });
    showPreset(presets().length - 1);
    setRenaming(true);
    queueMicrotask(() => {
      nameEl.focus();
      nameEl.select();
    });
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
      nameEl.focus();
      nameEl.select();
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
    <div class="prompt-preset-editor">
      <label>{props.label}</label>
      <div class="key-row prompt-preset-toolbar">
        <Select
          ref={pickerEl}
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
        <button onClick={add}>+ New</button>
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
        <label>Preset name</label>
        <div class="key-row">
          <input ref={nameEl} placeholder="Preset name" />
          <button onClick={finishRename}>Done</button>
        </div>
      </div>
      <Show when={props.defaultContext !== undefined}>
        <label>System instruction</label>
      </Show>
      <MacroTextarea
        ref={promptEl}
        rows={4}
        extraKeys={props.extraKeys}
        classList={{ 'prompt-default': selected() === -1 }}
      />
      <Show when={props.defaultContext !== undefined}>
        <label>{props.contextLabel ?? 'Context'}</label>
        <MacroTextarea
          ref={contextEl}
          rows={4}
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

function SettingsPage() {
  let describeEditor!: PromptPresetEditorHandle;
  let characterInstructionEditor!: PromptPresetEditorHandle;
  let faceEditor!: PromptPresetEditorHandle;
  let faceInstructionEditor!: PromptPresetEditorHandle;
  let instructionEditor!: PromptPresetEditorHandle;
  let avatarEditor!: PromptPresetEditorHandle;
  let comfyUrlEl!: HTMLInputElement;
  let nameEl!: HTMLInputElement;
  let workflowEl!: HTMLTextAreaElement;
  let pickerEl!: SelectHandle;
  let avatarPickerEl!: SelectHandle;
  const [saved, flashSaved] = createSavedFlash();
  const [error, setError] = createSignal('');
  const [workflows, setWorkflows] = createSignal<ImageWorkflow[]>([]);
  /** Index into workflows(); -1 = none (describe only). Selected = active for /image. */
  const [selected, setSelected] = createSignal(-1);
  const [workflowText, setWorkflowText] = createSignal('');
  /** Workflow name for avatar generation; '' = same as the /image selection. */
  const [avatarSel, setAvatarSel] = createSignal('');
  let baseline = '';
  /** Revision whose image settings were loaded into this imperative form. A
   * settings invalidation may update the global store without updating these
   * fields; saving must still use this base or a stale form could pass with the
   * newly received revision and silently overwrite another client's work. */
  let baseRevision = state.settings.revision;

  /** Read the editable fields back into the workflows list before switching/saving. */
  const stash = () => {
    const idx = selected();
    if (idx === -1) return;
    setWorkflows((list) =>
      list.map((workflow, i) =>
        i === idx
          ? { name: nameEl.value.trim() || workflow.name, json: workflowEl.value }
          : workflow,
      ),
    );
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
      // Names are the workflow identity (activeWorkflow refers to one) — never
      // generate a name that's already taken.
      let n = list.length + 1;
      while (list.some((workflow) => workflow.name === `Workflow ${n}`)) n++;
      return [...list, { name: `Workflow ${n}`, json: '' }];
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
    const currentWorkflows = workflows().map((workflow, i) =>
      i === idx ? { name: nameEl.value.trim() || workflow.name, json: workflowEl.value } : workflow,
    );
    return {
      promptPresets: {
        describe: describeEditor.value,
        characterInstruction: characterInstructionEditor.value,
        face: faceEditor.value,
        faceInstruction: faceInstructionEditor.value,
        instruction: instructionEditor.value,
        avatar: avatarEditor.value,
      },
      comfyUrl: comfyUrlEl.value.trim() || DEFAULTS.comfyUrl,
      workflows: currentWorkflows,
      activeWorkflow: currentWorkflows[idx]?.name ?? '',
      // A name that no longer exists (deleted/renamed here) saves as the fallback.
      avatarWorkflow: currentWorkflows.some((workflow) => workflow.name === avatarSel())
        ? avatarSel()
        : '',
    };
  };

  const load = () => {
    const cfg = settings();
    describeEditor.value = cfg.promptPresets.describe;
    characterInstructionEditor.value = cfg.promptPresets.characterInstruction;
    faceEditor.value = cfg.promptPresets.face;
    faceInstructionEditor.value = cfg.promptPresets.faceInstruction;
    instructionEditor.value = cfg.promptPresets.instruction;
    avatarEditor.value = cfg.promptPresets.avatar;
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
    setWorkflows(values.workflows);
    for (const [kind, selection] of Object.entries(values.promptPresets)) {
      const names = selection.presets.map((preset) => preset.name);
      if (new Set(names).size !== names.length) {
        setError(`${kind[0]!.toUpperCase()}${kind.slice(1)} prompt preset names must be unique.`);
        return false;
      }
      if (names.some((name) => name.toLowerCase() === 'default')) {
        setError('“Default” is reserved for the built-in prompt. Choose another preset name.');
        return false;
      }
    }
    const names = values.workflows.map((workflow) => workflow.name);
    if (new Set(names).size !== names.length) {
      setError('Workflow names must be unique — the selected name identifies the /image workflow.');
      return false;
    }
    for (const workflow of values.workflows) {
      const invalid = workflowError(workflow.json);
      if (invalid) {
        setError(`Workflow "${workflow.name}" ${invalid}`);
        return false;
      }
    }
    try {
      const next = await api.putSettings(
        { pluginSettings: { ...state.settings.pluginSettings, [ID]: values } },
        baseRevision,
      );
      applySettings(next);
      baseRevision = next.revision;
      baseline = JSON.stringify(values);
      setError('');
      flashSaved();
      return true;
    } catch (err) {
      setError(
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
      <section class="settings-section">
        <h3>Prompt generation</h3>
        <PromptPresetEditor
          ref={describeEditor}
          defaultPrompt={DEFAULT_PROMPTS.describe}
          label={
            <>
              Character image prompt (sent to the model to describe the character and scene){' '}
              <MacroHelp />
            </>
          }
        />
        <PromptPresetEditor
          ref={characterInstructionEditor}
          defaultPrompt={DEFAULT_PROMPTS.characterInstruction}
          extraKeys={['instruction']}
          label={
            <>
              Character image prompt with instruction — used by /imagechar{' '}
              <MacroHelp extra={[['{{instruction}}', 'The /imagechar command argument']]} />
            </>
          }
        />
        <PromptPresetEditor
          ref={faceEditor}
          defaultPrompt={DEFAULT_PROMPTS.face}
          label={
            <>
              Face image prompt (sent to the model to describe a close-up portrait) <MacroHelp />
            </>
          }
        />
        <PromptPresetEditor
          ref={faceInstructionEditor}
          defaultPrompt={DEFAULT_PROMPTS.faceInstruction}
          extraKeys={['instruction']}
          label={
            <>
              Face image prompt with instruction — used by /imageface{' '}
              <MacroHelp extra={[['{{instruction}}', 'The /imageface command argument']]} />
            </>
          }
        />
        <PromptPresetEditor
          ref={instructionEditor}
          defaultPrompt={DEFAULT_PROMPTS.instruction}
          extraKeys={['instruction']}
          label={
            <>
              Generic instruction prompt for /image — {'{{instruction}}'} expands to the command
              argument <MacroHelp extra={[['{{instruction}}', 'The /image command argument']]} />
            </>
          }
        />
        <PromptPresetEditor
          ref={avatarEditor}
          defaultPrompt={DEFAULT_PROMPTS.avatar}
          extraKeys={['name', 'description', 'personality', 'scenario', 'firstMessage']}
          defaultContext={DEFAULT_AVATAR_CONTEXT}
          contextExtraKeys={['name', 'description', 'personality', 'scenario', 'firstMessage']}
          contextLabel="Character context"
          label={
            <>
              Avatar prompt — system instruction and context for the Generate avatar button{' '}
              <MacroHelp extra={AVATAR_MACROS} />
            </>
          }
        />
      </section>

      <section class="settings-section">
        <h3>Image rendering</h3>
        <label>ComfyUI URL</label>
        <input ref={comfyUrlEl} placeholder={DEFAULTS.comfyUrl} />

        <label>Workflow used by /image</label>
        <p class="hint">Choose none to generate descriptions without rendering an image.</p>
        <div class="key-row">
          <Select
            ref={pickerEl}
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
          <button onClick={addWorkflow}>+ Add</button>
          <Show when={selected() !== -1}>
            <button onClick={duplicateWorkflow}>Duplicate</button>
            <button class="danger-btn" onClick={deleteWorkflow}>
              Delete
            </button>
          </Show>
        </div>

        {/* Stays mounted (hidden by class) so the imperative refs survive selection changes. */}
        <div class="workflow-detail" classList={{ hidden: selected() === -1 }}>
          <label>Name</label>
          <input ref={nameEl} placeholder="Workflow name" />
          <label>
            Workflow JSON — export via ComfyUI's "Save (API Format)"{' '}
            <MacroHelp rows={WORKFLOW_MACROS} />
          </label>
          <MacroTextarea
            ref={workflowEl}
            keys={['prompt', 'seed']}
            class="mono"
            rows={12}
            onText={setWorkflowText}
            placeholder='{"3": {"class_type": "KSampler", "inputs": {"seed": {{seed}}, …}}, "6": {"inputs": {"text": "{{prompt}}", …}}, …}'
          />
          <Show when={workflowText().trim()}>
            <div class="macro-checks">
              <span classList={{ warn: !hasPrompt() }}>
                {hasPrompt()
                  ? '✓ {{prompt}} found'
                  : '✗ {{prompt}} missing — the generated description would not be used'}
              </span>
              <span classList={{ soft: !hasSeed() }}>
                {hasSeed()
                  ? '✓ {{seed}} found'
                  : "△ {{seed}} missing — every render will reuse the workflow's fixed seed"}
              </span>
            </div>
          </Show>
        </div>

        <label>Avatar workflow</label>
        <p class="hint">Defaults to the selected `/image` workflow.</p>
        <Select
          ref={avatarPickerEl}
          ariaLabel="Avatar image workflow"
          onChange={(value) => setAvatarSel(value)}
          options={[
            { value: '', label: '— same as /image workflow —' },
            ...workflows().map((workflow) => ({ value: workflow.name, label: workflow.name })),
          ]}
        />
      </section>

      <Show when={error()}>
        <p class="notice notice-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="form-actions">
        <button class="primary-btn" onClick={() => void save()}>
          Save
        </button>
        <button onClick={discard}>Discard</button>
        <Show when={saved()}>
          <span class="saved-flash">✓ Saved</span>
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
  (message.hasImageRender || activeRenderConfig() != null);

/** Shared by header buttons and ChatView's Left/Right shortcut. */
async function swipeImage(message: Message, dir: 1 | -1): Promise<void> {
  // A forward swipe during prompt writing means "skip this one", matching an
  // assistant reply's swipe-past behavior. Stopping clears imagePending, so a
  // partial prompt never proceeds into ComfyUI.
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
          state.tree.activeLeafId,
          state.tree.mutationRevision,
          // A manual rerender follows the workflow currently selected in
          // settings. The server falls back to the stored snapshot only when
          // no workflow is selected now.
          activeRenderConfig(),
        ),
      );
    } else {
      if (!imageOnActivePath(message)) return;
      await navigateTree(() =>
        api.setActiveImage(message.id, index, state.tree.activeLeafId, state.tree.mutationRevision),
      );
    }
  } finally {
    imageSwipeBusy.delete(message.id);
  }
}

/** Owns the rendering of this plugin's tool messages: collapsible prompt,
 * image with fullscreen viewer, header swiper (› past the end re-renders
 * with a fresh seed), render progress and error/retry. */
const messageView: PluginMessageView = {
  claims: (message) =>
    message.images.length > 0 ||
    message.imagePending ||
    message.hasImageRender ||
    message.name === 'Image prompt',
  currentImageConfig: activeRenderConfig,
  swipe: (message, dir) => {
    void swipeImage(message, dir);
  },
  canDeleteSwipe: (message) =>
    message.images.length > 0 && !message.imagePending && imageOnActivePath(message),
  deleteSwipe: (message) =>
    api.deleteImage(
      message.id,
      Math.min(message.activeImage, message.images.length - 1),
      state.tree.activeLeafId,
      state.tree.mutationRevision,
    ),
  create: (message, ctx) => {
    const [showPrompt, setShowPrompt] = createSignal(false);
    const [viewerOpen, setViewerOpen] = createSignal(false);
    const images = () => message().images;
    const activeImage = () => Math.min(message().activeImage, images().length - 1);
    const currentImage = () => images()[activeImage()];
    const renderProgress = () => imageProgress()[message().id];
    const numericProgress = () => {
      const progress = renderProgress();
      return progress?.value !== undefined && progress.max ? progress : null;
    };
    const livePreview = () => (message().imagePending ? renderProgress()?.preview : undefined);
    const displayedImage = () => livePreview() ?? currentImage();
    // Hide the generated prompt as soon as ComfyUI supplies visual output;
    // waiting for the final stored image leaves text competing with every
    // streamed preview frame during the render.
    const promptCollapsed = () => images().length > 0 || livePreview() != null;
    const onActivePath = () => activePath().some((active) => active.id === message().id);
    const canRender = () => canRenderImage(message());

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
          <PromptIcon />
        </button>
      </Show>
    );

    const HeaderTools = () => (
      <>
        {/* Keep render status adjacent to, and before, the image alternatives
            it is currently extending. */}
        <Show when={message().imagePending && !ctx.streaming()}>
          <span class="msg-image-pending">
            <span class="spinner" />
            <Show when={numericProgress()} fallback={<span>Rendering…</span>}>
              {(progress) => (
                <>
                  <span class="img-progress">
                    <span
                      class="img-progress-fill"
                      style={{
                        width: `${Math.round((progress().value! / progress().max!) * 100)}%`,
                      }}
                    />
                  </span>
                  <span>
                    {progress().value!}/{progress().max!}
                  </span>
                </>
              )}
            </Show>
          </span>
        </Show>
        <Show when={images().length > 0}>
          <span class="branch-nav">
            <button
              class="icon-btn"
              title="Previous image"
              aria-label="Previous image"
              disabled={state.treeNavigationPending || !onActivePath() || activeImage() <= 0}
              onClick={() => void swipeImage(message(), -1)}
            >
              ‹
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
              ›
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
      RailIcon: ImageIcon,
      Header,
      HeaderTools,
      Body,
      hideName: true,
      fullBleed: () => displayedImage() != null,
    };
  },
};

// Keep the registry contract explicit: the dev-module smoke test verifies this
// named export as well as the production bundle.
export const imageGenerationPlugin: Plugin = {
  id: ID,
  name: 'Image Generation',
  messageView,
  tools: imageGenerationTools,
  commands: [
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
  ],
  settingsPage: SettingsPage,
};
