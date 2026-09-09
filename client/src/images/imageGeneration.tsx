import SettingsTransferButtons from '../components/SettingsTransferButtons.tsx';
import { importImagePromptSet, transferObject, transferString } from '@tinytavern/shared';
import {
  DEFAULT_CHAT_IMAGE_REVISION_CONTEXT,
  DEFAULT_CHAT_IMAGE_REVISION_ORIGINAL,
  DEFAULT_AVATAR_CONTEXT,
} from '@tinytavern/shared';
import SettingsActions from '../components/SettingsActions.tsx';
import type { MediaImageConfig } from '@tinytavern/shared';
import SettingLabel, { createDefaultField } from '../components/SettingField.tsx';
import {
  faChevronLeft,
  faChevronRight,
  faImages as faImagesSolid,
  faRotateRight,
  faSpinner,
} from '@fortawesome/free-solid-svg-icons';
import { faFileLines, faImage, faImages } from '@fortawesome/free-regular-svg-icons';
import FontAwesomeIcon from '../components/FontAwesomeIcon.tsx';
import { For, Show, createSignal, onMount, type JSX } from 'solid-js';
import {
  DEFAULT_CHAT_IMAGE_REVISION_TEMPLATE,
  DEFAULT_IMAGE_CHAT_PROMPTS,
  type ImageChatPromptKind,
  imageRevisionTemplateError,
  type Message,
} from '@tinytavern/shared';
import type { ComposerCommand } from '../composerCommands.ts';
import { api } from '../state/api.ts';
import {
  activePath,
  applyGalleryItem,
  applyMediaJob,
  applySettings,
  mediaJobsByMessage,
  navigateTree,
  openModal,
  state,
  toast,
} from '../state/store.ts';
import { createSavedFlash, errorMessage } from '../util.ts';
import ImageViewer from '../components/ImageViewer.tsx';
import MediaPlayer from '../media/MediaPlayer.tsx';
import MediaActions from '../media/MediaActions.tsx';
import { openMediaTool, openMediaRerun } from '../media/navigation.ts';
import MacroHelp from '../components/MacroHelp.tsx';
import Markdown from '../components/Markdown.tsx';
import { createNamedCollection } from '../components/NamedCollectionEditor.tsx';
import FormField, { createFormFields } from '../components/FormFields.tsx';
import { createSettingsSubmission } from '../state/settingsSubmission.ts';
import { useSettingsGuard } from '../components/SettingsGuard.tsx';
import CrossfadeImage from './CrossfadeImage.tsx';
import SamplerProgress from './SamplerProgress.tsx';

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

type ImagePromptKind = ImageChatPromptKind | 'avatar';

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
    hint: 'Prompt and context used by Generate avatar.',
  },
] as const;

interface ImageGenSettings {
  promptRevisionTemplate: string;
  promptRevisionContext: string;
  promptRevisionOriginal: string;
  promptPresets: Record<ImagePromptKind, ImagePromptPresetSet>;
}

const DEFAULT_PROMPTS: Record<ImagePromptKind, string> = {
  ...DEFAULT_IMAGE_CHAT_PROMPTS,
  avatar:
    'Write an image-generation prompt for a portrait avatar. Head and shoulders, facing forward. Reply with only the prompt.',
};

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
  command?: string;
}[] = [
  {
    kind: 'describe',
    section: 'character',
    label: 'Without an instruction',
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
  },
  {
    kind: 'avatar',
    section: 'avatar',
    label: 'Avatar prompt',
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

function normalizePromptPresets(
  cfg: { promptPresets?: Record<string, ImagePromptPresetSet> },
  kind: ImagePromptKind,
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

  return { presets: [], active: '' };
}

function settings(): ImageGenSettings {
  const stored = state.settings.imageGeneration;
  return {
    promptRevisionTemplate: stored.promptRevisionTemplate,
    promptRevisionContext: stored.promptRevisionContext,
    promptRevisionOriginal: stored.promptRevisionOriginal,
    promptPresets: promptRecord(({ kind }) => normalizePromptPresets(stored, kind)),
  };
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

export function activeImageRenderConfig(): MediaImageConfig | undefined {
  const cfg = state.settings.mediaRendering;
  const active = cfg.workflows.find((workflow) => workflow.id === cfg.defaults['image:0']);
  return active?.json.trim() ? { workflow: active, comfyUrl: cfg.comfyUrl } : undefined;
}

/** Fall back to the /image workflow when no avatar workflow resolves. */
export function avatarRenderConfig(): MediaImageConfig | undefined {
  const cfg = state.settings.mediaRendering;
  const avatar = cfg.workflows.find((workflow) => workflow.id === cfg.avatarWorkflowId);
  return avatar?.json.trim()
    ? { workflow: avatar, comfyUrl: cfg.comfyUrl }
    : activeImageRenderConfig();
}

export function avatarGenerationAvailable(): boolean {
  return avatarRenderConfig() != null;
}

/** Both templates expand server-side using authoritative entity fields. */
export function avatarPromptTemplates(): { prompt: string; context: string } {
  const selection = settings().promptPresets.avatar;
  if (selection.active === '') {
    return { prompt: DEFAULT_PROMPTS.avatar, context: DEFAULT_AVATAR_CONTEXT };
  }
  const preset = selection.presets.find((candidate) => candidate.name === selection.active);
  if (!preset || !preset.context?.trim()) {
    throw new Error('Select an avatar preset with a context template in Avatar prompts settings.');
  }
  return { prompt: preset.prompt, context: preset.context };
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
    api.toolGenerate(state.selectedId!, state.tree, {
      prompt: composePrompt(kind, instruction, presetName),
      label: 'Image prompt',
      image: activeImageRenderConfig(),
    }),
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
  transferKey: string;
  onError: (error: string) => void;
  defaultPrompt: string;
  promptLabel?: JSX.Element;
  extraKeys?: string[];
  defaultContext?: string;
  contextLabel?: JSX.Element;
  contextExtraKeys?: string[];
  ref?: PromptPresetEditorHandle | ((handle: PromptPresetEditorHandle) => void);
}) {
  type Preset = ImagePromptPreset & { id: string };
  let sequence = 0;
  const [presets, setPresets] = createSignal<Preset[]>([]);
  /** Index into presets(); -1 = built-in Default. */
  const [selected, setSelected] = createSignal(-1);
  const [name, setName] = createSignal('');
  const promptEl = createDefaultField(() => props.defaultPrompt);
  const contextEl = createDefaultField(() => props.defaultContext ?? '');

  const currentPresets = () => {
    const idx = selected();
    return presets().map((preset, i) => {
      if (i !== idx) return preset;
      return {
        ...preset,
        name: name().trim() || preset.name,
        prompt: promptEl.value,
        ...(props.defaultContext === undefined ? {} : { context: contextEl.value }),
      };
    });
  };

  const stash = () => setPresets(currentPresets());

  const showPreset = (idx: number) => {
    setSelected(idx);
    collection.closeRename();
    const preset = presets()[idx];
    setName(preset?.name ?? '');
    promptEl.value = preset?.prompt ?? props.defaultPrompt;
    (promptEl.element() as HTMLTextAreaElement).readOnly = idx === -1;
    if (props.defaultContext !== undefined) {
      contextEl.value = idx === -1 ? props.defaultContext : preset!.context!;
      (contextEl.element() as HTMLTextAreaElement).readOnly = idx === -1;
    }
  };

  const collection = createNamedCollection<Preset>({
    items: currentPresets,
    selected: () => presets()[selected()]?.id ?? '',
    identify: (item) => item.id,
    newName: () => numberedName('Preset', currentPresets()),
    defaultLabel: 'Default',
    commit: (items, id) => {
      setPresets(items);
      showPreset(items.findIndex((item) => item.id === id));
    },
    create: (_source, name) => ({
      id: String(++sequence),
      name,
      prompt: promptEl.value,
      ...(props.defaultContext === undefined ? {} : { context: contextEl.value }),
    }),
  });

  const handle: PromptPresetEditorHandle = {
    get value() {
      const current = currentPresets();
      return {
        presets: current.map(({ id, ...preset }) => preset),
        active: current[selected()]?.name ?? '',
      };
    },
    set value(next: ImagePromptPresetSet) {
      setPresets(next.presets.map((preset) => ({ ...preset, id: String(++sequence) })));
      showPreset(next.presets.findIndex((preset) => preset.name === next.active));
    },
  };
  if (typeof props.ref === 'function') props.ref(handle);

  return (
    <div class="form-stack field-group prompt-preset-editor [&+.prompt-preset-editor]:mt-2 [&_.macro-box]:w-full [&_.macro-box]:isolate [&_.macro-overlay]:z-0 [&_textarea]:z-1">
      <SettingLabel>{props.label}</SettingLabel>
      <collection.Toolbar
        ariaLabel="Prompt preset"
        nameLabel="Preset name"
        name={name()}
        onRename={setName}
        defaultName={selected() < 0 ? '' : numberedName('Preset', presets(), selected())}
        onFinishRename={stash}
        transfer={{
          type: `image-prompt:${props.transferKey}`,
          onError: props.onError,
          allowDefaultExport: true,
          exportData: () => ({
            name: selected() === -1 ? 'Default (imported)' : currentPresets()[selected()]!.name,
            prompt: promptEl.value,
            ...(props.defaultContext === undefined ? {} : { context: contextEl.value }),
          }),
          importData: (data, previous) => {
            const source = transferObject(data);
            const imported = importImagePromptSet(
              { presets: [source], active: source.name },
              { presets: [], active: '' },
              props.defaultContext !== undefined,
            ).presets[0]!;
            if (
              currentPresets().some(
                (item) => item.id !== previous?.id && item.name === imported.name,
              )
            )
              throw new Error('A preset with this name already exists');
            return { ...imported, id: previous?.id ?? String(++sequence) };
          },
        }}
      />
      <FormField
        field={promptEl}
        kind="macro"
        readOnly={selected() === -1}
        label={
          props.promptLabel ??
          (props.defaultContext !== undefined ? 'System instruction' : 'Prompt text')
        }
        extraKeys={props.extraKeys}
      />
      <Show when={props.defaultContext !== undefined}>
        <FormField
          field={contextEl}
          kind="macro"
          readOnly={selected() === -1}
          label={props.contextLabel ?? 'Context'}
          extraKeys={props.contextExtraKeys}
        />
      </Show>
      <Show when={selected() === -1}>
        <span class="text-dim text-caption">Built-in default · create a preset to customize</span>
      </Show>
    </div>
  );
}

export function ImageGenerationSettingsPage(props: { mode: 'chat' | 'avatar' }) {
  const sections = IMAGE_PROMPT_SECTIONS.filter((section) =>
    props.mode === 'avatar' ? section.key === 'avatar' : section.key !== 'avatar',
  );
  const promptEditors = PROMPT_EDITORS.filter((editor) =>
    props.mode === 'avatar' ? editor.kind === 'avatar' : editor.kind !== 'avatar',
  );
  let baseSettings = settings();
  const editors = {} as Record<ImagePromptKind, PromptPresetEditorHandle>;
  let errorEl: HTMLParagraphElement | undefined;
  const [saved, flashSaved] = createSavedFlash();
  const [error, setError] = createSignal('');
  const revision = createFormFields({
    promptRevisionContext: DEFAULT_CHAT_IMAGE_REVISION_CONTEXT,
    promptRevisionOriginal: DEFAULT_CHAT_IMAGE_REVISION_ORIGINAL,
    promptRevisionTemplate: DEFAULT_CHAT_IMAGE_REVISION_TEMPLATE,
  });
  let baseline = '';

  const showError = (message: string) => {
    setError(message);
    if (message) queueMicrotask(() => errorEl?.scrollIntoView({ block: 'nearest' }));
  };

  const draft = () => ({
    imageGeneration: {
      ...baseSettings,
      ...(props.mode === 'chat' ? revision.value() : {}),
      promptPresets: {
        ...baseSettings.promptPresets,
        ...Object.fromEntries(promptEditors.map(({ kind }) => [kind, editors[kind].value])),
      },
    },
  });

  const load = () => {
    baseSettings = settings();
    if (props.mode === 'chat') revision.load(baseSettings);
    for (const { kind } of promptEditors) editors[kind].value = baseSettings.promptPresets[kind];
    baseline = JSON.stringify(draft());
  };
  const submission = createSettingsSubmission({
    revision: () => state.settings.revision,
    isDirty: () => JSON.stringify(draft()) !== baseline,
    snapshot: () => {
      const values = draft();
      const invalidRevision = imageRevisionTemplateError(
        values.imageGeneration.promptRevisionTemplate,
      );
      if (invalidRevision) throw new Error(invalidRevision);
      for (const { kind } of promptEditors) {
        const names = values.imageGeneration.promptPresets[kind].presets.map(
          (preset) => preset.name,
        );
        if (new Set(names).size !== names.length) {
          throw new Error(
            `${kind[0]!.toUpperCase()}${kind.slice(1)} prompt preset names must be unique.`,
          );
        }
        if (names.some((name) => name.toLowerCase() === 'default')) {
          throw new Error(
            '“Default” is reserved for the built-in prompt. Choose another preset name.',
          );
        }
      }
      return values;
    },
    submit: (values, revision) => api.putSettings(values, revision),
    accepted: (values, next) => {
      applySettings(next);
      baseline = JSON.stringify(values);
      flashSaved();
    },
    discard: load,
    onError: showError,
  });
  const { save, discard, saving } = submission;
  onMount(discard);
  useSettingsGuard(submission);

  return (
    <>
      <Show when={error()}>
        <p ref={errorEl} class="notice notice-error image-settings-notice" role="alert">
          {error()}
        </p>
      </Show>

      <For each={sections}>
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
                  transferKey={editor.kind}
                  onError={showError}
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
                  promptLabel={
                    editor.kind === 'avatar' ? (
                      <>
                        System instruction <MacroHelp rows={AVATAR_MACROS} />
                      </>
                    ) : undefined
                  }
                  contextLabel={
                    <>
                      Character context <MacroHelp rows={AVATAR_MACROS} />
                    </>
                  }
                  label={
                    <>
                      {editor.label}{' '}
                      <Show when={editor.kind !== 'avatar'}>
                        <MacroHelp
                          extra={
                            editor.command
                              ? [['{{instruction}}', `The ${editor.command} command argument`]]
                              : undefined
                          }
                        />
                      </Show>
                    </>
                  }
                />
              )}
            </For>
          </section>
        )}
      </For>

      <Show when={props.mode === 'chat'}>
        <section
          id="image-settings-panel-revision"
          class="settings-section image-settings-panel"
          aria-labelledby="image-settings-title-revision"
        >
          <h3 id="image-settings-title-revision">Chat image revision</h3>
          <p class="hint">
            Used when you regenerate an image prompt inside a chat. The existing conversation and
            its system prompt remain as context; the original image prompt is supplied as the
            preceding assistant message. This setting applies to every chat.
          </p>
          <div class="form-stack field-group" role="group" aria-label="Image revision messages">
            <For
              each={
                [
                  [
                    'promptRevisionContext',
                    'Context message',
                    3,
                    'Inserted before the original prompt when the chat does not end with a user turn. Leave empty to omit it.',
                  ],
                  [
                    'promptRevisionOriginal',
                    'Original prompt message',
                    4,
                    'Sent as the assistant turn being revised. Include {{prompt}}.',
                  ],
                  ['promptRevisionTemplate', 'Revision instruction', 10, ''],
                ] as const
              }
            >
              {([key, label, rows, hint]) => (
                <FormField
                  kind="macro"
                  field={revision.fields[key]}
                  label={label}
                  rows={rows}
                  keys={['instruction', 'prompt']}
                  hint={hint}
                  id={key === 'promptRevisionTemplate' ? 'image-revision-template' : undefined}
                  help={
                    key === 'promptRevisionTemplate'
                      ? [
                          ['{{instruction}}', 'The requested change'],
                          ['{{prompt}}', 'The original image prompt'],
                        ]
                      : undefined
                  }
                />
              )}
            </For>
          </div>
        </section>
      </Show>

      <SettingsActions save={save} discard={discard} saving={saving()} saved={saved()}>
        <SettingsTransferButtons
          type={`page:${props.mode === 'chat' ? 'chatImagePrompts' : 'avatarPrompts'}`}
          onError={showError}
          exportData={() => ({
            presets: Object.fromEntries(
              promptEditors.map(({ kind }) => [kind, editors[kind].value]),
            ),
            ...(props.mode === 'chat' ? revision.value() : {}),
          })}
          importData={(data) => {
            const source = transferObject(data);
            const presets = transferObject(source.presets);
            const incoming = promptEditors
              .filter(({ kind }) => Object.hasOwn(presets, kind))
              .map(({ kind }) => ({
                kind,
                value: importImagePromptSet(presets[kind], editors[kind].value, kind === 'avatar'),
              }));
            if (props.mode === 'chat')
              for (const key of Object.keys(revision.fields)) transferString(source[key], key);
            for (const item of incoming) editors[item.kind].value = item.value;
            if (props.mode === 'chat') revision.load(source as ReturnType<typeof revision.value>);
          }}
        />
      </SettingsActions>
    </>
  );
}

const imageSwipeBusy = new Set<number>();

const imageOnActivePath = (message: Message) =>
  activePath().some((active) => active.id === message.id);

const selectedImageAsset = (message: Message) =>
  message.media[Math.min(message.activeImage, message.media.length - 1)];

const canRenderImage = (message: Message) =>
  !state.treeNavigationPending &&
  imageOnActivePath(message) &&
  !message.imagePending &&
  !message.media.some((asset) => asset.kind === 'video') &&
  (message.hasImageRender ||
    selectedImageAsset(message)?.recipeId != null ||
    (!message.media.some((asset) => asset.recipeId !== null) && activeImageRenderConfig() != null));

/** Shared by header buttons and ChatView's Left/Right shortcut. */
async function swipeImage(message: Message, dir: 1 | -1): Promise<void> {
  const job = mediaJobsByMessage().get(message.id);
  if (message.status === 'streaming' && job) {
    if (dir === 1) {
      try {
        applyMediaJob(await api.mediaJobAction(job, 'cancel'));
      } catch (err) {
        toast(errorMessage(err));
      }
    }
    return;
  }
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
  const activeImage = Math.min(message.activeImage, message.media.length - 1);
  const index = activeImage + dir;
  if (index < 0 || imageSwipeBusy.has(message.id) || state.treeNavigationPending) return;
  imageSwipeBusy.add(message.id);
  try {
    if (index >= message.media.length) {
      if (!canRenderImage(message)) return;
      await navigateTree(() =>
        api.renderImage(
          message.id,
          state.tree,
          message.hasImageRender || selectedImageAsset(message)?.recipeId
            ? undefined
            : activeImageRenderConfig(),
        ),
      );
    } else {
      if (!imageOnActivePath(message)) return;
      await navigateTree(() => api.setActiveImage(message.id, state.tree, { index }));
    }
  } finally {
    imageSwipeBusy.delete(message.id);
  }
}

export const imageMessage = {
  matches: (message: Message) =>
    message.role === 'tool' &&
    (message.media.length > 0 ||
      message.imagePending ||
      message.hasImageRender ||
      message.name === 'Image prompt' ||
      message.name === 'Media prompt'),
  currentImageConfig: (message: Message) =>
    message.hasImageRender || selectedImageAsset(message)?.recipeId
      ? undefined
      : activeImageRenderConfig(),
  swipe: (message: Message, dir: 1 | -1) => {
    void swipeImage(message, dir);
  },
  canDeleteSwipe: (message: Message) =>
    message.media.length > 1 && !message.imagePending && imageOnActivePath(message),
  deleteSwipe: (message: Message) =>
    api.deleteImage(message.id, state.tree, {
      index: Math.min(message.activeImage, message.media.length - 1),
    }),
  create: (message: () => Message, ctx: { streaming: () => boolean; inMap?: () => boolean }) => {
    const [showPrompt, setShowPrompt] = createSignal(false);
    const [viewerOpen, setViewerOpen] = createSignal(false);
    const [savingToGallery, setSavingToGallery] = createSignal(false);
    const media = () => message().media;
    const activeImage = () => Math.min(message().activeImage, media().length - 1);
    const currentAsset = () => media()[activeImage()];
    const currentImage = () => currentAsset()?.url;
    const currentVideo = () => (currentAsset()?.kind === 'video' ? currentAsset() : undefined);
    const mediaJob = () => mediaJobsByMessage().get(message().id);
    const renderProgress = () => mediaJob()?.progress;
    const livePreview = () => (message().imagePending ? renderProgress()?.preview : undefined);
    const displayedImage = () =>
      livePreview() ?? (currentVideo() ? currentVideo()?.thumbnail : currentImage());
    // Collapse the prompt on the first preview to keep the render in focus.
    const promptCollapsed = () => media().length > 0 || livePreview() != null;
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
          class="icon-btn [&.icon-btn]:w-auto [&.icon-btn]:min-w-0 [&.icon-btn]:cursor-pointer [&.icon-btn]:gap-1 [&>svg]:flex-none [&.icon-btn]:px-[3px]"
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
        <Show when={mediaJob()}>
          {(job) => (
            <button
              class="icon-btn"
              title="Open media job"
              aria-label="Open media job"
              onClick={() =>
                openMediaTool(job().operation, {
                  jobId: job().id,
                  conversationId: job().contextConversationId,
                })
              }
            >
              <FontAwesomeIcon icon={faSpinner} size={12} />
            </button>
          )}
        </Show>
        <Show when={currentVideo()?.recipeId}>
          <button
            class="icon-btn"
            title="Rerun media"
            aria-label="Rerun media"
            onClick={() => {
              void openMediaRerun(currentAsset()!, message().conversationId).catch((err: unknown) =>
                toast(errorMessage(err)),
              );
            }}
          >
            <FontAwesomeIcon icon={faRotateRight} size={12} />
          </button>
        </Show>
        <Show when={message().imagePending && !ctx.streaming()}>
          <span class="msg-image-pending inline-flex items-center gap-2 whitespace-nowrap text-dim text-caption tabular-nums [&_.img-progress]:w-16">
            <FontAwesomeIcon
              icon={faSpinner}
              size={10}
              class="spinner inline-block flex-none origin-center size-2.5"
            />
            <SamplerProgress
              progress={renderProgress()}
              stepsLabel="Step"
              fallback={<span>Rendering…</span>}
            />
          </span>
        </Show>
        <Show when={media().length > 0}>
          <span class="msg-actions inline-flex gap-1 touch:opacity-0 touch:pointer-events-none opacity-0 pointer-events-none [&:focus-within]:opacity-100 [&:focus-within]:pointer-events-auto">
            <Show when={currentAsset()}>
              {(asset) => (
                <MediaActions compact asset={asset()} conversationId={message().conversationId} />
              )}
            </Show>
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
          <span class="branch-nav gap-0 inline-flex items-center text-dim text-caption touch:[&_.icon-btn]:opacity-0 touch:[&_.icon-btn]:pointer-events-none touch:[&_.icon-btn]:w-5 touch:[&_.icon-btn]:min-w-5 touch:[&_.icon-btn]:h-7 [&_.icon-btn]:w-4.5 [&_.icon-btn]:min-w-4.5 [&_.icon-btn]:h-6 [&_.icon-btn]:text-sm [&_.icon-btn]:opacity-0 [&_.icon-btn]:pointer-events-none [&:focus-within_.icon-btn]:opacity-100 [&:focus-within_.icon-btn]:pointer-events-auto [&:focus-within_.branch-count]:opacity-100 [&:focus-within_.branch-count]:pointer-events-auto">
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
              class="branch-count px-0.5 min-w-0 whitespace-nowrap text-center touch:opacity-0 touch:pointer-events-none opacity-0 pointer-events-none"
              aria-label={`Image ${activeImage() + 1} of ${media().length}`}
            >
              {activeImage() + 1}/{media().length}
            </span>
            <button
              class="icon-btn"
              disabled={
                state.treeNavigationPending ||
                !onActivePath() ||
                (activeImage() >= media().length - 1 && !canRender())
              }
              title={
                activeImage() >= media().length - 1
                  ? 'Generate another image (same prompt, new seed)'
                  : 'Next image'
              }
              aria-label={
                activeImage() >= media().length - 1
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
            <Markdown
              content={message().content}
              streaming={ctx.streaming()}
              conversationId={message().conversationId}
            />
          </div>
        </Show>
        <Show
          when={!ctx.inMap?.() && !livePreview() && currentVideo()}
          fallback={
            <Show when={displayedImage()}>
              <CrossfadeImage
                class="msg-image block cursor-zoom-in w-full"
                classList={{ 'msg-image-live': livePreview() != null }}
                src={displayedImage()!}
                alt={livePreview() ? 'Image rendering preview' : 'Generated image'}
                wrapperClass="msg-image-crossfade w-full"
                onClick={() => {
                  if (!livePreview() && !currentVideo() && !ctx.inMap?.()) {
                    setViewerOpen(true);
                  }
                }}
              />
              <Show when={viewerOpen() && !livePreview()}>
                <ImageViewer src={currentImage()!} onClose={() => setViewerOpen(false)} />
              </Show>
            </Show>
          }
        >
          {(asset) => (
            <MediaPlayer
              asset={asset()}
              class="msg-image block cursor-zoom-in w-full"
              active={state.modal === null}
            />
          )}
        </Show>
        <Show when={message().genMeta?.imageError && !message().imagePending}>
          <div class="text-danger border border-solid border-danger py-2 px-3 mt-2 text-sm rounded-sm">
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
      fullBleed: () => displayedImage() != null || currentVideo() != null,
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
