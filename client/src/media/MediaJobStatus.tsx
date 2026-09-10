import { Show } from 'solid-js';
import { faSpinner } from '@fortawesome/free-solid-svg-icons';
import { mediaJobActive, type MediaJob } from '@tinytavern/shared';
import FontAwesomeIcon from '../components/ui/FontAwesomeIcon.tsx';
import SamplerProgress from '../images/SamplerProgress.tsx';
import { MEDIA_JOB_STATUS } from './jobCards.ts';

export default function MediaJobStatus(props: { job: MediaJob; label?: string }) {
  const active = () => mediaJobActive(props.job.state);
  return (
    <div class="flex flex-1 items-center min-w-0 gap-3 text-tiny text-dim">
      <span
        class="inline-flex items-center gap-1.5 shrink-0"
        classList={{ 'text-secondary': active(), 'text-danger': props.job.state === 'failed' }}
        role="status"
      >
        <Show when={active()}>
          <FontAwesomeIcon
            icon={faSpinner}
            size={11}
            class="spinner inline-block size-2.5 flex-none origin-center"
          />
        </Show>
        {props.label ?? MEDIA_JOB_STATUS[props.job.state]}
      </span>
      <Show when={active() && props.job.state !== 'preparing'}>
        <div class="flex items-center min-w-0 gap-3 tabular-nums" aria-label="Rendering progress">
          <Show when={props.job.progress?.graph?.max}>
            <div class="flex items-center min-w-0 gap-1.5 whitespace-nowrap [&_.img-progress]:w-12 [&_.img-progress]:shrink [&_.img-progress]:min-w-2">
              <span>Nodes</span>
              <SamplerProgress progress={props.job.progress?.graph} />
            </div>
          </Show>
          <Show when={props.job.progress?.max}>
            <div class="flex items-center min-w-0 gap-1.5 whitespace-nowrap [&_.img-progress]:w-12 [&_.img-progress]:shrink [&_.img-progress]:min-w-2">
              <span>Steps</span>
              <SamplerProgress progress={props.job.progress} />
            </div>
          </Show>
        </div>
        <Show when={props.job.progress?.node}>
          {(node) => (
            <span class="flex-1 min-w-0 truncate max-w-48 text-muted" title={node().name}>
              {node().name}
            </span>
          )}
        </Show>
      </Show>
    </div>
  );
}
