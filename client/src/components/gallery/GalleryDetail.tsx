import { entityOptions } from '../../state/entityReferences.ts';
import { collectionByName } from '../../state/collectionOrder.ts';
import MediaCharacterPicker from '../../media/MediaCharacterPicker.tsx';
import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import {
  faArrowUpRightFromSquare,
  faCopy,
  faCircleInfo,
  faDownload,
  faExpand,
  faRotateRight,
  faSpinner,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons';
import { faTrashCan } from '@fortawesome/free-regular-svg-icons';
import { type GalleryItem, type ImageDescriptionProgress } from '@tinytavern/shared';
import { state, toast } from '../../state/store.ts';
import { api } from '../../state/api.ts';
import { download, errorMessage } from '../../util.ts';
import { prepareTextareaResize } from '../../textareaResize.ts';
import Avatar from '../ui/Avatar.tsx';
import Select from '../ui/Select.tsx';
import SamplerProgress from '../../images/SamplerProgress.tsx';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import ImageViewer from '../ui/ImageViewer.tsx';
import GallerySourceImages from './GallerySourceImages.tsx';
import MediaPlayer from '../../media/MediaPlayer.tsx';
import VideoFullscreenButton from '../../media/VideoFullscreenButton.tsx';
import MediaActions from '../../media/MediaActions.tsx';
import MediaAssetResultDetails from '../../media/MediaAssetResultDetails.tsx';
import { openMediaRerun } from '../../media/navigation.ts';
import type { SettingsSectionActions } from '../../state/settingsSubmission.ts';
import { createGalleryDetailEditor } from './galleryDetailEditor.ts';

export default function GalleryDetail(props: {
  item: GalleryItem;
  readOnly?: boolean;
  active?: boolean;
  showDetails: boolean;
  onDelete: (item: GalleryItem, event: MouseEvent) => Promise<void>;
  onOpenSource: (id: number) => void;
  register: (actions: SettingsSectionActions) => () => void;
}) {
  let videoPlayer: HTMLVideoElement | undefined;
  const [zoomed, setZoomed] = createSignal(false);
  const [resultDetailsOpen, setResultDetailsOpen] = createSignal(false);
  const [sourceImage, setSourceImage] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [naturalRatio, setNaturalRatio] = createSignal(1);
  const imageRatio = () =>
    props.item.imageWidth && props.item.imageHeight
      ? props.item.imageWidth / props.item.imageHeight
      : naturalRatio();
  const [deleting, setDeleting] = createSignal(false);
  const itemId = props.item.id;
  const [error, setError] = createSignal('');
  const [generatingPrompt, setGeneratingPrompt] = createSignal(false);
  const detailsValue = (item: GalleryItem) => ({
    prompt: item.prompt,
    characterIds: item.characters.map((character) => character.id).sort((a, b) => a - b),
    folderId: item.folderId,
  });
  const editor = createGalleryDetailEditor({
    value: () => detailsValue(props.item),
    generating: generatingPrompt,
    submit: async (value, expected) => {
      const item = await api.updateGalleryItem(itemId, value, expected);
      return detailsValue(item);
    },
    onError: (message) => {
      setError(message);
      if (message) toast(message);
    },
  });
  const {
    prompt,
    setPrompt,
    characterIds,
    setCharacterIds,
    folderId,
    setFolderId,
    dirty,
    saving: savingDetails,
    save: saveDetails,
  } = editor;
  const [descriptionProgress, setDescriptionProgress] = createSignal<ImageDescriptionProgress>();
  const [descriptionWorkflowId, setDescriptionWorkflowId] = createSignal<string>();
  const descriptionWorkflows = () =>
    state.settings.mediaRendering.workflows.filter(
      (workflow) => workflow.textOutputNodeId !== null && workflow.json.trim(),
    );
  const selectedDescriptionWorkflow = () => {
    const selected = descriptionWorkflowId() ?? state.settings.mediaRendering.descriptionWorkflowId;
    return (
      descriptionWorkflows().find((workflow) => workflow.id === selected)?.id ??
      descriptionWorkflows()[0]?.id
    );
  };
  let descriptionAbort: AbortController | undefined;
  const generatePrompt = async () => {
    const workflowId = selectedDescriptionWorkflow();
    if (!workflowId || generatingPrompt() || savingDetails()) return;
    const abort = new AbortController();
    descriptionAbort = abort;
    setGeneratingPrompt(true);
    setDescriptionProgress(undefined);
    setError('');
    try {
      const generated = await api.generateGalleryPrompt(
        itemId,
        workflowId,
        abort.signal,
        setDescriptionProgress,
      );
      if (!abort.signal.aborted) setPrompt(generated);
    } catch (err) {
      if (!abort.signal.aborted) setError(errorMessage(err));
    } finally {
      descriptionAbort = undefined;
      setGeneratingPrompt(false);
      setDescriptionProgress(undefined);
    }
  };
  onCleanup(() => descriptionAbort?.abort());
  const discardDetails = () => {
    descriptionAbort?.abort();
    editor.discard();
  };
  if (!props.readOnly)
    onCleanup(
      props.register({
        isDirty: dirty,
        saving: savingDetails,
        save: () => {
          descriptionAbort?.abort();
          return saveDetails();
        },
        discard: discardDetails,
      }),
    );
  const video = () => (props.item.media?.kind === 'video' ? props.item.media : undefined);
  createEffect(() => {
    void props.item.image;
    setFailed(false);
  });

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt());
      toast('Prompt copied.', 'success');
    } catch {
      toast('Could not copy the prompt.');
    }
  };
  const remove = async (event: MouseEvent) => {
    if (deleting()) return;
    setDeleting(true);
    try {
      await props.onDelete(props.item, event);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div class="gallery-detail min-w-0 min-h-0 flex flex-1 mobile:flex-col mobile:overflow-visible">
      <div
        class="gallery-detail-stage items-center flex flex-col min-w-0 min-h-0 flex-1 justify-center relative gap-gallery-image p-gallery-image mobile:flex-none mobile:min-h-55 mobile:h-[calc(100dvh_-_60px)]"
        style={{ '--gallery-image-ratio': imageRatio() }}
      >
        <Show
          when={video()}
          fallback={
            <button
              type="button"
              class="border-clear rounded-none cursor-default grid place-items-center flex-none min-h-0 overflow-hidden p-0 bg-clear aspect-gallery [&:hover:not(:disabled)]:bg-clear [&_img]:block [&_img]:max-w-full [&_img]:max-h-full [&_img]:min-h-0 [&_img]:object-contain [&_img]:cursor-zoom-in [&_img]:size-full w-[min(_100%,_calc(_(100cqh_-_var(--control-height)_-_var(--gallery-image-spacing))_*_var(--gallery-image-ratio)_)_)]"
              aria-label="Open full-size image; zoom and pan"
              disabled={failed()}
              onClick={(event) => {
                // Pointer clicks must land on the fitted image; keep native keyboard activation.
                if (event.target instanceof HTMLImageElement || event.detail === 0) setZoomed(true);
              }}
            >
              <Show when={!failed()} fallback={<span class="hint">Image unavailable</span>}>
                <img
                  src={props.item.image}
                  alt={`Saved image for ${props.item.characterName}`}
                  decoding="async"
                  onLoad={(event) => {
                    const image = event.currentTarget;
                    if (image.naturalWidth && image.naturalHeight)
                      setNaturalRatio(image.naturalWidth / image.naturalHeight);
                  }}
                  onError={() => setFailed(true)}
                />
              </Show>
            </button>
          }
        >
          {(asset) => (
            <MediaPlayer
              ref={(player) => {
                videoPlayer = player;
              }}
              asset={asset()}
              class="block h-auto object-contain flex-none min-h-0 aspect-video-media w-[min(_100%,_calc((100cqh_-_var(--control-height)_-_var(--gallery-image-spacing))_*_var(--media-video-ratio))_)]"
              active={props.active !== false && sourceImage() === null && !resultDetailsOpen()}
              autoPlay
              loop
            />
          )}
        </Show>
        <div class="flex flex-wrap justify-center gap-2 flex-none p-0 [&_button]:inline-flex [&_button]:items-center [&_button]:justify-center [&_button]:gap-1 [&_button]:h-control [&_button]:py-1 [&_button]:px-2 [&_button]:text-dim [&_button]:bg-clear [&_button]:border-transparent [&_button]:text-xs">
          <Show when={props.item.media?.recipeId}>
            <button type="button" onClick={() => setResultDetailsOpen(true)}>
              <FontAwesomeIcon icon={faCircleInfo} size={14} /> Result details
            </button>
          </Show>
          <button type="button" onClick={() => download(props.item.image)}>
            <FontAwesomeIcon icon={faDownload} size={14} /> Download
          </button>
          <Show when={!props.readOnly && props.item.media}>
            {(asset) => (
              <MediaActions
                asset={asset()}
                galleryFolderId={props.item.folderId}
                disabled={savingDetails() || generatingPrompt()}
              />
            )}
          </Show>
          <Show when={!props.readOnly && props.item.media?.recipeId}>
            <button
              type="button"
              disabled={savingDetails() || generatingPrompt()}
              onClick={() => {
                void openMediaRerun(props.item.media!).catch((err: unknown) =>
                  toast(errorMessage(err)),
                );
              }}
            >
              <FontAwesomeIcon icon={faRotateRight} size={14} /> Rerun
            </button>
          </Show>
          <Show when={!video()}>
            <button
              type="button"
              title="Open full-size image"
              aria-label="Open full-size image"
              disabled={failed()}
              onClick={() => setZoomed(true)}
            >
              <FontAwesomeIcon icon={faExpand} size={14} />{' '}
              <Show when={props.item.imageWidth && props.item.imageHeight} fallback="Full size">
                {props.item.imageWidth} × {props.item.imageHeight}
              </Show>
            </button>
          </Show>
          <Show when={video()}>
            {(asset) => <VideoFullscreenButton asset={asset()} player={() => videoPlayer} />}
          </Show>
        </div>
      </div>
      <aside
        id="gallery-detail-panel"
        class="detail-panel gallery-detail-panel flex flex-col gap-4 flex-none min-h-0 p-4 overflow-y-auto bg-panel border-l border-l-solid border-l-subtle [&>*]:shrink-0 [&_textarea]:block [&_textarea]:w-full [&_textarea]:min-h-20 [&_textarea]:resize-y [&_.hint]:m-0 [&_.hint]:text-xs [&_.notice]:m-0 [&_.notice]:text-xs mobile:w-full mobile:overflow-visible [&.media-tool-form]:gap-0 [&.media-tool-form]:min-w-0 [&.media-tool-form]:p-0 [&.media-tool-form]:overflow-hidden mobile:[&.media-tool-form]:overflow-visible [&>.gallery-detail-prompt]:shrink-0 [&>.gallery-detail-prompt]:flex-auto mobile:[&>.gallery-detail-prompt]:flex-none w-[var(--detail-panel-width,_450px)]"
        classList={{ hidden: !props.showDetails }}
        aria-label={`${video() ? 'Video' : 'Image'} details`}
      >
        <div class="form-stack">
          <Show
            when={props.item.characters.length}
            fallback={
              <div class="flex items-center gap-2 [&_.avatar]:size-8 [&>div]:flex [&>div]:flex-col [&>div]:min-w-0 [&_strong]:text-body-small [&_strong]:truncate [&_time]:text-dim [&_time]:text-xs">
                <Avatar name={props.item.characterName} src={null} />
                <strong>{props.item.characterName}</strong>
              </div>
            }
          >
            <For each={props.item.characters}>
              {(character) => (
                <div class="flex items-center gap-2 [&_.avatar]:size-8 [&>div]:flex [&>div]:flex-col [&>div]:min-w-0 [&_strong]:text-body-small [&_strong]:truncate [&_time]:text-dim [&_time]:text-xs">
                  <Avatar
                    name={character.name}
                    src={state.characters.find((item) => item.id === character.id)?.avatarThumbnail}
                  />
                  <strong>{character.name}</strong>
                </div>
              )}
            </For>
          </Show>
          <time class="hint" dateTime={new Date(props.item.createdAt).toISOString()}>
            Saved{' '}
            {new Date(props.item.createdAt).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </time>
        </div>
        <Show when={!props.readOnly}>
          <div class="form-stack">
            <label for="gallery-detail-folder">Folder</label>
            <Select
              id="gallery-detail-folder"
              ariaLabel="Image folder"
              value={String(folderId() ?? 'root')}
              disabled={savingDetails() || generatingPrompt()}
              options={[
                { value: 'root', label: 'Unfiled' },
                ...collectionByName(state.galleryFolders).map((folder) => ({
                  value: String(folder.id),
                  label: folder.name,
                })),
              ]}
              onChange={(value) => setFolderId(value === 'root' ? null : Number(value))}
            />
          </div>
          <div class="form-stack">
            <label>Characters</label>
            <MediaCharacterPicker
              value={characterIds()}
              disabled={savingDetails() || generatingPrompt()}
              onChange={setCharacterIds}
            />
          </div>
        </Show>
        <Show when={!props.readOnly && props.item.sourceConversationId}>
          {(sourceId) => (
            <div class="flex items-center gap-3 flex-wrap text-dim text-xs [&_a]:inline-flex [&_a]:items-center [&_a]:gap-1 -mt-2">
              <a
                href={`#${sourceId()}`}
                onClick={(event) => {
                  event.preventDefault();
                  props.onOpenSource(sourceId());
                }}
              >
                Source chat <FontAwesomeIcon icon={faArrowUpRightFromSquare} size={11} />
              </a>
            </div>
          )}
        </Show>
        <Show when={props.item.media?.recipeId ? props.item.media : undefined}>
          {(asset) => (
            <GallerySourceImages
              asset={asset()}
              active={props.showDetails && props.active !== false}
              onView={setSourceImage}
            />
          )}
        </Show>
        <div class="form-stack gallery-detail-prompt [&>textarea]:shrink-0 [&>textarea]:min-h-45 [&>textarea]:flex-auto mobile:[&>textarea]:flex-none">
          <div class="flex items-center justify-between [&_label]:text-foreground [&_label]:text-sm [&_label]:font-semibold">
            <label for="gallery-detail-prompt">Saved prompt</label>
            <Show when={generatingPrompt()}>
              <span class="flex items-center gap-2 text-dim text-sm" role="status">
                <FontAwesomeIcon
                  icon={faSpinner}
                  size={12}
                  class="spinner inline-block w-3 h-3 text-dim flex-none w-2.5 h-2.5 origin-center"
                />
                Generating prompt…
              </span>
            </Show>
            <button
              type="button"
              class="icon-btn"
              title="Copy prompt"
              aria-label="Copy prompt"
              onClick={() => void copyPrompt()}
            >
              <FontAwesomeIcon icon={faCopy} size={14} />
            </button>
          </div>
          <textarea
            id="gallery-detail-prompt"
            onPointerDown={prepareTextareaResize}
            rows={9}
            value={prompt()}
            readOnly={props.readOnly || savingDetails() || generatingPrompt()}
            onInput={(event) => setPrompt(event.currentTarget.value)}
          />
          <Show when={!props.readOnly}>
            <Show when={!video() && descriptionWorkflows().length > 1}>
              <Select
                ariaLabel="Image description workflow"
                value={selectedDescriptionWorkflow() ?? ''}
                disabled={savingDetails() || generatingPrompt()}
                options={entityOptions('workflows', descriptionWorkflows())}
                onChange={setDescriptionWorkflowId}
              />
            </Show>
            <Show when={descriptionProgress()}>
              {(update) => (
                <div class="flex flex-col gap-2">
                  <p class="hint" role="status">
                    {update().progress.node?.name ??
                      (update().state === 'queued' ? 'Queued' : 'Starting workflow…')}
                  </p>
                  <div class="media-progress-row items-center tabular-nums grid gap-3 text-xs [&:empty]:display-none [&_.img-progress]:w-full grid-cols-[minmax(0,_1fr)_12ch]">
                    <SamplerProgress
                      progress={update().progress.graph}
                      stepsLabel="Nodes"
                      stepsClass="text-right whitespace-nowrap text-dim"
                    />
                  </div>
                  <div class="media-progress-row items-center tabular-nums grid gap-3 text-xs [&:empty]:display-none [&_.img-progress]:w-full grid-cols-[minmax(0,_1fr)_12ch]">
                    <SamplerProgress
                      progress={update().progress}
                      stepsLabel="Tokens"
                      stepsClass="text-right whitespace-nowrap text-dim"
                    />
                  </div>
                </div>
              )}
            </Show>
            <Show when={dirty() || savingDetails() || !video()}>
              <div class="key-row flex items-center gap-2 [&_input]:flex-1 [&_input]:min-w-0 [&_.select-control]:flex-1 [&_.select-control]:min-w-0 [&>button:not(.select-btn)]:whitespace-nowrap [&>button:not(.select-btn)]:shrink-0">
                <Show when={dirty() || savingDetails()}>
                  <button
                    class="primary-btn"
                    disabled={savingDetails() || generatingPrompt() || !dirty()}
                    onClick={() => void saveDetails()}
                  >
                    {savingDetails() ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    disabled={savingDetails() || generatingPrompt() || !dirty()}
                    onClick={discardDetails}
                  >
                    Discard
                  </button>
                </Show>
                <Show when={!video()}>
                  <Show
                    when={generatingPrompt()}
                    fallback={
                      <button
                        disabled={savingDetails() || !selectedDescriptionWorkflow()}
                        onClick={() => void generatePrompt()}
                      >
                        <FontAwesomeIcon icon={faWandMagicSparkles} size={14} /> Generate
                      </button>
                    }
                  >
                    <button onClick={() => descriptionAbort?.abort()}>Cancel</button>
                  </Show>
                </Show>
              </div>
            </Show>
            <Show when={!video() && !selectedDescriptionWorkflow()}>
              <p class="hint">Add a Describe image workflow in Settings → Media rendering.</p>
            </Show>
            <Show when={error()}>
              <p class="notice notice-error">{error()}</p>
            </Show>
          </Show>
        </div>
        <Show when={!props.readOnly}>
          <div class="mt-auto pt-3 border-t border-t-solid border-t-subtle [&_button]:pl-0 [&_button]:bg-clear [&_button]:border-transparent [&_button]:text-xs">
            <button
              type="button"
              class="danger"
              disabled={deleting()}
              onClick={(event) => void remove(event)}
            >
              <FontAwesomeIcon icon={faTrashCan} size={14} /> Delete saved{' '}
              {video() ? 'video' : 'image'}
            </button>
          </div>
        </Show>
      </aside>
      <Show when={resultDetailsOpen() && props.item.media}>
        {(asset) => (
          <MediaAssetResultDetails
            assetId={asset().id}
            onClose={() => setResultDetailsOpen(false)}
          />
        )}
      </Show>
      <Show when={sourceImage()}>
        {(url) => <ImageViewer src={url()} onClose={() => setSourceImage(null)} />}
      </Show>
      <Show when={zoomed()}>
        <ImageViewer src={props.item.image} onClose={() => setZoomed(false)} />
      </Show>
    </div>
  );
}
