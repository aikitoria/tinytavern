import { onCleanup } from 'solid-js';

/** An async completion may update only the mounted target and draft it started with. */
export function createAsyncScope(snapshot: () => unknown) {
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  return () => {
    const initial = JSON.stringify(snapshot());
    return () => !disposed && JSON.stringify(snapshot()) === initial;
  };
}
