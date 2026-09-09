import { mediaJobActive, newRequestId, type MediaAsset } from '@tinytavern/shared';
import { faSpinner } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../components/ui/FontAwesomeIcon.tsx';
import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { api, ApiError } from '../state/api.ts';
import { applyMediaJob, state, toast } from '../state/store.ts';
import { errorMessage } from '../util.ts';
import Modal from '../components/ui/Modal.tsx';
import PromptGenerationStatus from '../media/PromptGenerationStatus.tsx';
import { avatarPromptTemplates, avatarRenderConfig } from './imageGeneration.tsx';
import CrossfadeImage from './CrossfadeImage.tsx';
import SamplerProgress from './SamplerProgress.tsx';

/** Render jobs retain previews until acceptance copies the asset directly to the avatar. */
export default function AvatarGenerateModal(props: {
  kind: 'character' | 'persona';
  id: number;
  onClose: () => void;
}) {
  const [text, setText] = createSignal('');
  const [reasoning, setReasoning] = createSignal('');
  const [streaming, setStreaming] = createSignal(true);
  const [submitting, setSubmitting] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [jobId, setJobId] = createSignal<number>();
  const [result, setResult] = createSignal<MediaAsset>();
  const [error, setError] = createSignal('');
  const promptAbort = new AbortController();
  const job = () => state.mediaJobs[jobId()!];
  const rendering = () => submitting() || (job() !== undefined && mediaJobActive(job()!.state));
  const progress = () => job()?.progress;
  const previewUrl = () => (rendering() ? progress()?.preview : undefined);
  const imageUrl = () => result()?.url;
  let requestKey = newRequestId();
  let disposed = false;

  createEffect(() => {
    const current = job();
    if (current?.state === 'succeeded') setResult(current.outputs[0]);
    if (current?.error) setError(current.error);
  });

  const discard = async (id: number) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const current = await api.mediaJob(id);
        await api.discardMediaDraft(current, current.draft!.revision);
        return;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return;
        if (!(err instanceof ApiError && err.status === 409 && attempt === 0)) throw err;
      }
    }
  };

  const render = async () => {
    const image = avatarRenderConfig();
    const prompt = text().trim();
    if (!image || !prompt) {
      setError(
        !image ? 'Select a workflow in Settings → Media rendering first.' : 'Write a prompt first.',
      );
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const values = {
        operation: 'image' as const,
        workflowId: image.workflow.id,
        prompt,
        inputs: [],
        reviewBeforeSave: true,
      };
      const current = job();
      const saved = current?.submitted
        ? await api.rerunMediaJob(current, requestKey, values)
        : current
          ? await api.editMediaJob(current, values)
          : await api.createMediaJob(values, requestKey);
      requestKey = newRequestId();
      applyMediaJob(saved);
      setJobId(saved.id);
      if (disposed) return;
      applyMediaJob(await api.mediaJobAction(saved, 'render'));
    } catch (err) {
      if (!disposed) setError(errorMessage(err));
    } finally {
      setSubmitting(false);
      if (disposed && jobId()) void discard(jobId()!).catch((err) => toast(errorMessage(err)));
    }
  };

  onMount(() => {
    void (async () => {
      let completed = false;
      try {
        const templates = avatarPromptTemplates();
        await api.streamAvatarPrompt(
          props.kind,
          props.id,
          templates.prompt,
          templates.context,
          (d) => {
            if (disposed || promptAbort.signal.aborted) return;
            setReasoning('');
            setText((t) => t + d);
          },
          promptAbort.signal,
          (delta) => {
            if (!disposed && !promptAbort.signal.aborted && !text()) {
              setReasoning((value) => value + delta);
            }
          },
        );
        completed = true;
      } catch (err) {
        if (!promptAbort.signal.aborted && !disposed) setError(errorMessage(err));
      } finally {
        if (!disposed) {
          setStreaming(false);
          setReasoning('');
        }
      }
      // Failed streams may contain partial prompts that should not be rendered.
      if (completed && !promptAbort.signal.aborted && !disposed) await render();
    })();
  });

  onCleanup(() => {
    disposed = true;
    promptAbort.abort();
    // A pending request performs cleanup after its response establishes the job identity.
    if (!submitting() && jobId()) void discard(jobId()!).catch((err) => toast(errorMessage(err)));
  });

  const save = async () => {
    const asset = result();
    if (!asset) return;
    setSaving(true);
    setError('');
    try {
      await api[props.kind === 'character' ? 'characters' : 'personas'].useAvatarAsset(
        props.id,
        asset.id,
      );
      props.onClose();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };

  const busy = () => streaming() || rendering() || saving();

  return (
    <Modal title="Generate avatar" onClose={props.onClose}>
      <div class="avatar-gen form [&_label]:text-label [&_label]:text-foreground [&_label]:mt-2">
        <label>Portrait prompt</label>
        <PromptGenerationStatus active={streaming()} content={text()} reasoning={reasoning()} />
        <textarea
          rows={5}
          value={text()}
          readOnly={streaming()}
          placeholder="The model is writing the portrait prompt…"
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <div class="min-h-40 flex items-center gap-2 justify-center [&_img]:max-w-64 [&_img]:max-h-64 [&_img]:border [&_img]:border-solid [&_img]:border-line [&_img]:rounded-md">
          <Show
            when={previewUrl() ?? imageUrl()}
            fallback={
              <div class="flex items-center gap-2 text-dim">
                <Show when={rendering()} fallback={streaming() ? 'Waiting for the prompt…' : null}>
                  <SamplerProgress
                    progress={progress()}
                    stepsClass="text-dim text-sm"
                    fallback={
                      <FontAwesomeIcon
                        icon={faSpinner}
                        size={12}
                        class="spinner inline-block w-3 h-3 text-dim flex-none w-2.5 h-2.5 origin-center"
                      />
                    }
                  />
                </Show>
              </div>
            }
          >
            {(url) => (
              <CrossfadeImage
                src={url()}
                alt={previewUrl() ? 'Avatar rendering preview' : 'Generated avatar'}
                classList={{ 'avatar-live-preview': previewUrl() != null }}
                wrapperClass="justify-items-center"
              />
            )}
          </Show>
          <Show when={rendering() && (previewUrl() || imageUrl())}>
            <SamplerProgress
              progress={progress()}
              stepsClass="text-dim text-sm"
              fallback={
                <FontAwesomeIcon
                  icon={faSpinner}
                  size={12}
                  class="spinner inline-block w-3 h-3 text-dim flex-none w-2.5 h-2.5 origin-center"
                />
              }
            />
          </Show>
        </div>
        <div class="form-actions flex items-center gap-2 flex-wrap mt-4">
          <button class="primary-btn" disabled={!imageUrl() || busy()} onClick={() => void save()}>
            {saving() ? 'Saving…' : 'Use this avatar'}
          </button>
          <button disabled={busy()} onClick={() => void render()}>
            {imageUrl() ? 'Regenerate' : 'Render'}
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </div>
        <Show when={error()}>
          <p class="notice notice-error" role="alert">
            {error()}
          </p>
        </Show>
      </div>
    </Modal>
  );
}
