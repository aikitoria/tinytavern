import { createEffect, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { useSettingsGuard, useSettingsNavigation } from './components/SettingsGuard.tsx';
import { changedFields, sameValue } from './state/editorSync.ts';

export type EditorId = number | 'new';

interface EntityEditorOptions<T extends { id: number }, D extends Record<string, unknown>> {
  items: () => readonly T[];
  load: (item: T | undefined) => void;
  data: () => D;
  create: (data: D) => Promise<T>;
  patch: (id: number, data: Partial<D>) => Promise<T>;
  remove: (id: number) => Promise<void>;
  /** Server-side copy of the saved row (secrets and files included). */
  duplicate: (id: number) => Promise<T>;
  deletePrompt: string;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Popover dismiss wiring: close on click outside `root` or on Escape.
 * Call from component setup — the document listeners live for the component's
 * lifetime and are cleaned up with it. */
export function useDismiss(
  root: () => HTMLElement | undefined,
  open: () => boolean,
  close: () => void,
): void {
  const onDocClick = (event: MouseEvent) => {
    const el = root();
    if (open() && el && !el.contains(event.target as Node)) close();
  };
  const onDocKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };
  onMount(() => {
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKey);
  });
  onCleanup(() => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onDocKey);
  });
}

export function numberOrNull(value: string): number | null {
  return value === '' ? null : Number(value);
}

/** Shared state/actions for the settings master-detail CRUD editors. */
export function createEntityEditor<T extends { id: number }, D extends Record<string, unknown>>(
  options: EntityEditorOptions<T, D>,
) {
  const [selectedId, setSelectedId] = createSignal<EditorId>('new');
  const [saved, flashSaved] = createSavedFlash();
  const [status, setStatus] = createSignal('');
  const rawNav = createDetailNav();
  const requestNavigation = useSettingsNavigation();
  let baseline: D | null = null;
  let loadedItem = '';
  let remoteConflict = false;

  const captureBaseline = () => {
    baseline = structuredClone(options.data());
  };
  const load = (item: T | undefined) => {
    options.load(item);
    captureBaseline();
    loadedItem = JSON.stringify(item ?? null);
    remoteConflict = false;
  };

  const selected = () => options.items().find((item) => item.id === selectedId());
  const isDirty = () => baseline != null && !sameValue(options.data(), baseline);
  const applySelection = (id: EditorId) => {
    rawNav.openDetail();
    setSelectedId(id);
    setStatus('');
    load(options.items().find((item) => item.id === id));
  };
  const select = (id: EditorId) => {
    if (id === selectedId()) {
      rawNav.openDetail();
      return;
    }
    requestNavigation(() => applySelection(id));
  };
  const closeDetail = () => requestNavigation(rawNav.closeDetail);
  /** Select-and-load an item that may not be in items() yet (e.g. a fresh
   * import whose WS invalidate refetch hasn't landed). */
  const adopt = (item: T) => {
    rawNav.openDetail();
    setSelectedId(item.id);
    load(item);
  };
  // Seed the initial "new entity" form once the refs exist: raw DOM defaults
  // diverge from load(undefined) (e.g. a Select with no '' option stays '').
  onMount(() => {
    if (selectedId() === 'new') load(undefined);
  });

  // Invalidation refetches reconcile the selected DTO in-place. Keep a clean
  // form current; preserve a dirty form and require an explicit reload when a
  // peer changed its server baseline.
  createEffect(() => {
    const id = selectedId();
    if (id === 'new') return;
    const item = selected();
    const serialized = JSON.stringify(item ?? null);
    untrack(() => {
      if (serialized === loadedItem) return;
      if (!item) {
        if (isDirty()) {
          remoteConflict = true;
          setStatus('This item was deleted on another device. Discard this draft to continue.');
        } else {
          applySelection('new');
          rawNav.closeDetail();
          setStatus('This item was deleted on another device.');
        }
      } else if (isDirty()) {
        remoteConflict = true;
        setStatus('This item changed on another device. Discard to load the latest version.');
      } else {
        load(item);
      }
    });
  });

  const save = async () => {
    try {
      const id = selectedId();
      if (remoteConflict) {
        setStatus('This item changed on another device. Discard to load it before saving.');
        return false;
      }
      const data = options.data();
      const selectedAtStart = JSON.stringify(selected() ?? null);
      const item =
        id === 'new'
          ? await options.create(data)
          : await options.patch(id, changedFields(baseline ?? data, data));
      const latest = id === 'new' ? undefined : selected();
      const response = JSON.stringify(item);
      if (
        latest &&
        JSON.stringify(latest) !== selectedAtStart &&
        JSON.stringify(latest) !== response
      ) {
        load(latest);
        setStatus('A newer version arrived while saving; it has been loaded.');
        return false;
      }
      setSelectedId(item.id);
      setStatus('');
      // Reload the server's representation so normalized values (and secrets
      // such as an endpoint key) do not immediately look dirty after saving.
      load(item);
      flashSaved();
      return true;
    } catch (err) {
      setStatus(errorMessage(err));
      return false;
    }
  };
  // Copies the saved server state, so unsaved edits first go through the
  // navigation guard (save/discard prompt) like any selection change.
  const duplicate = () => {
    const id = selectedId();
    if (id === 'new') return;
    requestNavigation(() => {
      void (async () => {
        try {
          adopt(await options.duplicate(id));
          flashSaved();
        } catch (err) {
          setStatus(errorMessage(err));
        }
      })();
    });
  };
  const remove = async () => {
    const id = selectedId();
    if (id === 'new' || !confirm(options.deletePrompt)) return;
    try {
      await options.remove(id);
      applySelection('new');
      rawNav.closeDetail();
    } catch (err) {
      setStatus(errorMessage(err));
    }
  };
  const discard = () => {
    const id = selectedId();
    const item = options.items().find((candidate) => candidate.id === id);
    if (id !== 'new' && !item) {
      applySelection('new');
      rawNav.closeDetail();
      setStatus('This item was deleted on another device.');
    } else {
      setStatus('');
      load(item);
    }
  };

  useSettingsGuard({
    isDirty,
    save,
    discard,
  });

  return {
    selectedId,
    saved,
    status,
    setStatus,
    nav: { detailOpen: rawNav.detailOpen, openDetail: rawNav.openDetail, closeDetail },
    selected,
    select,
    adopt,
    save,
    discard,
    remove,
    duplicate,
    flashSaved,
  };
}

/** Mobile master-detail paging: list page ⇄ detail page (desktop shows both, ignores this). */
export function createDetailNav() {
  const [detailOpen, setDetailOpen] = createSignal(false);
  return {
    detailOpen,
    openDetail: () => setDetailOpen(true),
    closeDetail: () => setDetailOpen(false),
  };
}

/** Transient "✓ Saved" indicator: returns [visible, trigger]. */
export function createSavedFlash(): [() => boolean, () => void] {
  const [on, setOn] = createSignal(false);
  let timer: number | undefined;
  return [
    on,
    () => {
      setOn(true);
      clearTimeout(timer);
      timer = window.setTimeout(() => setOn(false), 1500);
    },
  ];
}

/** Triggers a browser download of a server URL (content-disposition attachment). */
export function download(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}
