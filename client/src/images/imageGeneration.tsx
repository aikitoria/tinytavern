import SettingsSection from '../components/settings/SettingsSection.tsx';
import SettingsTransferButtons from '../components/settings/SettingsTransferButtons.tsx';
import {
  nextCollectionId,
  newRequestId,
  importImagePromptSet,
  transferObject,
  transferString,
} from '@tinytavern/shared';
import {
  DEFAULT_CHAT_IMAGE_REVISION_CONTEXT,
  DEFAULT_CHAT_IMAGE_REVISION_ORIGINAL,
  DEFAULT_AVATAR_CONTEXT,
  DEFAULT_AVATAR_PROMPT,
} from '@tinytavern/shared';
import type { MediaImageConfig, ImageGenerationSettings } from '@tinytavern/shared';
import SettingLabel from '../components/forms/SettingField.tsx';
import {
  faArrowUpRightFromSquare,
  faChevronLeft,
  faChevronRight,
  faImages as faImagesSolid,
  faRotateRight,
  faSpinner,
  faStar,
} from '@fortawesome/free-solid-svg-icons';
import { faFileLines, faImage, faImages } from '@fortawesome/free-regular-svg-icons';
import FontAwesomeIcon from '../components/ui/FontAwesomeIcon.tsx';
import { For, Match, Show, Switch, createMemo, createSignal, type JSX } from 'solid-js';
import {
  DEFAULT_CHAT_IMAGE_REVISION_TEMPLATE,
  imageRevisionTemplateError,
  type Message,
} from '@tinytavern/shared';
import type { ComposerCommand } from '../composerCommands.ts';
import { api } from '../state/api.ts';
import {
  activePath,
  applyGalleryItem,
  applyMediaJob,
  mediaJobsByMessage,
  navigateTree,
  openModal,
  state,
  toast,
} from '../state/store.ts';
import { errorMessage } from '../util.ts';
import ImageViewer from '../components/ui/ImageViewer.tsx';
import MediaPlayer from '../media/MediaPlayer.tsx';
import VideoPreview from '../media/VideoPreview.tsx';
import PromptGenerationStatus from '../media/PromptGenerationStatus.tsx';
import MediaActions from '../media/MediaActions.tsx';
import { openMediaTool, openMediaRerun } from '../media/navigation.ts';
import MacroHelp from '../components/forms/MacroHelp.tsx';
import Markdown from '../components/ui/Markdown.tsx';
import { createNamedCollection } from '../components/forms/NamedCollectionEditor.tsx';
import FormField, { createFormFields } from '../components/forms/FormFields.tsx';
import CrossfadeImage from './CrossfadeImage.tsx';
import SamplerProgress from './SamplerProgress.tsx';

type ImagePromptPresetSet = NonNullable<ImageGenerationSettings['promptPresets']>[string];
type ImagePromptPreset = ImagePromptPresetSet['presets'][number];

type ImagePromptKind = 'avatar';
const AVATAR_MACROS: [string, string][] = [
  ['{{name}}', 'Character or persona name'],
  ['{{char}}', 'Character name (characters only)'],
  ['{{user}}', 'Persona name (the default persona for characters)'],
  ['{{description}}', 'Character personality / persona description'],
  ['{{personality}}', 'Character personality (characters only)'],
  ['{{scenario}}', 'Character scenario (characters only)'],
  ['{{firstMessage}}', 'Character first message (characters only)'],
];

const AVATAR_EXTRA_KEYS = ['name', 'description', 'personality', 'scenario', 'firstMessage'];

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

export function activeImageRenderConfig(): MediaImageConfig | undefined {
  const cfg = state.settings.mediaRendering;
  const active = cfg.workflows.find((workflow) => workflow.id === cfg.defaultWorkflowId);
  return active?.json.trim() ? { workflow: active, comfyUrl: cfg.comfyUrl } : undefined;
}

/** An unset avatar workflow inherits the generator default. */
export function avatarRenderConfig(): MediaImageConfig | undefined {
  const cfg = state.settings.mediaRendering;
  const avatar = cfg.workflows.find((workflow) => workflow.id === cfg.avatarWorkflowId);
  return avatar?.json.trim()
    ? { workflow: avatar, comfyUrl: cfg.comfyUrl }
    : activeImageRenderConfig();
}

export function avatarGenerationAvailable(): boolean {
  return avatarRenderConfig()?.workflow.textOutputNodeId === null;
}

export function mediaFavoriteTools() {
  return state.settings.mediaFavorites.map((favorite) => ({
    label: favorite.name,
    icon: () => <FontAwesomeIcon icon={faStar} size={16} />,
    run: () => {
      const conversationId = state.selectedId;
      if (conversationId === null) return;
      const requestKey = newRequestId();
      void navigateTree(async () => {
        const job = await api.runMediaFavorite(favorite.id, conversationId, state.tree, requestKey);
        applyMediaJob(job);
      });
    },
  }));
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
  const [presets, setPresets] = createSignal<Preset[]>([]);
  const [selected, setSelected] = createSignal('');
  const collection = createNamedCollection<Preset>({
    items: presets,
    selected,
    identify: (item) => item.id,
    newName: () => numberedName('Preset', presets()),
    defaultLabel: 'Default',
    commit: (items, id) => {
      setPresets(items);
      setSelected(id);
    },
    create: (source, name) => ({
      id: nextCollectionId(presets()),
      name,
      prompt: source?.prompt ?? props.defaultPrompt,
      ...(props.defaultContext === undefined
        ? {}
        : { context: source?.context ?? props.defaultContext }),
    }),
  });
  const { current, patch } = collection;
  const handle: PromptPresetEditorHandle = {
    get value() {
      return {
        presets: presets().map(({ id, ...preset }) => preset),
        active: current()?.name ?? '',
      };
    },
    set value(next: ImagePromptPresetSet) {
      const items = next.presets.map((preset) => ({ ...preset, id: nextCollectionId([]) }));
      setPresets(items);
      setSelected(items.find((preset) => preset.name === next.active)?.id ?? '');
      collection.closeRename();
    },
  };
  if (typeof props.ref === 'function') props.ref(handle);

  return (
    <div class="form-stack field-group prompt-preset-editor [&+.prompt-preset-editor]:mt-2 [&_.macro-box]:w-full [&_.macro-box]:isolate [&_.macro-overlay]:z-0 [&_textarea]:z-1">
      <SettingLabel>{props.label}</SettingLabel>
      <collection.Toolbar
        ariaLabel="Prompt preset"
        nameLabel="Preset name"
        defaultName={
          current() ? numberedName('Preset', presets(), presets().indexOf(current()!)) : ''
        }
        transfer={{
          type: `image-prompt:${props.transferKey}`,
          onError: props.onError,
          allowDefaultExport: true,
          exportData: (preset) =>
            preset
              ? (({ id, ...value }) => value)(preset)
              : {
                  name: 'Default (imported)',
                  prompt: props.defaultPrompt,
                  ...(props.defaultContext === undefined ? {} : { context: props.defaultContext }),
                },
          importData: (data, previous) => {
            const source = transferObject(data);
            const imported = importImagePromptSet(
              { presets: [source], active: source.name },
              { presets: [], active: '' },
              props.defaultContext !== undefined,
            ).presets[0]!;
            if (presets().some((item) => item.id !== previous?.id && item.name === imported.name))
              throw new Error('A preset with this name already exists');
            return { ...imported, id: previous?.id ?? nextCollectionId(presets()) };
          },
        }}
      />
      <FormField
        value={current()?.prompt ?? props.defaultPrompt}
        defaultValue={props.defaultPrompt}
        onChange={(prompt) => {
          if (current()?.prompt !== prompt) patch({ prompt });
        }}
        kind="macro"
        readOnly={!current()}
        label={
          props.promptLabel ??
          (props.defaultContext !== undefined ? 'System instructions' : 'Prompt template')
        }
        extraKeys={props.extraKeys}
      />
      <Show when={props.defaultContext !== undefined}>
        <FormField
          value={current()?.context ?? props.defaultContext!}
          defaultValue={props.defaultContext}
          onChange={(context) => {
            if (current()?.context !== context) patch({ context });
          }}
          kind="macro"
          readOnly={!current()}
          label={props.contextLabel ?? 'User message template'}
          extraKeys={props.contextExtraKeys}
        />
      </Show>
      <Show when={!current()}>
        <span class="text-dim text-caption">Built-in default · create a preset to customize</span>
      </Show>
    </div>
  );
}

export interface ImageGenerationSettingsHandle {
  value: ImageGenerationSettings;
  validate: () => void;
}

/** Embedded fields use their containing page's revision guard and Save/Discard actions. */
export function ImageGenerationSettingsFields(props: {
  ref: (handle: ImageGenerationSettingsHandle) => void;
  onError: (message: string) => void;
}) {
  let baseSettings = state.settings.imageGeneration;
  let avatar!: PromptPresetEditorHandle;
  const revision = createFormFields({
    promptRevisionContext: DEFAULT_CHAT_IMAGE_REVISION_CONTEXT,
    promptRevisionOriginal: DEFAULT_CHAT_IMAGE_REVISION_ORIGINAL,
    promptRevisionTemplate: DEFAULT_CHAT_IMAGE_REVISION_TEMPLATE,
  });
  const handle: ImageGenerationSettingsHandle = {
    get value() {
      return {
        ...baseSettings,
        ...revision.value(),
        promptPresets: { ...baseSettings.promptPresets, avatar: avatar.value },
      };
    },
    set value(next) {
      baseSettings = next;
      revision.load(next);
      avatar.value = normalizePromptPresets(next, 'avatar');
    },
    validate() {
      const invalid = imageRevisionTemplateError(revision.value().promptRevisionTemplate);
      if (invalid) throw new Error(invalid);
      importImagePromptSet(avatar.value, { presets: [], active: '' }, true);
    },
  };
  props.ref(handle);
  return (
    <>
      <SettingsSection
        title="Avatar prompts"
        id="avatar-prompts"
        class="image-settings-panel"
        fields={['imageGeneration.promptPresets.avatar']}
      >
        <p class="hint">Prepare a portrait prompt from character or persona details.</p>
        <PromptPresetEditor
          ref={(value) => (avatar = value)}
          transferKey="avatar"
          onError={props.onError}
          defaultPrompt={DEFAULT_AVATAR_PROMPT}
          extraKeys={AVATAR_EXTRA_KEYS}
          defaultContext={DEFAULT_AVATAR_CONTEXT}
          contextExtraKeys={AVATAR_EXTRA_KEYS}
          promptLabel={
            <>
              System instructions <MacroHelp rows={AVATAR_MACROS} />
            </>
          }
          contextLabel={
            <>
              User message template <MacroHelp rows={AVATAR_MACROS} />
            </>
          }
          label="Saved presets"
        />
      </SettingsSection>
      <SettingsSection
        title="Prompt revision"
        id="prompt-revision"
        class="image-settings-panel"
        fields={Object.keys(revision.fields).map((key) => `imageGeneration.${key}`)}
      >
        <p class="hint">
          Used when revising a media prompt inside a chat. The conversation remains as context, with
          the original prompt supplied as the preceding assistant message.
        </p>
        <div class="form-stack field-group" role="group" aria-label="Prompt revision messages">
          <For
            each={
              [
                [
                  'promptRevisionContext',
                  'Context message template',
                  'Inserted before the original prompt when the chat does not end with a user turn. Leave empty to omit it.',
                ],
                [
                  'promptRevisionOriginal',
                  'Original prompt message template',
                  'Sent as the assistant turn being revised. Include {{prompt}}.',
                ],
                [
                  'promptRevisionTemplate',
                  'Prompt template',
                  'Instructions for revising the original image prompt.',
                ],
              ] as const
            }
          >
            {([key, label, hint]) => (
              <FormField
                kind="macro"
                field={revision.fields[key]}
                label={label}
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
      </SettingsSection>
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
    const liveVideo = createMemo(() => {
      const preview = message().imagePending ? renderProgress()?.videoPreview : undefined;
      return preview && Object.values(preview.frames).some(Boolean) ? preview : undefined;
    });
    const displayedImage = () => (currentVideo() ? currentVideo()?.thumbnail : currentImage());
    // Collapse the prompt on the first preview to keep the render in focus.
    const promptCollapsed = () =>
      media().length > 0 || livePreview() != null || liveVideo() != null;
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
      <>
        <PromptGenerationStatus active={ctx.streaming()} content={message().content} />
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
      </>
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
                openMediaTool(job().workflowId, {
                  jobId: job().id,
                  conversationId: job().contextConversationId,
                })
              }
            >
              <FontAwesomeIcon icon={faArrowUpRightFromSquare} size={12} />
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
        <Show when={message().content && (!promptCollapsed() || showPrompt())}>
          <div class="msg-content">
            <Markdown
              content={message().content}
              streaming={ctx.streaming()}
              conversationId={message().conversationId}
            />
          </div>
        </Show>
        <Switch>
          <Match when={liveVideo()}>
            {(preview) => (
              <div class="msg-image msg-image-live [&>canvas]:max-h-none">
                <Show
                  when={!ctx.inMap?.()}
                  fallback={
                    <img
                      class="block w-full"
                      src={Object.values(preview().frames).find(Boolean)!}
                      alt="Video rendering preview"
                      decoding="async"
                    />
                  }
                >
                  <VideoPreview preview={preview()} active={state.modal === null} />
                </Show>
              </div>
            )}
          </Match>
          <Match when={livePreview()}>
            {(src) => (
              <img
                class="msg-image msg-image-live block w-full"
                src={src()}
                alt="Image rendering preview"
                decoding="async"
              />
            )}
          </Match>
          <Match when={!ctx.inMap?.() && currentVideo()}>
            {(asset) => (
              <MediaPlayer
                asset={asset()}
                class="msg-image block cursor-zoom-in w-full"
                active={state.modal === null}
              />
            )}
          </Match>
          <Match when={displayedImage()}>
            <CrossfadeImage
              class="msg-image block cursor-zoom-in w-full"
              src={displayedImage()!}
              alt="Generated image"
              wrapperClass="msg-image-crossfade w-full"
              onClick={() => {
                if (!currentVideo() && !ctx.inMap?.()) setViewerOpen(true);
              }}
            />
            <Show when={viewerOpen()}>
              <ImageViewer src={currentImage()!} onClose={() => setViewerOpen(false)} />
            </Show>
          </Match>
        </Switch>
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
      fullBleed: () =>
        displayedImage() != null ||
        currentVideo() != null ||
        livePreview() != null ||
        liveVideo() != null,
    };
  },
};

export const mediaGenerationCommands: ComposerCommand[] = [
  {
    name: 'media',
    params: '[prompt]',
    description: 'Open the media generator with an optional final prompt',
    allowDuringGeneration: true,
    run: async (args) => {
      openMediaTool(null, { conversationId: state.selectedId ?? undefined, prompt: args.trim() });
      return true;
    },
  },
];
