import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { MediaWorkflow } from '@tinytavern/shared';
import Modal from '../components/ui/Modal.tsx';
import MediaPlayer from './MediaPlayer.tsx';
import { createMediaComparison, type ComparisonResult } from './mediaComparison.ts';
import { createComparisonPlayback, type ComparisonPlaybackState } from './comparisonPlayback.ts';
import { resultWorkflowDetails } from './resultWorkflowDetails.ts';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;

export default function MediaComparison(props: {
  results: ComparisonResult[];
  initial?: string;
  active: boolean;
  busy: boolean;
  error: string;
  workflows: MediaWorkflow[];
  isSaved: (result: ComparisonResult) => boolean;
  canSave: (result: ComparisonResult) => boolean;
  onSave: (result: ComparisonResult) => void;
  onClose: () => void;
}) {
  const selection = createMediaComparison(() => props.results, props.initial);
  const [details, setDetails] = createSignal(false);
  const [playback, setPlayback] = createSignal<ComparisonPlaybackState>({
    playing: false,
    ready: false,
    time: 0,
    duration: 0,
    error: '',
  });
  const transport = createComparisonPlayback(setPlayback);
  onCleanup(transport.dispose);
  createEffect(() => transport.setActive(props.active));
  createEffect(() => {
    if (props.results.length < 2) props.onClose();
  });
  const hasVideo = () => selection.reference()?.asset.kind === 'video' || selection.candidate()?.asset.kind === 'video';
  const differences = createMemo(() => {
    const left = selection.reference();
    const right = selection.candidate();
    if (!left || !right) return [];
    const a = resultWorkflowDetails(left.job, props.workflows);
    const b = resultWorkflowDetails(right.job, props.workflows);
    const parameters = new Set([...a.parameters, ...b.parameters].map((field) => field.label));
    return [
      { label: 'Workflow', left: a.name, right: b.name },
      {
        label: 'Seed',
        left: String(a.seed ?? 'Unavailable'),
        right: String(b.seed ?? 'Unavailable'),
      },
      ...[...parameters].map((label) => ({
        label,
        left: a.parameters.find((field) => field.label === label)?.value ?? '—',
        right: b.parameters.find((field) => field.label === label)?.value ?? '—',
      })),
      { label: 'Instruction', left: left.job.instruction, right: right.job.instruction },
      { label: 'Prompt', left: left.job.prompt, right: right.job.prompt },
    ];
  });
  const Side = (side: { slot: 0 | 1 }) => {
    const result = () => (side.slot === 0 ? selection.reference() : selection.candidate());
    return (
      <section class="media-comparison-side" aria-label={side.slot === 0 ? 'Pinned reference' : 'Comparison candidate'}>
        <Show when={result()}>
          {(item) => (
            <>
              <div class="media-comparison-side-head">
                <strong>
                  {side.slot === 0 ? 'Reference' : 'Candidate'} · Variation {item().variation}
                </strong>
                <Show when={side.slot === 1}>
                  <button onClick={selection.pinCandidate} disabled={props.busy}>
                    Pin as reference
                  </button>
                </Show>
                <button
                  disabled={props.busy || !props.canSave(item()) || props.isSaved(item())}
                  onClick={() => props.onSave(item())}
                  aria-label={`${props.isSaved(item()) ? 'Saved' : item().job.destination === 'chat' ? 'Add' : 'Save'} ${side.slot === 0 ? 'reference' : 'candidate'}`}
                >
                  {props.isSaved(item())
                    ? item().job.destination === 'chat'
                      ? 'Added'
                      : 'Saved'
                    : item().job.destination === 'chat'
                      ? 'Add to chat'
                      : 'Save to gallery'}
                </button>
              </div>
              <div class="media-comparison-picture">
                <Show when={item().asset.id} keyed>
                  {(_id) => (
                    <Show
                      when={item().asset.kind === 'video'}
                      fallback={<img src={item().asset.url} alt={`Variation ${item().variation}`} />}
                    >
                      <MediaPlayer
                        asset={item().asset}
                        class="media-result"
                        active={props.active}
                        controls={false}
                        muted
                        ref={(player) => transport.setPlayer(side.slot, player)}
                      />
                    </Show>
                  )}
                </Show>
              </div>
            </>
          )}
        </Show>
      </section>
    );
  };
  return (
    <Modal
      title="Compare variations"
      fullscreen
      class="media-comparison-modal"
      active={props.active}
      onClose={props.onClose}
    >
      <Show when={props.error}>
        <p class="notice notice-error" role="alert">
          {props.error}
        </p>
      </Show>
      <div class="media-comparison-pair">
        <Side slot={0} />
        <Side slot={1} />
      </div>
      <div class="media-comparison-controls">
        <div class="flex items-center justify-center gap-2 flex-wrap" role="group" aria-label="Comparison navigation">
          <button
            aria-label="Previous comparison candidate"
            disabled={props.busy || selection.index() <= 0}
            onClick={() => selection.navigate(-1)}
          >
            Previous
          </button>
          <span class="text-xs tabular-nums" aria-live="polite">
            Candidate {selection.index() + 1} / {selection.candidates().length}
          </span>
          <button
            aria-label="Next comparison candidate"
            disabled={props.busy || selection.index() >= selection.candidates().length - 1}
            onClick={() => selection.navigate(1)}
          >
            Next
          </button>
          <button aria-expanded={details()} onClick={() => setDetails(!details())}>
            {details() ? 'Hide details' : 'Show details'}
          </button>
        </div>
        <Show when={hasVideo()}>
          <div class="media-comparison-transport" role="group" aria-label="Shared video playback">
            <button
              disabled={!playback().playing && !playback().ready}
              onClick={() => (playback().playing ? transport.pause() : void transport.play())}
            >
              {playback().playing ? 'Pause' : 'Play'}
            </button>
            <input
              type="range"
              aria-label="Comparison playback position"
              min="0"
              max={playback().duration || 0}
              step="0.01"
              value={playback().time}
              disabled={!playback().ready}
              onInput={(event) => transport.seek(Number(event.currentTarget.value))}
            />
            <span class="text-xs tabular-nums">
              {clock(playback().time)} / {clock(playback().duration)}
            </span>
          </div>
          <p class="hint text-center m-0">Muted playback · shared timeline ends with the shorter video</p>
          <Show when={playback().error}>
            <p class="notice notice-error" role="alert">
              {playback().error}
            </p>
          </Show>
        </Show>
      </div>
      <Show when={details()}>
        <div class="media-comparison-details">
          <table>
            <thead>
              <tr>
                <th>Setting</th>
                <th>Reference</th>
                <th>Candidate</th>
              </tr>
            </thead>
            <tbody>
              <For each={differences()}>
                {(field) => (
                  <tr classList={{ 'comparison-different': field.left !== field.right }}>
                    <th scope="row">
                      {field.label}
                      <Show when={field.left !== field.right}>
                        <span class="block text-xs text-dim">Different</span>
                      </Show>
                    </th>
                    <td>{field.left || '—'}</td>
                    <td>{field.right || '—'}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </Modal>
  );
}
