import {
  compileMediaWorkflow,
  mediaJobActive,
  newRequestId,
  type MediaAsset,
} from '@tinytavern/shared';
import { faSpinner } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../components/ui/FontAwesomeIcon.tsx';
import { Show, createEffect, createSignal, onCleanup, onMount, on } from 'solid-js';
import { api, ApiError } from '../state/api.ts';
import { applyMediaJob, state, toast } from '../state/store.ts';
import { errorMessage } from '../util.ts';
import Modal from '../components/ui/Modal.tsx';
import PromptGenerationStatus from '../media/PromptGenerationStatus.tsx';
import { avatarRenderConfig } from './imageGeneration.tsx';
import CrossfadeImage from './CrossfadeImage.tsx';
import SamplerProgress from './SamplerProgress.tsx';

/** Render jobs retain previews until acceptance copies the asset directly to the avatar. */
export default function AvatarGenerateModal(props: {
  kind: 'character' | 'persona';
  id: number;
  onClose: () => void;
}) {
  const [text, setText] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [jobId, setJobId] = createSignal<number>();
  const [result, setResult] = createSignal<MediaAsset>();
  const [error, setError] = createSignal('');
  const job = () => state.mediaJobs[jobId()!];
  const image = avatarRenderConfig();
  const streaming = () => job()?.state === 'preparing';
  const reasoning = () => job()?.reasoning ?? '';
  const hasPrompt = () => {
    const workflow =
      state.settings.mediaRendering.workflows.find(
        (workflow) => workflow.id === job()?.workflowId,
      ) ?? image?.workflow;
    return workflow ? compileMediaWorkflow(workflow.json).slots.has('prompt') : false;
  };
  const rendering = () => submitting() || (job() !== undefined && mediaJobActive(job()!.state));
  const progress = () => job()?.progress;
  const previewUrl = () => (rendering() ? progress()?.preview : undefined);
  const imageUrl = () => result()?.url;
  let requestKey = newRequestId();
  let disposed = false;
  let discardOnClose = false;

  createEffect(
    on(
      () => job()?.prompt,
      (prompt) => {
        if (prompt !== undefined) setText(prompt);
      },
    ),
  );

  createEffect(() => {
    const current = job();
    if (current?.state === 'succeeded') {
      const image = current.outputs.find((asset) => asset.kind === 'image');
      setResult(image);
      if (!image) setError('The workflow produced no image to use as an avatar.');
    }
    if (current?.error) setError(current.error);
  });

  const discard = async (id: number, onlyUnstarted = false) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const current = await api.mediaJob(id);
        if (onlyUnstarted && current.startedAt !== null) return;
        await api.discardMediaDraft(current, current.draft!.revision, onlyUnstarted);
        return;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return;
        if (!(err instanceof ApiError && err.status === 409 && attempt === 0)) throw err;
      }
    }
  };

  const render = async (prepare = false) => {
    const prompt = text().trim();
    if (!image || (!prepare && hasPrompt() && !prompt)) {
      setError(
        !image ? 'Select a workflow in Settings → Media rendering first.' : 'Write a prompt first.',
      );
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const values = {
        workflowId: image.workflow.id,
        avatarContext: { kind: props.kind, id: props.id },
        prompt,
        inputs: [],
        fillInputs: { avatar: { kind: props.kind, id: props.id } },
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
      const currentJob = state.mediaJobs[saved.id];
      if (!currentJob) throw new Error('The avatar job is no longer available');
      applyMediaJob(
        await api.mediaJobAction(currentJob, prepare && hasPrompt() ? 'prepare' : 'render', {
          autoRender: true,
        }),
      );
    } catch (err) {
      if (!disposed) setError(errorMessage(err));
    } finally {
      setSubmitting(false);
      if (disposed && jobId())
        void discard(jobId()!, !discardOnClose).catch((err) => toast(errorMessage(err)));
    }
  };

  onMount(() => void render(true));

  onCleanup(() => {
    disposed = true;
    // Started drafts continue in the shared jobs list; Cancel explicitly discards them.
    if (!submitting() && jobId())
      void discard(jobId()!, !discardOnClose).catch((err) => toast(errorMessage(err)));
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
      discardOnClose = true;
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
        <Show when={hasPrompt()}>
          <label>Portrait prompt</label>
          <PromptGenerationStatus active={streaming()} content={text()} reasoning={reasoning()} />
          <textarea
            rows={5}
            value={text()}
            readOnly={busy()}
            placeholder="The model is writing the portrait prompt…"
            onInput={(e) => setText(e.currentTarget.value)}
          />
        </Show>
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
          <button
            onClick={() => {
              discardOnClose = true;
              props.onClose();
            }}
          >
            Cancel
          </button>
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
