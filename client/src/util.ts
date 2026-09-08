import { useDialogActive, useDialogPage } from './state/dialogContext.ts';
import { readPageLocation, writePageLocation } from './state/pageLocation.ts';
import { createEffect, createSignal, onMount, untrack } from 'solid-js';
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
  /** Select this saved item on mount when it exists. */
  initialId?: () => number | null;
  /** Editor shown when no saved item is selected or the selected item is deleted. */
  emptySelection?: 'new' | 'default';
  /** Selecting a saved row also selects it for use. `null` represents the
   * editor's virtual built-in/none row; new drafts activate after creation. */
  activate?: (id: number | null) => Promise<void>;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function numberOrNull(value: string): number | null {
  return value === '' ? null : Number(value);
}

/** Shared state/actions for the settings master-detail CRUD editors. */
export function createEntityEditor<T extends { id: number }, D extends Record<string, unknown>>(
  options: EntityEditorOptions<T, D>,
) {
  const initialPage = useDialogPage()();
  const paneActive = useDialogActive();
  const [locationReady, setLocationReady] = createSignal(false);
  const emptySelection = options.emptySelection ?? (options.activate ? 'default' : 'new');
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
  /** Load an item before its invalidate refetch reaches items(). */
  const adopt = (item: T) => {
    rawNav.openDetail();
    setSelectedId(item.id);
    load(item);
    activate(item.id);
  };
  // Wait for refs, then load without opening mobile detail. DOM defaults can
  // differ from load(undefined), especially for Select values.
  onMount(() => {
    if (selectedId() !== 'new') return;
    const initialId =
      typeof initialPage.settingsEntity === 'number'
        ? initialPage.settingsEntity
        : initialPage.settingsEntity === undefined
          ? options.initialId?.()
          : undefined;
    const item =
      initialId != null
        ? options.items().find((candidate) => candidate.id === initialId)
        : undefined;
    if (item) setSelectedId(item.id);
    else
      setSelectedId(
        initialPage.settingsEntity === 'new' || initialPage.settingsEntity === 'default'
          ? initialPage.settingsEntity
          : emptySelection,
      );
    load(item);
    if (initialPage.settingsDetail) rawNav.openDetail();
    setLocationReady(true);
  });
  createEffect(() => {
    if (!locationReady() || !paneActive()) return;
    const entity = selectedId();
    const detail = rawNav.detailOpen();
    const page = readPageLocation();
    if (page.modal === 'settings') {
      writePageLocation({ ...page, settingsEntity: entity, settingsDetail: detail });
    }
  });

  // Refetches reconcile DTOs in place; preserve dirty forms when their baseline changes.
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
          applySelection(emptySelection, false);
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
      // Server-normalized values and secrets must become the new clean baseline.
      load(item);
      if (id === 'new') activate(item.id);
      flashSaved();
      return true;
    } catch (err) {
      setStatus(errorMessage(err));
      return false;
    }
  };
  // Duplication copies saved state, so resolve unsaved edits through the navigation guard.
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
      applySelection(emptySelection, false);
      rawNav.closeDetail();
    } catch (err) {
      setStatus(errorMessage(err));
    }
  };
  const discard = () => {
    const id = selectedId();
    const item = options.items().find((candidate) => candidate.id === id);
    if (typeof id === 'number' && !item) {
      applySelection(emptySelection, false);
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
    draftData: () => ({ ...selected(), ...options.data() }),
    importData: (data: Record<string, unknown>, asNew = false) => {
      if (asNew || selectedId() === 'default') applySelection('new', false);
      options.load({ ...selected(), ...options.data(), ...data } as unknown as T);
      rawNav.openDetail();
      setStatus('Imported into this draft. Save to apply.', 'info');
    },
  };
}

/** Mobile list/detail paging; desktop shows both. */
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

export function download(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}
