import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import {
  faArrowUpRightFromSquare,
  faCopy,
  faDownload,
  faExpand,
  faRotateLeft,
  faSpinner,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons';
import { faTrashCan } from '@fortawesome/free-regular-svg-icons';
import type { GalleryItem } from '@tinytavern/shared';
import { api } from '../state/api.ts';
import { state, toast } from '../state/store.ts';
import { download, errorMessage } from '../util.ts';
import { activeImageRenderConfig } from '../images/imageGeneration.tsx';
import SamplerProgress from '../images/SamplerProgress.tsx';
import Avatar from './Avatar.tsx';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import ImageViewer from './ImageViewer.tsx';

export interface GalleryDraft {
  prompt: string;
  instruction: string;
}

export default function GalleryDetail(props: {
  item: GalleryItem;
  draft: GalleryDraft;
  showDetails: boolean;
  onDraft: (patch: Partial<GalleryDraft>) => void;
  onGenerate: (item: GalleryItem, prompt: string) => void;
  onDelete: (item: GalleryItem) => Promise<void>;
  onOpenSource: (id: number) => void;
}) {
  const [zoomed, setZoomed] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [naturalRatio, setNaturalRatio] = createSignal(1);
  const imageRatio = () =>
    props.item.imageWidth && props.item.imageHeight
      ? props.item.imageWidth / props.item.imageHeight
      : naturalRatio();
  const [revising, setRevising] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [revisionError, setRevisionError] = createSignal('');
  let revisionAbort: AbortController | undefined;
  let beforeRevision = '';
  const render = () => state.galleryRenders.find((job) => job.sourceItemId === props.item.id);
  const busy = () => revising() || deleting() || render() != null;
  const canGenerate = () => props.item.hasImageRender || activeImageRenderConfig() != null;
  const character = () =>
    state.characters.find((candidate) => candidate.id === props.item.characterId);
  const cancelRevision = () => {
    if (!revisionAbort) return;
    revisionAbort.abort();
    revisionAbort = undefined;
    props.onDraft({ prompt: beforeRevision });
    setRevising(false);
  };
  onCleanup(cancelRevision);
  createEffect(() => {
    void props.item.image;
    setFailed(false);
  });

  const revise = async () => {
    const original = props.draft.prompt.trim();
    const instruction = props.draft.instruction.trim();
    if (!original || !instruction || busy()) return;
    const abort = new AbortController();
    revisionAbort = abort;
    beforeRevision = props.draft.prompt;
    let streamed = '';
    setRevisionError('');
    setRevising(true);
    props.onDraft({ prompt: '' });
    try {
      const revised = await api.streamGalleryPromptRevision(
        props.item.id,
        original,
        instruction,
        (delta) => {
          if (revisionAbort !== abort) return;
          streamed += delta;
          props.onDraft({ prompt: streamed });
        },
        abort.signal,
      );
      if (revisionAbort !== abort) return;
      props.onDraft({ prompt: revised.trim(), instruction: '' });
    } catch (err) {
      if (revisionAbort === abort && !abort.signal.aborted) {
        props.onDraft({ prompt: beforeRevision });
        setRevisionError(errorMessage(err));
      }
    } finally {
      if (revisionAbort === abort) {
        revisionAbort = undefined;
        setRevising(false);
      }
    }
  };
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(props.draft.prompt);
      toast('Prompt copied.', 'success');
    } catch {
      toast('Could not copy the prompt.');
    }
  };
  const remove = async () => {
    if (busy()) return;
    setDeleting(true);
    try {
      await props.onDelete(props.item);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div class="gallery-detail" classList={{ 'gallery-detail-with-panel': props.showDetails }}>
      <div class="gallery-detail-stage" style={{ '--gallery-image-ratio': imageRatio() }}>
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
        <div class="gallery-detail-image-actions">
          <button type="button" onClick={() => download(props.item.image)}>
            <FontAwesomeIcon icon={faDownload} size={14} /> Download
          </button>
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
        </div>
      </div>
      <aside
        id="gallery-detail-panel"
        class="gallery-detail-panel"
        classList={{ hidden: !props.showDetails }}
        aria-label="Image details and variation controls"
      >
        <div class="gallery-detail-identity">
          <Avatar src={character()?.avatar} name={character()?.name ?? props.item.characterName} />
          <div>
            <strong>{character()?.name ?? props.item.characterName}</strong>
            <time dateTime={new Date(props.item.createdAt).toISOString()}>
              Saved{' '}
              {new Date(props.item.createdAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </time>
          </div>
        </div>
        <Show when={props.item.sourceConversationId}>
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
        <form
          class="form-stack gallery-variation-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (props.draft.prompt.trim() && canGenerate() && !busy())
              props.onGenerate(props.item, props.draft.prompt.trim());
          }}
        >
          <div class="gallery-field-head">
            <label for="gallery-detail-prompt">Prompt</label>
            <div class="gallery-prompt-actions">
              <button
                type="button"
                class="icon-btn"
                title="Copy prompt"
                aria-label="Copy prompt"
                disabled={revising()}
                onClick={() => void copyPrompt()}
              >
                <FontAwesomeIcon icon={faCopy} size={14} />
              </button>
              <button
                type="button"
                class="icon-btn"
                title="Restore saved prompt"
                aria-label="Restore saved prompt"
                disabled={busy() || props.draft.prompt === props.item.prompt}
                onClick={() => props.onDraft({ prompt: props.item.prompt })}
              >
                <FontAwesomeIcon icon={faRotateLeft} size={13} />
              </button>
            </div>
          </div>
          <textarea
            id="gallery-detail-prompt"
            rows={9}
            value={props.draft.prompt}
            readOnly={revising()}
            onInput={(event) => props.onDraft({ prompt: event.currentTarget.value })}
          />
          <p class="hint">Edits apply to your next variation.</p>
          <div class="gallery-variation-actions">
            <button
              class="primary-btn"
              type="submit"
              disabled={!canGenerate() || !props.draft.prompt.trim() || busy()}
            >
              <FontAwesomeIcon icon={faWandMagicSparkles} size={14} /> Generate variation
            </button>
          </div>
          <Show when={!canGenerate()}>
            <p class="notice notice-info">
              Choose an image workflow in Settings → Tools → Image Generation to generate
              variations.
            </p>
          </Show>
        </form>
        <Show when={render()}>
          {(job) => (
            <div class="gallery-detail-render" aria-label="Rendering variation">
              <Show when={job().preview}>
                <img src={job().preview} alt="Variation preview" />
              </Show>
              <div>
                <strong>Rendering variation</strong>
                <span class="gallery-render-status">
                  <SamplerProgress
                    progress={job()}
                    stepsLabel="Step"
                    fallback={<span>Waiting for render…</span>}
                  />
                </span>
              </div>
            </div>
          )}
        </Show>
        <form
          class="form-stack gallery-revision-form"
          onSubmit={(event) => {
            event.preventDefault();
            void revise();
          }}
        >
          <label for="gallery-detail-instruction">Revise with an instruction</label>
          <textarea
            id="gallery-detail-instruction"
            rows={3}
            placeholder="Change the lighting to sunset; keep everything else"
            value={props.draft.instruction}
            readOnly={revising()}
            onInput={(event) => props.onDraft({ instruction: event.currentTarget.value })}
            onKeyDown={(event) => {
              if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void revise();
              }
            }}
          />
          <Show
            when={revising()}
            fallback={
              <button
                type="submit"
                disabled={!props.draft.prompt.trim() || !props.draft.instruction.trim() || busy()}
              >
                Revise prompt
              </button>
            }
          >
            <button type="button" onClick={cancelRevision}>
              <FontAwesomeIcon icon={faSpinner} size={12} class="spinner" /> Stop revision
            </button>
          </Show>
          <Show when={revisionError()}>
            <p class="notice notice-error" role="alert">
              {revisionError()}
            </p>
          </Show>
        </form>
        <div class="gallery-detail-danger">
          <button type="button" class="danger" disabled={busy()} onClick={() => void remove()}>
            <FontAwesomeIcon icon={faTrashCan} size={14} /> Delete saved image
          </button>
        </div>
      </aside>
      <Show when={zoomed()}>
        <ImageViewer src={props.item.image} onClose={() => setZoomed(false)} />
      </Show>
    </div>
  );
}
