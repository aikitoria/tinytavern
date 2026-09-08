import MediaCharacterPicker from './MediaCharacterPicker.tsx';
import { For, Show, createEffect, createSignal, on, onCleanup } from 'solid-js';
import {
  faArrowUpRightFromSquare,
  faCopy,
  faDownload,
  faExpand,
  faRotateRight,
  faSpinner,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons';
import { faTrashCan } from '@fortawesome/free-regular-svg-icons';
import {
  mediaWorkflowKey,
  type GalleryItem,
  type ImageDescriptionProgress,
} from '@tinytavern/shared';
import { applyGalleryItem, state, toast } from '../state/store.ts';
import { api } from '../state/api.ts';
import { download, errorMessage } from '../util.ts';
import Avatar from './Avatar.tsx';
import Select from './Select.tsx';
import SamplerProgress from '../images/SamplerProgress.tsx';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import ImageViewer from './ImageViewer.tsx';
import GallerySourceImages from './GallerySourceImages.tsx';
import MediaPlayer from '../media/MediaPlayer.tsx';
import VideoFullscreenButton from '../media/VideoFullscreenButton.tsx';
import MediaActions from '../media/MediaActions.tsx';
import { openMediaRerun } from '../media/navigation.ts';

export default function GalleryDetail(props: {
  item: GalleryItem;
  readOnly?: boolean;
  active?: boolean;
  showDetails: boolean;
  onDelete: (item: GalleryItem) => Promise<void>;
  onOpenSource: (id: number) => void;
}) {
  let videoPlayer: HTMLVideoElement | undefined;
  const [zoomed, setZoomed] = createSignal(false);
  const [sourceImage, setSourceImage] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [naturalRatio, setNaturalRatio] = createSignal(1);
  const imageRatio = () =>
    props.item.imageWidth && props.item.imageHeight
      ? props.item.imageWidth / props.item.imageHeight
      : naturalRatio();
  const [deleting, setDeleting] = createSignal(false);
  const itemId = props.item.id;
  const [prompt, setPrompt] = createSignal(props.item.prompt);
  const [savedPrompt, setSavedPrompt] = createSignal(props.item.prompt);
  const itemCharacterIds = () =>
    props.item.characters.map((character) => character.id).sort((a, b) => a - b);
  const [characterIds, setCharacterIds] = createSignal(itemCharacterIds());
  const [savedCharacterIds, setSavedCharacterIds] = createSignal(itemCharacterIds());
  const dirty = () =>
    prompt() !== savedPrompt() ||
    JSON.stringify(characterIds()) !== JSON.stringify(savedCharacterIds());
  const [savingDetails, setSavingDetails] = createSignal(false);
  const [error, setError] = createSignal('');
  const [generatingPrompt, setGeneratingPrompt] = createSignal(false);
  const [descriptionProgress, setDescriptionProgress] = createSignal<ImageDescriptionProgress>();
  const [descriptionWorkflowId, setDescriptionWorkflowId] = createSignal<string>();
  const descriptionWorkflows = () =>
    state.settings.mediaRendering.workflows.filter(
      (workflow) => workflow.operation === 'image-describe' && workflow.json.trim(),
    );
  const selectedDescriptionWorkflow = () => {
    const selected =
      descriptionWorkflowId() ??
      state.settings.mediaRendering.defaults[mediaWorkflowKey('image-describe', 0)];
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
  let pendingSave: Promise<boolean> | undefined;
  createEffect(
    on(
      () => [props.item.prompt, itemCharacterIds()] as const,
      ([value, association]) => {
        if (!dirty() && !savingDetails() && !generatingPrompt()) {
          setPrompt(value);
          setSavedPrompt(value);
          setCharacterIds(association);
          setSavedCharacterIds(association);
        }
      },
    ),
  );
  const saveDetails = (): Promise<boolean> => {
    if (pendingSave) return pendingSave;
    if (props.readOnly || !dirty()) return Promise.resolve(true);
    const value = { prompt: prompt(), characterIds: characterIds() };
    setSavingDetails(true);
    setError('');
    pendingSave = api
      .updateGalleryItem(itemId, value, {
        prompt: savedPrompt(),
        characterIds: savedCharacterIds(),
      })
      .then((item) => {
        setSavedPrompt(item.prompt);
        setSavedCharacterIds(
          item.characters.map((character) => character.id).sort((a, b) => a - b),
        );
        applyGalleryItem(item);
        return true;
      })
      .catch((err: unknown) => {
        const message = errorMessage(err);
        setError(message);
        toast(message);
        return false;
      })
      .finally(() => {
        pendingSave = undefined;
        setSavingDetails(false);
      });
    return pendingSave;
  };
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
  const remove = async () => {
    if (deleting()) return;
    setDeleting(true);
    try {
      await props.onDelete(props.item);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div class="gallery-detail">
      <div class="gallery-detail-stage" style={{ '--gallery-image-ratio': imageRatio() }}>
        <Show
          when={video()}
          fallback={
            <button
              type="button"
              class="gallery-detail-image"
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
              class="gallery-detail-video"
              active={props.active !== false && sourceImage() === null}
              autoPlay
              loop
            />
          )}
        </Show>
        <div class="media-preview-actions">
          <button type="button" onClick={() => download(props.item.image)}>
            <FontAwesomeIcon icon={faDownload} size={14} /> Download
          </button>
          <Show when={!props.readOnly && props.item.media}>
            {(asset) => (
              <MediaActions asset={asset()} disabled={savingDetails() || generatingPrompt()} />
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
        class="detail-panel gallery-detail-panel"
        classList={{ hidden: !props.showDetails }}
        aria-label={`${video() ? 'Video' : 'Image'} details`}
      >
        <div class="form-stack">
          <Show
            when={props.item.characters.length}
            fallback={
              <div class="gallery-detail-identity">
                <Avatar name={props.item.characterName} src={null} />
                <strong>{props.item.characterName}</strong>
              </div>
            }
          >
            <For each={props.item.characters}>
              {(character) => (
                <div class="gallery-detail-identity">
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
            <div class="gallery-detail-meta">
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
        <div class="form-stack">
          <div class="gallery-field-head">
            <label for="gallery-detail-prompt">Saved prompt</label>
            <Show when={generatingPrompt()}>
              <span class="prompt-generation-status-line" role="status">
                <FontAwesomeIcon icon={faSpinner} size={12} class="spinner spinner-wait" />
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
                options={descriptionWorkflows().map((workflow) => ({
                  value: workflow.id,
                  label: workflow.name,
                }))}
                onChange={setDescriptionWorkflowId}
              />
            </Show>
            <Show when={descriptionProgress()}>
              {(update) => (
                <div class="gallery-prompt-progress">
                  <p class="hint" role="status">
                    {update().progress.node?.name ??
                      (update().state === 'queued' ? 'Queued' : 'Starting workflow…')}
                  </p>
                  <div class="media-progress-row">
                    <SamplerProgress
                      progress={update().progress.graph}
                      stepsLabel="Nodes"
                      stepsClass="media-progress-count"
                    />
                  </div>
                  <div class="media-progress-row">
                    <SamplerProgress
                      progress={update().progress}
                      stepsLabel="Tokens"
                      stepsClass="media-progress-count"
                    />
                  </div>
                </div>
              )}
            </Show>
            <div class="key-row">
              <button
                class="primary-btn"
                disabled={savingDetails() || generatingPrompt() || !dirty()}
                onClick={() => void saveDetails()}
              >
                {savingDetails() ? 'Saving…' : 'Save'}
              </button>
              <button
                disabled={savingDetails() || generatingPrompt() || !dirty()}
                onClick={() => {
                  setPrompt(props.item.prompt);
                  setSavedPrompt(props.item.prompt);
                  setCharacterIds(itemCharacterIds());
                  setSavedCharacterIds(itemCharacterIds());
                  setError('');
                }}
              >
                Discard
              </button>
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
            <Show when={!video() && !selectedDescriptionWorkflow()}>
              <p class="hint">Add a Describe image workflow in Settings → Media rendering.</p>
            </Show>
            <Show when={error()}>
              <p class="notice notice-error">{error()}</p>
            </Show>
          </Show>
        </div>
        <Show when={!props.readOnly}>
          <div class="gallery-detail-danger">
            <button
              type="button"
              class="danger"
              disabled={deleting()}
              onClick={() => void remove()}
            >
              <FontAwesomeIcon icon={faTrashCan} size={14} /> Delete saved{' '}
              {video() ? 'video' : 'image'}
            </button>
          </div>
        </Show>
      </aside>
      <Show when={sourceImage()}>
        {(url) => <ImageViewer src={url()} onClose={() => setSourceImage(null)} />}
      </Show>
      <Show when={zoomed()}>
        <ImageViewer src={props.item.image} onClose={() => setZoomed(false)} />
      </Show>
    </div>
  );
}
