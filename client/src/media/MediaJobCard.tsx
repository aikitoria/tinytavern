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
import { createStreamScroll } from '../streamScroll.ts';
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
  const scroll = createStreamScroll(() => textArea, requestAnimationFrame, cancelAnimationFrame);
  createEffect(() => {
    excerpt();
    scroll.update(preparing() ? job().id : null, visible() && preparing());
  });
  onCleanup(scroll.dispose);

  return (
    <article
      class="media-job-card items-center gap-4 p-3 border border-solid border-subtle rounded-md grid min-w-0 bg-panel mobile:gap-3 mobile:grid-cols-1 grid-cols-[minmax(0,_1fr)_auto] [&:where(.media-job-card-with-preview)]:grid-cols-[140px_minmax(0,_1fr)_auto] [&:where(.media-job-card-active)]:border-emphasis [&:where(.media-job-card-active)_.media-job-status]:text-secondary [&:where(.media-job-card-failed)_.media-job-status]:text-danger mobile:[&:where(.media-job-card-with-preview)]:grid-cols-[104px_minmax(0,_1fr)]"
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
          class="w-35 h-26 border-clear grid place-items-center overflow-hidden relative p-0 text-muted rounded-sm bg-chrome mobile:w-26 mobile:self-start [&>img]:min-h-0 [&>img]:max-h-full [&>img]:object-contain [&>img]:size-full [&>canvas.media-result]:min-h-0 [&>canvas.media-result]:max-h-full [&>canvas.media-result]:object-contain [&>canvas.media-result]:size-full"
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
          <span class="media-job-preview-label bottom-0 left-0 right-0 py-0.5 px-1 text-white text-micro absolute">
            {previewLabel()}
          </span>
        </button>
      </Show>
      <div class="flex flex-col min-w-0 gap-2">
        <header class="flex min-w-0 gap-2 justify-between items-center phone:flex-wrap">
          <button
            class="border-clear flex items-center min-w-0 gap-2 p-0 bg-clear text-left [&_strong]:text-sm [&_strong]:truncate [&:hover]:text-accent-hot [&:hover]:bg-clear"
            onClick={open}
            disabled={!canOpen()}
          >
            <FontAwesomeIcon
              icon={job().operation.startsWith('video') ? faVideo : faImage}
              size={14}
            />
            <strong>{label()}</strong>
          </button>
          <span
            class="media-job-status text-tiny inline-flex items-center gap-1 text-dim shrink-0"
            role="status"
          >
            <Show when={active()}>
              <FontAwesomeIcon
                icon={faSpinner}
                size={11}
                class="spinner inline-block w-3 h-3 text-dim flex-none w-2.5 h-2.5 origin-center"
              />
            </Show>
            {status()}
          </span>
        </header>
        <div class="flex min-w-0 gap-2 flex-wrap text-dim text-xs leading-5 items-center">
          <Show
            when={job().contextConversationId !== null}
            fallback={<span>Standalone · Gallery</span>}
          >
            <span
              class="max-w-full truncate [&_svg]:mr-1"
              title={conversation()?.title ?? 'Chat unavailable'}
            >
              <FontAwesomeIcon icon={faComments} size={12} />
              {conversation()?.title ?? 'Chat unavailable'}
            </span>
            <Show when={job().destination === 'gallery'}>
              <span>To gallery</span>
            </Show>
          </Show>
          <For each={characters()}>
            {(character) => (
              <span
                class="max-w-45 py-0 px-1 rounded-sm bg-chrome truncate [&_img]:object-cover [&_img]:rounded-circle [&_img]:align-middle [&_img]:mr-1 [&_img]:size-4.5"
                title={character.name}
              >
                <Show when={character.avatarThumbnail ?? character.avatar}>
                  {(avatar) => <img src={avatar()} alt="" loading="lazy" decoding="async" />}
                </Show>
                {character.name}
              </span>
            )}
          </For>
        </div>
        <div class="min-w-0">
          <span class="text-tiny text-dim">{excerpt().label}</span>
          <p
            ref={textArea}
            class="media-job-excerpt whitespace-pre-wrap h-13.5 wrap-anywhere text-xs leading-4.5 m-0 mt-1 line-clamp-3"
            classList={{ 'media-job-streaming': preparing() }}
            aria-label={preparing() && !job().prompt ? 'Streaming reasoning' : 'Prompt excerpt'}
            onScroll={scroll.onScroll}
          >
            {excerpt().text || (preparing() ? 'Waiting for the first tokens…' : 'No prompt yet.')}
          </p>
        </div>
        <Show when={active() && !preparing()}>
          <div class="text-tiny flex items-center flex-wrap text-dim gap-y-1 gap-x-3">
            <Show when={job().progress?.node}>
              {(node) => (
                <span
                  class="truncate mobile:max-w-full max-w-[min(45%,_320px)]"
                  title={node().name}
                >
                  {node().name}
                </span>
              )}
            </Show>
            <div class="flex items-center min-w-0 gap-1 [&:empty]:display-none [&_.img-progress]:w-16">
              <SamplerProgress progress={job().progress?.graph} stepsLabel="Nodes" />
            </div>
            <div class="flex items-center min-w-0 gap-1 [&:empty]:display-none [&_.img-progress]:w-16">
              <SamplerProgress progress={job().progress} stepsLabel="Steps" />
            </div>
          </div>
        </Show>
        <Show when={job().error}>
          <p
            class="media-job-error whitespace-pre-wrap text-danger wrap-anywhere text-xs leading-4.5 m-0 mt-1 line-clamp-2"
            title={job().error!}
          >
            {job().error}
          </p>
        </Show>
      </div>
      <footer class="flex-col self-stretch max-w-45 flex min-w-0 gap-2 justify-between items-center items-end mobile:col-span-full mobile:flex-row mobile:items-center mobile:max-w-none phone:flex-wrap">
        <div
          class="justify-end flex min-w-0 gap-2 flex-wrap items-center mobile:justify-start"
          aria-label="Media inputs"
        >
          <For each={job().inputs}>
            {(input) => (
              <div
                class="media-job-input relative size-9 [&_img]:grid [&_img]:place-items-center [&_img]:object-cover [&_img]:rounded-sm [&_img]:bg-chrome [&_img]:size-full [&>span:last-child:not(.media-job-input-missing)]:rounded-xs [&>span:last-child:not(.media-job-input-missing)]:absolute [&>span:last-child:not(.media-job-input-missing)]:right-0 [&>span:last-child:not(.media-job-input-missing)]:bottom-0 [&>span:last-child:not(.media-job-input-missing)]:text-white [&>span:last-child:not(.media-job-input-missing)]:text-micro [&>span:last-child:not(.media-job-input-missing)]:p-[0_3px]"
                title={`${MEDIA_INPUT_LABELS[input.slot]}${inputAssets().has(input.assetId) ? '' : ' · Image unavailable'}`}
              >
                <Show
                  when={inputAssets().get(input.assetId)}
                  fallback={
                    <span
                      class="media-job-input-missing grid place-items-center object-cover rounded-sm bg-chrome size-full"
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
            <span class="text-tiny text-dim">{props.group.jobs.length} variations</span>
          </Show>
        </div>
        <div class="flex min-w-0 gap-2 shrink-0 ml-auto mt-auto items-center">
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
