import { newRequestId } from '@tinytavern/shared';
import { faSpinner } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../components/ui/FontAwesomeIcon.tsx';
import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { api } from '../state/api.ts';
import { errorMessage } from '../util.ts';
import Modal from '../components/ui/Modal.tsx';
import PromptGenerationStatus from '../media/PromptGenerationStatus.tsx';
import { avatarPromptTemplates, avatarRenderConfig } from './imageGeneration.tsx';
import CrossfadeImage from './CrossfadeImage.tsx';
import SamplerProgress from './SamplerProgress.tsx';

/** Prompt and render previews stay transient until "Use this avatar" uploads the PNG. */
export default function AvatarGenerateModal(props: {
  kind: 'character' | 'persona';
  id: number;
  onClose: () => void;
}) {
  const [text, setText] = createSignal('');
  const [reasoning, setReasoning] = createSignal('');
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

  const render = async () => {
    const image = avatarRenderConfig();
    const prompt = text().trim();
    if (!image) {
      setError('Select a workflow in Settings → Media rendering first.');
      return;
    }
    if (!prompt) {
      setError('Write a prompt first.');
      return;
    }
    const abort = new AbortController();
    renderAbort = abort;
    const jobId = newRequestId();
    setProgress(null);
    setPreviewUrl(null);
    setRendering(true);
    setError('');
    try {
      // Subscribe before rendering to capture the first step; progress must not block rendering.
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
      if (props.kind === 'character') await api.characters.uploadAvatar(props.id, file);
      else await api.personas.uploadAvatar(props.id, file);
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
