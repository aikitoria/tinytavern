import { For, Show, createEffect, createMemo, onCleanup } from 'solid-js';
import { faImage, faSpinner, faVideo } from '@fortawesome/free-solid-svg-icons';
import { mediaJobActive, type MediaJob } from '@tinytavern/shared';
import FontAwesomeIcon from '../components/ui/FontAwesomeIcon.tsx';
import VideoPreview from './VideoPreview.tsx';
import { MEDIA_JOB_STATUS, type MediaJobResult } from './jobCards.ts';

const tileClass =
  'relative grid place-items-center shrink-0 w-26 phone:w-18 p-0 overflow-hidden rounded-sm bg-chrome border-clear text-muted [&:not(:has(img,canvas))]:aspect-square [&>img]:block [&>img]:w-full [&>img]:h-auto [&>.video-preview]:max-h-none';
const captionClass =
  'media-job-preview-label absolute bottom-0 left-0 right-0 flex items-center justify-center gap-1 py-0.5 px-1 text-white text-micro';

function PendingPreview(props: {
  job: MediaJob;
  active: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const video = createMemo(() => {
    const preview = props.job.progress?.videoPreview;
    return preview && Object.values(preview.frames).some(Boolean) ? preview : undefined;
  });
  const image = () => props.job.progress?.preview;
  const pending = () => mediaJobActive(props.job.state);
  return (
    <button
      type="button"
      class={tileClass}
      disabled={props.disabled}
      onClick={props.onOpen}
      aria-label={`Open in-progress variation: ${MEDIA_JOB_STATUS[props.job.state]}`}
    >
      <Show
        when={video()}
        fallback={
          <Show
            when={props.active && image()}
            fallback={
              <FontAwesomeIcon
                icon={Boolean(props.job.progress?.videoPreview) ? faVideo : faImage}
                size={24}
              />
            }
          >
            {(src) => <img src={src()} alt="Live preview" decoding="async" />}
          </Show>
        }
      >
        {(preview) => <VideoPreview preview={preview()} active={props.active} />}
      </Show>
      <span class={captionClass}>
        <Show when={pending()}>
          <FontAwesomeIcon icon={faSpinner} size={9} class="spinner shrink-0" />
        </Show>
        {video() || image() ? 'Live' : pending() ? 'Pending' : MEDIA_JOB_STATUS[props.job.state]}
      </span>
    </button>
  );
}

export default function MediaJobPreviews(props: {
  results: MediaJobResult[];
  pending: MediaJob[];
  fallback: MediaJob;
  active: boolean;
  pageActive?: boolean;
  disabled: boolean;
  onOpen: (job: MediaJob, assetId?: number) => void;
}) {
  let strip!: HTMLDivElement;
  const count = createMemo(() => props.results.length + props.pending.length);
  createEffect(() => {
    count();
    if (props.pageActive === false) return;
    const frame = requestAnimationFrame(() => {
      strip.scrollLeft = strip.scrollWidth;
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  return (
    <div
      ref={strip}
      class="flex items-start gap-2 min-w-0 overflow-x-auto overflow-y-hidden [&.media-job-previews-multiple>button]:w-18"
      classList={{ 'media-job-previews-multiple': count() > 1 }}
      aria-label="Finished variations and live previews"
    >
      <For each={props.results}>
        {(result, index) => (
          <button
            type="button"
            class={tileClass}
            disabled={props.disabled}
            onClick={() => props.onOpen(result.job, result.asset.id)}
            aria-label={`Open job for variation ${index() + 1}`}
          >
            <Show
              when={
                result.asset.thumbnail ??
                (result.asset.kind === 'image' ? result.asset.url : undefined)
              }
              fallback={
                <FontAwesomeIcon
                  icon={result.asset.kind === 'video' ? faVideo : faImage}
                  size={24}
                />
              }
            >
              {(src) => (
                <img src={src()} alt={`Variation ${index() + 1}`} loading="lazy" decoding="async" />
              )}
            </Show>
            <span class={captionClass}>Variation {index() + 1}</span>
          </button>
        )}
      </For>
      <For each={props.pending}>
        {(job) => (
          <PendingPreview
            job={job}
            active={props.active}
            disabled={props.disabled}
            onOpen={() => props.onOpen(job)}
          />
        )}
      </For>
      <Show when={!props.results.length && !props.pending.length}>
        <PendingPreview
          job={props.fallback}
          active={props.active}
          disabled={props.disabled}
          onOpen={() => props.onOpen(props.fallback)}
        />
      </Show>
    </div>
  );
}
