import { For, Show, createResource } from 'solid-js';
import { mediaInputLabel, type MediaAsset } from '@tinytavern/shared';
import MediaPlayer from '../../media/MediaPlayer.tsx';
import { api } from '../../state/api.ts';
import { galleryRevision } from '../../state/store.ts';
import { errorMessage } from '../../util.ts';

export default function GallerySourceImages(props: {
  asset: MediaAsset;
  active: boolean;
  onView: (url: string) => void;
}) {
  const [inputs, { refetch }] = createResource(
    () => (props.active && props.asset.recipeId ? { id: props.asset.id, revision: galleryRevision() } : false),
    async ({ id }) => {
      try {
        return { images: await api.mediaAssetInputs(id), error: '' };
      } catch (error) {
        return { images: [], error: errorMessage(error) };
      }
    },
  );
  return (
    <Show when={inputs.loading || inputs()?.error || inputs()?.images.length}>
      <section class="form-stack" aria-label="Source media">
        <label>Source media</label>
        <Show when={inputs.loading}>
          <p class="hint" role="status">
            Loading source media…
          </p>
        </Show>
        <Show when={inputs()?.error}>
          <p class="notice notice-error" role="alert">
            {inputs()?.error}
          </p>
          <button type="button" onClick={() => void refetch()}>
            Retry
          </button>
        </Show>
        <div class="grid gap-2 grid-cols-1">
          <For each={inputs()?.images}>
            {(input) => (
              <Show
                when={input.asset}
                fallback={
                  <div class="flex items-center min-w-0 gap-3 p-2 bg-clear text-left text-muted cursor-zoom-in cursor-default [&_img]:block [&_img]:flex-none [&_img]:rounded-sm [&_img]:object-contain [&_img]:size-12 [&_span]:text-sm">
                    <span class="h-20 border border-dashed border-line grid place-items-center w-full rounded-sm">
                      Deleted media
                    </span>
                    <span>{mediaInputLabel(input.slot)}</span>
                  </div>
                }
              >
                {(asset) => (
                  <Show
                    when={asset().kind === 'video'}
                    fallback={
                      <button
                        type="button"
                        class="flex items-center min-w-0 gap-3 p-2 bg-clear text-left cursor-zoom-in [&_img]:block [&_img]:flex-none [&_img]:rounded-sm [&_img]:object-contain [&_img]:size-12 [&_span]:text-sm"
                        aria-label={`View ${mediaInputLabel(input.slot).toLowerCase()}`}
                        onClick={() => props.onView(asset().url)}
                      >
                        <img
                          src={asset().thumbnail ?? asset().url}
                          alt={mediaInputLabel(input.slot)}
                          loading="lazy"
                          decoding="async"
                        />
                        <span>{mediaInputLabel(input.slot)}</span>
                      </button>
                    }
                  >
                    <div class="form-stack">
                      <span>{mediaInputLabel(input.slot)}</span>
                      <MediaPlayer asset={asset()} active={props.active} class="w-full max-h-48 object-contain" />
                    </div>
                  </Show>
                )}
              </Show>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}
