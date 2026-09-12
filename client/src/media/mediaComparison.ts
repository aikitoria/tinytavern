import { batch, createMemo, createSignal, type Accessor } from 'solid-js';
import type { MediaJobResult } from './jobCards.ts';

export interface ComparisonResult extends MediaJobResult {
  variation: number;
}

export const comparisonKey = (result: MediaJobResult) => `${result.job.id}:${result.asset.id}`;

/** Comparison owns navigation only; neither the working editor nor its preview is selected. */
export function createMediaComparison(results: Accessor<ComparisonResult[]>, initial?: string) {
  const first = results().find((result) => comparisonKey(result) === initial) ?? results().at(-1);
  const [referenceKey, setReferenceKey] = createSignal(first ? comparisonKey(first) : '');
  const [candidateKey, setCandidateKey] = createSignal('');
  const reference = createMemo(
    () => results().find((result) => comparisonKey(result) === referenceKey()) ?? results()[0],
  );
  const candidates = createMemo(() => {
    const pinned = reference();
    return pinned
      ? results().filter((result) => comparisonKey(result) !== comparisonKey(pinned))
      : [];
  });
  const index = createMemo(() =>
    Math.max(
      0,
      candidates().findIndex((result) => comparisonKey(result) === candidateKey()),
    ),
  );
  const candidate = createMemo(() => candidates()[index()]);
  function navigate(direction: -1 | 1) {
    const next = candidates()[index() + direction];
    if (next) setCandidateKey(comparisonKey(next));
  }
  function pinCandidate() {
    const next = candidate();
    const old = reference();
    if (!next || !old) return;
    batch(() => {
      setReferenceKey(comparisonKey(next));
      setCandidateKey(comparisonKey(old));
    });
  }
  return { reference, candidate, candidates, index, navigate, pinCandidate };
}
