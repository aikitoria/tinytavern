import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { createRoot, createSignal } from 'solid-js';
import type { MediaAsset, MediaJob } from '@tinytavern/shared';
import { comparisonKey, createMediaComparison, type ComparisonResult } from '../../client/src/media/mediaComparison.ts';
import { createComparisonPlayback, type ComparisonPlaybackState } from '../../client/src/media/comparisonPlayback.ts';

test('comparison pins an exact output while candidate navigation and deletion preserve distinct sides', () => {
  const result = (job: number, asset: number): ComparisonResult => ({
    job: { id: job, prompt: `Prompt ${job}` } as MediaJob,
    asset: { id: asset, kind: 'image' } as MediaAsset,
    variation: asset,
  });
  const a = result(1, 1);
  const b = result(1, 2);
  const c = result(2, 3);
  const [results, setResults] = createSignal([a, b, c]);
  createRoot((dispose) => {
    try {
      const comparison = createMediaComparison(results, comparisonKey(b));
      assert.strictEqual(comparison.reference(), b);
      assert.strictEqual(comparison.candidate(), a);
      comparison.navigate(1);
      assert.strictEqual(comparison.reference(), b);
      assert.strictEqual(comparison.candidate(), c);
      comparison.pinCandidate();
      assert.strictEqual(comparison.reference(), c);
      assert.strictEqual(comparison.candidate(), b);
      setResults([a, c]);
      assert.strictEqual(comparison.reference(), c);
      assert.strictEqual(comparison.candidate(), a);
      setResults([a, b]);
      assert.strictEqual(comparison.reference(), a);
      assert.strictEqual(comparison.candidate(), b);
      comparison.navigate(1);
      assert.strictEqual(comparison.candidate(), b, 'Navigation stays within completed alternatives');
      assert.equal(a.job.prompt, 'Prompt 1');
    } finally {
      dispose();
    }
  });
});

class Player extends EventTarget {
  currentTime = 0;
  readyState = 4;
  error = null;
  paused = true;
  starts = 0;
  pending: Promise<void> | undefined;
  duration: number;
  constructor(duration: number) {
    super();
    this.duration = duration;
  }
  play() {
    this.starts++;
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return this.pending ?? Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  emit(event: string) {
    this.dispatchEvent(new Event(event));
  }
}

test('video comparisons share seeking, correct drift, stop at the shorter clip and pause on buffering', async () => {
  let state!: ComparisonPlaybackState;
  const transport = createComparisonPlayback((next) => {
    state = next;
  });
  const left = new Player(8);
  const right = new Player(5);
  try {
    transport.setPlayer(0, left);
    transport.setPlayer(1, right);
    assert.equal(state.duration, 5);
    transport.seek(2);
    assert.equal(left.currentTime, 2);
    assert.equal(right.currentTime, 2);
    await transport.play();
    assert(!left.paused && !right.paused);
    left.currentTime = 3;
    left.emit('timeupdate');
    assert.equal(right.currentTime, 3);
    right.emit('waiting');
    assert(left.paused && right.paused);
    await transport.play();
    left.currentTime = 5.1;
    left.emit('timeupdate');
    assert(left.paused && right.paused);
    assert.equal(state.time, 5);
    await transport.play();
    assert.equal(left.currentTime, 0);
    assert.equal(right.currentTime, 0);
    const replacement = new Player(6);
    transport.setPlayer(1, replacement);
    assert(left.paused && right.paused);
    assert.equal(state.duration, 6);
    await transport.play();
    right.emit('ended');
    assert(state.playing, 'Removed players no longer control the comparison');
    transport.setActive(false);
    assert(left.paused && replacement.paused);
    await transport.play();
    assert(!state.playing, 'Hidden comparisons cannot start playback');
  } finally {
    transport.dispose();
  }
});

test('a rejected or late play cannot leave one comparison video playing alone', async () => {
  let state!: ComparisonPlaybackState;
  const transport = createComparisonPlayback((next) => {
    state = next;
  });
  const left = new Player(4);
  const right = new Player(4);
  try {
    transport.setPlayer(0, left);
    transport.setPlayer(1, right);
    right.pending = Promise.reject(new Error('Autoplay denied'));
    await transport.play();
    assert(left.paused && right.paused);
    assert(state.error);
    let finish!: () => void;
    right.pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const playing = transport.play();
    transport.pause();
    right.paused = false;
    right.emit('play');
    finish();
    await playing;
    assert(left.paused && right.paused);
    assert(!state.playing);
  } finally {
    transport.dispose();
  }
});
