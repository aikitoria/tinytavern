import { For, Show, createResource } from 'solid-js';
import type { MediaAsset, MediaAssetInput } from '@tinytavern/shared';
import { api } from '../state/api.ts';
import { galleryRevision } from '../state/store.ts';
import { errorMessage } from '../util.ts';

const INPUT_LABELS: Record<MediaAssetInput['slot'], string> = {
  source: 'Source image',
  first_frame: 'First frame',
  reference1: 'Reference 1',
  reference2: 'Reference 2',
  reference3: 'Reference 3',
};

export default function GallerySourceImages(props: {
  asset: MediaAsset;
  active: boolean;
  onView: (url: string) => void;
}) {
  const [inputs, { refetch }] = createResource(
    () =>
      props.active && props.asset.recipeId
        ? { id: props.asset.id, revision: galleryRevision() }
        : false,
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
      <section class="form-stack" aria-label="Source images">
        <label>Source images</label>
        <Show when={inputs.loading}>
          <p class="hint" role="status">
            Loading source images…
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
        <div class="gallery-source-images">
          <For each={inputs()?.images}>
            {(input) => (
              <Show
                when={input.asset}
                fallback={
                  <div class="gallery-source-image gallery-source-deleted">
                    <span class="gallery-source-placeholder">Deleted image</span>
                    <span>{INPUT_LABELS[input.slot]}</span>
                  </div>
                }
              >
                {(asset) => (
                  <button
                    type="button"
                    class="gallery-source-image"
                    aria-label={`View ${INPUT_LABELS[input.slot].toLowerCase()}`}
                    onClick={() => props.onView(asset().url)}
                  >
                    <img
                      src={asset().url}
                      alt={INPUT_LABELS[input.slot]}
                      loading="lazy"
                      decoding="async"
                    />
                    <span>{INPUT_LABELS[input.slot]}</span>
                  </button>
                )}
              </Show>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}
