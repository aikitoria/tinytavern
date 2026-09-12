interface Player extends EventTarget {
  currentTime: number;
  readonly duration: number;
  readonly readyState: number;
  readonly error: unknown;
  play(): Promise<void>;
  pause(): void;
}

export interface ComparisonPlaybackState {
  playing: boolean;
  ready: boolean;
  time: number;
  duration: number;
  error: string;
}

/** One shared timeline, bounded by the shorter clip. No polling while paused or hidden. */
export function createComparisonPlayback(changed: (state: ComparisonPlaybackState) => void) {
  const players: [Player | undefined, Player | undefined] = [undefined, undefined];
  const detach: [(() => void) | undefined, (() => void) | undefined] = [undefined, undefined];
  let playing = false;
  let active = true;
  let disposed = false;
  let token = 0;
  let time = 0;
  let error = '';
  const present = () => players.filter((player): player is Player => player !== undefined);
  const duration = () => {
    const current = present();
    return current.length && current.every((player) => Number.isFinite(player.duration) && player.duration > 0)
      ? Math.min(...current.map((player) => player.duration))
      : 0;
  };
  const ready = () => active && duration() > 0 && present().every((player) => player.readyState >= 2 && !player.error);
  const emit = () => {
    if (!disposed) changed({ playing, ready: ready(), time, duration: duration(), error });
  };
  function pause() {
    token++;
    const leader = players[0] ?? players[1];
    if (playing && leader) time = Math.min(leader.currentTime, duration());
    playing = false;
    for (const player of present()) player.pause();
    emit();
  }
  function seek(value: number) {
    if (!Number.isFinite(value)) return;
    time = Math.max(0, Math.min(value, duration()));
    for (const player of present()) {
      if (player.readyState >= 1 && Number.isFinite(player.duration)) player.currentTime = time;
    }
    emit();
  }
  async function play() {
    if (disposed || playing || !ready()) return;
    error = '';
    seek(time >= duration() ? 0 : time);
    const identity = ++token;
    playing = true;
    emit();
    try {
      await Promise.all(present().map((player) => player.play()));
    } catch {
      if (identity !== token || disposed) return;
      error = 'Playback could not start. Try Play again.';
      pause();
    }
  }
  function setPlayer(slot: 0 | 1, player: Player | undefined) {
    if (disposed || players[slot] === player) return;
    pause();
    detach[slot]?.();
    players[slot] = player;
    error = '';
    seek(0);
    if (!player) {
      detach[slot] = undefined;
      return;
    }
    const listeners: [string, EventListener][] = [
      [
        'loadedmetadata',
        () => {
          seek(0);
        },
      ],
      ['durationchange', emit],
      ['canplay', emit],
      [
        'timeupdate',
        () => {
          if (!playing || player !== (players[0] ?? players[1])) return;
          if (player.currentTime >= duration()) {
            pause();
            seek(duration());
            return;
          }
          time = player.currentTime;
          for (const other of present()) {
            if (other !== player && other.readyState >= 2 && Math.abs(other.currentTime - time) > 0.08)
              other.currentTime = time;
          }
          emit();
        },
      ],
      [
        'ended',
        () => {
          pause();
          seek(duration());
        },
      ],
      [
        'waiting',
        () => {
          if (playing) pause();
        },
      ],
      [
        'pause',
        () => {
          if (playing) pause();
        },
      ],
      // Late play promises and media-key events must not restart a paused/hidden pair.
      [
        'play',
        () => {
          if (!playing || !active) player.pause();
        },
      ],
      [
        'error',
        () => {
          error = 'A video could not be loaded.';
          pause();
        },
      ],
    ];
    for (const [event, listener] of listeners) player.addEventListener(event, listener);
    detach[slot] = () => {
      for (const [event, listener] of listeners) player.removeEventListener(event, listener);
    };
    emit();
  }
  return {
    setPlayer,
    play,
    pause,
    seek,
    setActive(value: boolean) {
      active = value;
      if (!active) pause();
      else emit();
    },
    dispose() {
      pause();
      disposed = true;
      for (const remove of detach) remove?.();
      players[0] = players[1] = undefined;
    },
  };
}
