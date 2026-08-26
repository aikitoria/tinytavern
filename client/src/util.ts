import { createEffect, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { useSettingsGuard, useSettingsNavigation } from './components/SettingsGuard.tsx';
import { changedFields, sameValue } from './state/editorSync.ts';
import { confirmAction } from './state/confirm.ts';

export type EditorId = number | 'new' | 'default';
export type NoticeKind = 'error' | 'warning' | 'info' | 'success';

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
  /** Initial selection for a freshly mounted editor (e.g. the tab's global
   * default): a valid id starts on that item instead of the blank "new" form. */
  initialId?: () => number | null;
  /** Selecting a saved row also selects it for use. `null` represents the
   * editor's virtual built-in/none row; new drafts activate after creation. */
  activate?: (id: number | null) => Promise<void>;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Popover dismiss wiring: close on click outside `root`/`additionalRoot` or on Escape.
 * Call from component setup — the document listeners live for the component's
 * lifetime and are cleaned up with it. */
export function useDismiss(
  root: () => HTMLElement | undefined,
  open: () => boolean,
  close: () => void,
  additionalRoot?: () => HTMLElement | undefined,
): void {
  const onDocClick = (event: MouseEvent) => {
    const el = root();
    const additional = additionalRoot?.();
    if (
      open() &&
      el &&
      !el.contains(event.target as Node) &&
      !additional?.contains(event.target as Node)
    )
      close();
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
  const [status, setStatusValue] = createSignal('');
  const [statusKind, setStatusKind] = createSignal<NoticeKind>('error');
  const setStatus = (message: string, kind: NoticeKind = 'error') => {
    setStatusValue(message);
    setStatusKind(kind);
  };
  const rawNav = createDetailNav();
  const requestNavigation = useSettingsNavigation();
  let baseline: D | null = null;
  let loadedItem = '';
  let remoteConflict = false;
  let activationSequence = 0;

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
  const activate = (id: EditorId) => {
    if (!options.activate || id === 'new') return;
    const sequence = ++activationSequence;
    void options.activate(id === 'default' ? null : id).catch((err) => {
      if (sequence === activationSequence) {
        setStatus(`Could not select for use: ${errorMessage(err)}`);
      }
    });
  };
  const applySelection = (id: EditorId, shouldActivate = true) => {
    rawNav.openDetail();
    setSelectedId(id);
    setStatus('');
    load(options.items().find((item) => item.id === id));
    if (shouldActivate) activate(id);
  };
  const select = (id: EditorId) => {
    if (id === selectedId()) {
      rawNav.openDetail();
      setStatus('');
      activate(id);
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
    activate(item.id);
  };
  // Seed the initial form once the refs exist: the configured default entity
  // when one resolves (selected directly, without opening the mobile detail
  // view), else the built-in/none choice for activating editors or the "new"
  // form for ordinary editors. Raw DOM defaults diverge from load(undefined)
  // (e.g. a Select with no '' option stays '').
  onMount(() => {
    if (selectedId() !== 'new') return;
    const initialId = options.initialId?.();
    const item =
      initialId != null
        ? options.items().find((candidate) => candidate.id === initialId)
        : undefined;
    if (item) setSelectedId(item.id);
    else if (options.activate) setSelectedId('default');
    load(item);
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
          setStatus(
            'This item was deleted on another device. Discard this draft to continue.',
            'warning',
          );
        } else {
          applySelection(options.activate ? 'default' : 'new', false);
          rawNav.closeDetail();
          setStatus('This item was deleted on another device.', 'warning');
        }
      } else if (isDirty()) {
        remoteConflict = true;
        setStatus(
          'This item changed on another device. Discard to load the latest version.',
          'warning',
        );
      } else {
        load(item);
      }
    });
  });

  const save = async () => {
    try {
      const id = selectedId();
      if (id === 'default') return true;
      if (remoteConflict) {
        setStatus(
          'This item changed on another device. Discard to load it before saving.',
          'warning',
        );
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
        setStatus('A newer version arrived while saving; it has been loaded.', 'info');
        return false;
      }
      setSelectedId(item.id);
      setStatus('');
      // Reload the server's representation so normalized values (and secrets
      // such as an endpoint key) do not immediately look dirty after saving.
      load(item);
      if (id === 'new') activate(item.id);
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
    if (typeof id !== 'number') return;
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
    if (
      typeof id !== 'number' ||
      !(await confirmAction({
        title: options.deletePrompt,
        message: 'This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    try {
      await options.remove(id);
      applySelection(options.activate ? 'default' : 'new', false);
      rawNav.closeDetail();
    } catch (err) {
      setStatus(errorMessage(err));
    }
  };
  const discard = () => {
    const id = selectedId();
    const item = options.items().find((candidate) => candidate.id === id);
    if (typeof id === 'number' && !item) {
      applySelection(options.activate ? 'default' : 'new', false);
      rawNav.closeDetail();
      setStatus('This item was deleted on another device.', 'warning');
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
    statusKind,
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
