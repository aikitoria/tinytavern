import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import {
  faImage,
  faVideo,
  faComments,
  faSpinner,
  faArrowRight,
} from '@fortawesome/free-solid-svg-icons';
import {
  MEDIA_OPERATIONS,
  mediaJobActive,
  type Character,
  type Conversation,
  type MediaJob,
} from '@tinytavern/shared';
import FontAwesomeIcon from '../components/ui/FontAwesomeIcon.tsx';
import SamplerProgress from '../images/SamplerProgress.tsx';
import MediaJobPreviews from './MediaJobPreviews.tsx';
import { createStreamScroll } from '../streamScroll.ts';
import {
  MEDIA_INPUT_LABELS,
  MEDIA_JOB_STATUS,
  jobPromptExcerpt,
  mediaJobPreviews,
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
  const previews = createMemo(() => mediaJobPreviews(props.group.jobs));
  const previewCount = () => previews().results.length + previews().pending.length;
  const previewWidth = () => (previewCount() > 1 ? Math.min(previewCount(), 3) * 80 - 8 : 104);
  const [intersecting, setVisible] = createSignal(false);
  const visible = () => props.active !== false && intersecting();
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
      class="media-job-card flex flex-col min-w-0 gap-3 p-3 border border-solid border-subtle rounded-md bg-panel"
      classList={{
        'media-job-card-active': active(),
        'media-job-card-failed': job().state === 'failed',
      }}
      aria-label={`${label()}: ${status()}`}
      ref={(element) => onCleanup(props.observe(element, setVisible))}
    >
      <header class="flex items-center justify-between min-w-0 gap-3">
        <div class="flex items-center flex-wrap min-w-0 gap-x-3 gap-y-1">
          <button
            type="button"
            class="flex items-center min-w-0 max-w-full gap-2 p-0 border-clear bg-clear text-left text-label font-semibold [&:hover]:text-accent-hot [&:hover]:bg-clear"
            onClick={open}
            disabled={!canOpen()}
          >
            <FontAwesomeIcon
              icon={job().operation.startsWith('video') ? faVideo : faImage}
              size={13}
              class="text-dim shrink-0"
            />
            <span class="truncate">{label()}</span>
          </button>
          <div class="flex items-center flex-wrap min-w-0 gap-2 text-dim text-tiny">
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
                  class="inline-flex items-center gap-1 max-w-45 min-w-0 [&_img]:object-cover [&_img]:rounded-circle [&_img]:size-4 [&_img]:shrink-0"
                  title={character.name}
                >
                  <Show when={character.avatarThumbnail ?? character.avatar}>
                    {(avatar) => <img src={avatar()} alt="" loading="lazy" decoding="async" />}
                  </Show>
                  <span class="truncate">{character.name}</span>
                </span>
              )}
            </For>
          </div>
          <span class="text-tiny text-dim whitespace-nowrap">
            {previews().results.length}
            <Show when={previews().pending.length}>
              {' / '}
              {previews().results.length + previews().pending.length}
            </Show>{' '}
            {previewCount() === 1 ? 'variation' : 'variations'}
          </span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <Show when={!active()}>
            <button
              type="button"
              class="bg-clear border-transparent text-dim"
              disabled={props.disabled}
              onClick={() => props.onRemove(job())}
            >
              {job().draft?.state === 'open' ? 'Discard' : 'Remove'}
            </button>
          </Show>
          <button
            type="button"
            class="inline-flex items-center gap-2"
            disabled={!canOpen()}
            onClick={open}
          >
            Open
            <FontAwesomeIcon icon={faArrowRight} size={11} />
          </button>
        </div>
      </header>
      <div
        class="grid grid-cols-[var(--media-job-preview-width)_minmax(0,_1fr)] phone:grid-cols-[72px_minmax(0,_1fr)] items-stretch min-w-0 gap-3 phone:[&.media-job-multiple-previews]:grid-cols-1"
        classList={{ 'media-job-multiple-previews': previewCount() > 1 }}
        style={{ '--media-job-preview-width': `${previewWidth()}px` }}
      >
        <MediaJobPreviews
          results={previews().results}
          pending={previews().pending}
          fallback={job()}
          active={visible()}
          pageActive={props.active}
          disabled={!canOpen()}
          onOpen={props.onOpen}
        />
        <div class="relative min-w-0 min-h-18">
          <div class="absolute inset-0 flex flex-col min-w-0 min-h-0">
            <span class="block shrink-0 text-tiny text-muted mb-1">{excerpt().label}</span>
            <Show
              when={preparing()}
              fallback={
                <p
                  class="media-job-excerpt flex-1 min-h-0 whitespace-pre-wrap wrap-anywhere text-xs text-field leading-4.5 m-0"
                  aria-label="Prompt"
                  tabIndex={0}
                >
                  {excerpt().text || 'No prompt yet.'}
                </p>
              }
            >
              <p
                ref={textArea}
                class="media-job-excerpt flex-1 min-h-0 whitespace-pre-wrap wrap-anywhere text-xs text-field leading-4.5 m-0"
                aria-label={job().prompt ? 'Streaming prompt' : 'Streaming reasoning'}
                tabIndex={0}
                onScroll={scroll.onScroll}
              >
                {excerpt().text || 'Waiting for the first tokens…'}
              </p>
            </Show>
          </div>
        </div>
      </div>
      <footer class="flex items-center flex-wrap min-w-0 gap-x-3 gap-y-2 pt-2 border-t border-t-solid border-t-subtle text-tiny text-dim">
        <span class="media-job-status inline-flex items-center gap-1.5 shrink-0" role="status">
          <Show when={active()}>
            <FontAwesomeIcon
              icon={faSpinner}
              size={11}
              class="spinner inline-block size-2.5 flex-none origin-center"
            />
          </Show>
          {status()}
        </span>
        <Show when={active() && !preparing()}>
          <Show when={job().progress?.node}>
            {(node) => (
              <span class="truncate max-w-48 text-muted" title={node().name}>
                {node().name}
              </span>
            )}
          </Show>
          <div
            class="flex items-center flex-wrap gap-x-3 gap-y-1 tabular-nums"
            aria-label="Rendering progress"
          >
            <Show when={job().progress?.graph?.max}>
              <div class="flex items-center gap-1.5 whitespace-nowrap [&_.img-progress]:w-12">
                <span>Nodes</span>
                <SamplerProgress progress={job().progress?.graph} />
              </div>
            </Show>
            <Show when={job().progress?.max}>
              <div class="flex items-center gap-1.5 whitespace-nowrap [&_.img-progress]:w-12">
                <span>Steps</span>
                <SamplerProgress progress={job().progress} />
              </div>
            </Show>
          </div>
        </Show>
        <Show when={job().inputs.length}>
          <div
            class="flex items-center flex-wrap justify-end gap-1.5 ml-auto text-tiny text-muted"
            aria-label="Media inputs"
          >
            <For each={job().inputs}>
              {(input) => (
                <div
                  class="media-job-input relative size-6 overflow-hidden rounded-xs bg-chrome [&_img]:object-cover [&_img]:size-full [&>span:last-child:not(.media-job-input-missing)]:absolute [&>span:last-child:not(.media-job-input-missing)]:right-0 [&>span:last-child:not(.media-job-input-missing)]:bottom-0 [&>span:last-child:not(.media-job-input-missing)]:text-white [&>span:last-child:not(.media-job-input-missing)]:text-micro [&>span:last-child:not(.media-job-input-missing)]:px-0.5"
                  title={`${MEDIA_INPUT_LABELS[input.slot]}${inputAssets().has(input.assetId) ? '' : ' · Image unavailable'}`}
                >
                  <Show
                    when={inputAssets().get(input.assetId)}
                    fallback={
                      <span
                        class="media-job-input-missing grid place-items-center size-full"
                        role="img"
                        aria-label={`${MEDIA_INPUT_LABELS[input.slot]} unavailable`}
                      >
                        <FontAwesomeIcon icon={faImage} size={12} />
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
          </div>
        </Show>
        <Show when={job().error}>
          <p
            class="media-job-error basis-full whitespace-pre-wrap text-danger wrap-anywhere text-xs leading-4.5 m-0 line-clamp-2"
            title={job().error!}
          >
            {job().error}
          </p>
        </Show>
      </footer>
    </article>
  );
}
