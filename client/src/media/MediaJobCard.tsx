import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { faImage, faVideo, faComments, faSpinner } from '@fortawesome/free-solid-svg-icons';
import {
  MEDIA_OPERATIONS,
  mediaJobActive,
  type Character,
  type Conversation,
  type MediaJob,
} from '@tinytavern/shared';
import FontAwesomeIcon from '../components/FontAwesomeIcon.tsx';
import SamplerProgress from '../images/SamplerProgress.tsx';
import VideoPreview from './VideoPreview.tsx';
import {
  MEDIA_INPUT_LABELS,
  MEDIA_JOB_STATUS,
  jobPromptExcerpt,
  type MediaJobGroup,
} from './jobCards.ts';

export default function MediaJobCard(props: {
  group: MediaJobGroup;
  active?: boolean;
  characters: ReadonlyMap<number, Character>;
  conversations: ReadonlyMap<number, Conversation>;
  disabled: boolean;
  observe: (element: Element, visible: (value: boolean) => void) => () => void;
  onOpen: (job: MediaJob) => void;
  onRemove: (job: MediaJob) => void;
}) {
  const job = () => props.group.job;
  const active = () => mediaJobActive(job().state);
  const preparing = () => job().state === 'preparing';
  const label = () =>
    MEDIA_OPERATIONS.find((operation) => operation.id === job().operation)?.label ??
    'Unavailable operation';
  const canOpen = () =>
    !props.disabled && MEDIA_OPERATIONS.some((operation) => operation.id === job().operation);
  const conversation = () => props.conversations.get(job().contextConversationId!);
  const characters = createMemo(() => {
    const ids = new Set(job().characterIds);
    const characterId = conversation()?.characterId;
    if (characterId != null) ids.add(characterId);
    return [...ids].flatMap((id) => {
      const character = props.characters.get(id);
      return character ? [character] : [];
    });
  });
  const inputAssets = createMemo(() => new Map(job().assets.map((asset) => [asset.id, asset])));
  const excerpt = createMemo(() => jobPromptExcerpt(job()));
  const result = createMemo(() => {
    const selected = job().draft?.selectedAssetId;
    for (const variation of props.group.jobs) {
      const asset = variation.outputs.find((asset) => asset.id === selected);
      if (asset) return asset;
    }
    return (
      job().outputs[0] ?? props.group.jobs.find((variation) => variation.outputs.length)?.outputs[0]
    );
  });
  const [intersecting, setVisible] = createSignal(false);
  const visible = () => props.active !== false && intersecting();
  const liveVideo = createMemo(() => {
    const preview = active() && !preparing() ? job().progress?.videoPreview : undefined;
    return preview && Object.values(preview.frames).some(Boolean) ? preview : undefined;
  });
  const liveImage = () => (active() && !preparing() ? job().progress?.preview : undefined);
  const resultImage = () =>
    result()?.thumbnail ?? (result()?.kind === 'image' ? result()?.url : undefined);
  const previewLabel = () =>
    liveVideo() || liveImage() ? 'Live preview' : result() ? 'Result' : 'Waiting for preview';
  const hasPreview = () =>
    Boolean(liveVideo() || liveImage() || result() || (active() && !preparing()));
  const status = () =>
    job().draft?.state === 'open' && job().state === 'succeeded'
      ? 'Choose a variation'
      : MEDIA_JOB_STATUS[job().state];
  const open = () => props.onOpen(job());
  let textArea: HTMLParagraphElement | undefined;
  let frame: number | undefined;
  let follow = true;
  createEffect(() => {
    if (!visible() || !preparing()) return;
    excerpt();
    if (!follow || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (follow && textArea) textArea.scrollTop = textArea.scrollHeight;
    });
  });
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame);
  });

  return (
    <article
      class="media-job-card"
      classList={{
        'media-job-card-active': active(),
        'media-job-card-with-preview': hasPreview(),
        'media-job-card-failed': job().state === 'failed',
      }}
      aria-label={`${label()}: ${status()}`}
      ref={(element) => onCleanup(props.observe(element, setVisible))}
    >
      <Show when={hasPreview()}>
        <button
          class="media-job-preview"
          onClick={open}
          disabled={!canOpen()}
          aria-label={`Open ${label()} preview`}
        >
          <Show
            when={visible() && liveVideo()}
            fallback={
              <Show
                when={(visible() && liveImage()) || resultImage()}
                fallback={
                  <FontAwesomeIcon
                    icon={job().operation.startsWith('video') ? faVideo : faImage}
                    size={24}
                  />
                }
              >
                {(src) => <img src={src()} alt={previewLabel()} loading="lazy" decoding="async" />}
              </Show>
            }
          >
            {(preview) => <VideoPreview preview={preview()} active={visible()} />}
          </Show>
          <span class="media-job-preview-label">{previewLabel()}</span>
        </button>
      </Show>
      <div class="media-job-details">
        <header class="media-job-card-header">
          <button class="media-job-title" onClick={open} disabled={!canOpen()}>
            <FontAwesomeIcon
              icon={job().operation.startsWith('video') ? faVideo : faImage}
              size={14}
            />
            <strong>{label()}</strong>
          </button>
          <span class="media-job-status" role="status">
            <Show when={active()}>
              <FontAwesomeIcon icon={faSpinner} size={11} class="spinner spinner-wait" />
            </Show>
            {status()}
          </span>
        </header>
        <div class="media-job-context">
          <Show
            when={job().contextConversationId !== null}
            fallback={<span>Standalone · Gallery</span>}
          >
            <span class="media-job-chat" title={conversation()?.title ?? 'Chat unavailable'}>
              <FontAwesomeIcon icon={faComments} size={12} />
              {conversation()?.title ?? 'Chat unavailable'}
            </span>
            <Show when={job().destination === 'gallery'}>
              <span>To gallery</span>
            </Show>
          </Show>
          <For each={characters()}>
            {(character) => (
              <span class="media-job-character" title={character.name}>
                <Show when={character.avatarThumbnail ?? character.avatar}>
                  {(avatar) => <img src={avatar()} alt="" loading="lazy" decoding="async" />}
                </Show>
                {character.name}
              </span>
            )}
          </For>
        </div>
        <div class="media-job-text">
          <span class="media-job-text-label">{excerpt().label}</span>
          <p
            ref={textArea}
            class="media-job-excerpt"
            classList={{ 'media-job-streaming': preparing() }}
            aria-label={preparing() && !job().prompt ? 'Streaming reasoning' : 'Prompt excerpt'}
            onScroll={(event) => {
              const area = event.currentTarget;
              follow = area.scrollHeight - area.scrollTop - area.clientHeight < 16;
            }}
          >
            {excerpt().text || (preparing() ? 'Waiting for the first tokens…' : 'No prompt yet.')}
          </p>
        </div>
        <Show when={active() && !preparing()}>
          <div class="media-job-progress">
            <Show when={job().progress?.node}>
              {(node) => (
                <span class="media-job-node" title={node().name}>
                  {node().name}
                </span>
              )}
            </Show>
            <div class="media-job-progress-meter">
              <SamplerProgress progress={job().progress?.graph} stepsLabel="Nodes" />
            </div>
            <div class="media-job-progress-meter">
              <SamplerProgress progress={job().progress} stepsLabel="Steps" />
            </div>
          </div>
        </Show>
        <Show when={job().error}>
          <p class="media-job-error" title={job().error!}>
            {job().error}
          </p>
        </Show>
      </div>
      <footer class="media-job-card-footer">
        <div class="media-job-inputs" aria-label="Media inputs">
          <For each={job().inputs}>
            {(input) => (
              <div
                class="media-job-input"
                title={`${MEDIA_INPUT_LABELS[input.slot]}${inputAssets().has(input.assetId) ? '' : ' · Image unavailable'}`}
              >
                <Show
                  when={inputAssets().get(input.assetId)}
                  fallback={
                    <span
                      class="media-job-input-missing"
                      role="img"
                      aria-label={`${MEDIA_INPUT_LABELS[input.slot]} unavailable`}
                    >
                      <FontAwesomeIcon icon={faImage} size={16} />
                    </span>
                  }
                >
                  {(asset) => (
                    <img
                      src={asset().thumbnail ?? asset().url}
                      alt={MEDIA_INPUT_LABELS[input.slot]}
                      loading="lazy"
                      decoding="async"
                    />
                  )}
                </Show>
                <span>{input.slot.startsWith('reference') ? input.slot.slice(-1) : '1'}</span>
              </div>
            )}
          </For>
          <Show when={props.group.jobs.length > 1}>
            <span class="media-job-variations">{props.group.jobs.length} variations</span>
          </Show>
        </div>
        <div class="media-job-actions">
          <Show when={!active()}>
            <button disabled={props.disabled} onClick={() => props.onRemove(job())}>
              {job().draft?.state === 'open' ? 'Discard' : 'Remove'}
            </button>
          </Show>
          <button disabled={!canOpen()} onClick={open}>
            Open
          </button>
        </div>
      </footer>
    </article>
  );
}
