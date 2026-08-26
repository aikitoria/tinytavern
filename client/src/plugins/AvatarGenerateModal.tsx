import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { api } from '../state/api.ts';
import { errorMessage } from '../util.ts';
import Modal from '../components/Modal.tsx';
import { avatarPromptTemplates, avatarRenderConfig } from './imageGeneration.tsx';
import CrossfadeImage from './CrossfadeImage.tsx';

/**
 * Interactive avatar generation popup: streams the LLM portrait prompt into
 * an editable textarea (macros expanded server-side from the entity), then
 * renders it with the configured avatar workflow. The user can regenerate
 * (fresh seed), edit the text and render again, save the result as the
 * avatar, or cancel — nothing is stored until "Use this avatar" uploads the
 * PNG through the normal avatar route.
 */
export default function AvatarGenerateModal(props: {
  kind: 'character' | 'persona';
  id: number;
  onClose: () => void;
}) {
  const [text, setText] = createSignal('');
  const [streaming, setStreaming] = createSignal(true);
  const [rendering, setRendering] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [imageUrl, setImageUrl] = createSignal<string | null>(null);
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
  const [progress, setProgress] = createSignal<{ value: number; max: number } | null>(null);
  const [error, setError] = createSignal('');
  const promptAbort = new AbortController();
  let renderAbort: AbortController | undefined;
  let disposed = false;

  /** Sampler step progress while rendering (falls back to a bare spinner
   * until the first progress event arrives). */
  const Progress = () => (
    <Show when={progress()} fallback={<span class="spinner spinner-wait" />}>
      {(p) => (
        <>
          <span class="img-progress">
            <span
              class="img-progress-fill"
              style={{ width: `${Math.round((p().value / p().max) * 100)}%` }}
            />
          </span>
          <span class="avatar-gen-steps">
            {p().value}/{p().max}
          </span>
        </>
      )}
    </Show>
  );

  const render = async () => {
    const image = avatarRenderConfig();
    const prompt = text().trim();
    if (!image) {
      setError('Select a workflow in Settings → Tools → Image Generation first.');
      return;
    }
    if (!prompt) {
      setError('Write a prompt first.');
      return;
    }
    const abort = new AbortController();
    renderAbort = abort;
    const jobId = crypto.randomUUID();
    setProgress(null);
    setPreviewUrl(null);
    setRendering(true);
    setError('');
    try {
      // Establish the private progress stream before submitting the render so
      // even the first sampler step is observed. Progress is optional: a
      // broken stream must not prevent image generation itself.
      try {
        const stream = await api.openAvatarRenderProgress(
          jobId,
          (value, max) => {
            if (!disposed && renderAbort === abort) setProgress({ value, max });
          },
          (preview) => {
            if (!disposed && renderAbort === abort) setPreviewUrl(preview);
          },
          abort.signal,
        );
        void stream.done.catch(() => undefined);
      } catch (err) {
        if (abort.signal.aborted) return;
        console.warn('[avatar] progress stream unavailable:', err);
      }
      const blob = await api.renderAvatar({ prompt, image, jobId }, abort.signal);
      if (disposed || abort.signal.aborted || renderAbort !== abort) return;
      const url = URL.createObjectURL(blob);
      const old = imageUrl();
      setImageUrl(url);
      setPreviewUrl(null);
      if (old) URL.revokeObjectURL(old);
    } catch (err) {
      if (!disposed && !abort.signal.aborted) setError(errorMessage(err));
    } finally {
      // Also closes the progress subscription after success/failure.
      abort.abort();
      if (renderAbort === abort) {
        renderAbort = undefined;
        if (!disposed) {
          setProgress(null);
          setPreviewUrl(null);
          setRendering(false);
        }
      }
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
          (d) => setText((t) => t + d),
          promptAbort.signal,
        );
        completed = true;
      } catch (err) {
        if (!promptAbort.signal.aborted && !disposed) setError(errorMessage(err));
      } finally {
        if (!disposed) setStreaming(false);
      }
      // Only a complete prompt is safe to render. A failed stream may have
      // emitted a plausible-looking but truncated prefix.
      if (completed && !promptAbort.signal.aborted && !disposed) await render();
    })();
  });

  onCleanup(() => {
    disposed = true;
    promptAbort.abort();
    renderAbort?.abort();
    const url = imageUrl();
    if (url) URL.revokeObjectURL(url);
  });

  const save = async () => {
    const url = imageUrl();
    if (!url) return;
    setSaving(true);
    setError('');
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], 'avatar.png', { type: blob.type || 'image/png' });
      // The avatar route enforces PNG — a non-PNG workflow output fails here.
      if (props.kind === 'character') await api.uploadCharacterAvatar(props.id, file);
      else await api.uploadPersonaAvatar(props.id, file);
      props.onClose();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };

  const busy = () => streaming() || rendering() || saving();

  return (
    <Modal title="Generate avatar" onClose={props.onClose}>
      <div class="avatar-gen form">
        <label>
          Portrait prompt{' '}
          <Show when={streaming()}>
            <span class="spinner spinner-wait" />
          </Show>
        </label>
        <textarea
          rows={5}
          value={text()}
          readOnly={streaming()}
          placeholder="The model is writing the portrait prompt…"
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <div class="avatar-gen-preview">
          <Show
            when={previewUrl() ?? imageUrl()}
            fallback={
              <div class="avatar-gen-placeholder">
                <Show when={rendering()} fallback={streaming() ? 'Waiting for the prompt…' : null}>
                  <Progress />
                </Show>
              </div>
            }
          >
            {(url) => (
              <CrossfadeImage
                src={url()}
                alt={previewUrl() ? 'Avatar rendering preview' : 'Generated avatar'}
                classList={{ 'avatar-live-preview': previewUrl() != null }}
                wrapperClass="avatar-image-crossfade"
              />
            )}
          </Show>
          <Show when={rendering() && (previewUrl() || imageUrl())}>
            <Progress />
          </Show>
        </div>
        <div class="form-actions">
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
