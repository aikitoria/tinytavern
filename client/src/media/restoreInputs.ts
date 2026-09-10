import type { GalleryItem, MediaAsset, MediaJob, MediaJobInput } from '@tinytavern/shared';
import type { PageLocation } from '../state/pageLocation.ts';

export interface RestoredMediaInputs {
  inputs: MediaJobInput[];
  assets: MediaAsset[];
}

/** Infer only at reconstruction time. Saved jobs and already-mounted editors own their inputs. */
export function restoreMediaInputs(
  page: PageLocation,
  gallery: readonly GalleryItem[],
  jobs: Readonly<Record<number, MediaJob>>,
): RestoredMediaInputs | undefined {
  const media = page.media;
  if (!media || media.jobId) return;
  for (let index = (page.stack?.length ?? 0) - 1; index >= 0; index--) {
    const ancestor = page.stack![index]!;
    let asset: MediaAsset | undefined;
    if (ancestor.modal === 'gallery' && ancestor.galleryId) {
      asset = gallery.find((item) => item.id === ancestor.galleryId)?.media;
    } else if (ancestor.media?.jobId) {
      const job = jobs[ancestor.media.previewJobId ?? ancestor.media.jobId];
      if (job) {
        const selected = ancestor.media.assetId ?? job.outputs[0]?.id ?? job.draft?.selectedAssetId;
        asset = job.outputs.find((output) => output.id === selected);
        if (!asset && selected != null && job.draft) {
          for (const variation of Object.values(jobs)) {
            if (variation.draft?.id !== job.draft.id) continue;
            asset = variation.outputs.find((output) => output.id === selected);
            if (asset) break;
          }
        }
        asset ??= job.outputs.at(-1);
      }
    }
    if (asset?.kind === 'image') return { inputs: [], assets: [asset] };
  }
}
