import { useDialogActive, useDialogPage } from './state/dialogContext.ts';
import { readPageLocation, writePageLocation } from './state/pageLocation.ts';
import { createEffect, createSignal, onMount, untrack } from 'solid-js';
import { useSettingsGuard, useSettingsNavigation } from './components/settings/SettingsGuard.tsx';
import { changedFields, sameValue } from './state/editorSync.ts';
import { confirmAction } from './state/confirm.ts';
import { createAsyncScope } from './state/asyncScope.ts';

export type EditorId<Id extends number | string = number> = Id | 'new' | 'default';
export type NoticeKind = 'error' | 'warning' | 'info' | 'success';

interface EntityEditorOptions<
  T extends { id: number | string },
  D extends Record<string, unknown>,
> {
  items: () => readonly T[];
  /** Settings relevant to remote-conflict detection, excluding cached metadata. */
  snapshot?: (item: T) => unknown;
  load: (item: T | undefined, importing?: boolean) => void;
  data: () => D;
  create: (data: D) => Promise<T>;
  patch: (id: T['id'], data: Partial<D>) => Promise<T>;
  remove: (id: T['id']) => Promise<void>;
  /** Server-side copy of the saved row (secrets and files included). */
  duplicate: (id: T['id']) => Promise<T>;
  deletePrompt: string;
  /** Select this saved item on mount when it exists. */
  initialId?: () => T['id'] | null;
  /** Editor shown when no saved item is selected or the selected item is deleted. */
  emptySelection?: 'new' | 'default';
  /** Selecting a saved row also selects it for use. `null` represents the
   * editor's virtual built-in/none row; new drafts activate after creation. */
  activate?: (id: T['id'] | null) => Promise<void>;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function numberOrNull(value: string): number | null {
  return value === '' ? null : Number(value);
}

/** Shared state/actions for the settings master-detail CRUD editors. */
export function createEntityEditor<
  T extends { id: number | string },
  D extends Record<string, unknown>,
>(options: EntityEditorOptions<T, D>) {
  type Id = EditorId<T['id']>;
  const initialPage = useDialogPage()();
  const paneActive = useDialogActive();
  const [locationReady, setLocationReady] = createSignal(false);
  const emptySelection = options.emptySelection ?? (options.activate ? 'default' : 'new');
  const [selectedId, setSelectedId] = createSignal<Id>('new');
  const [saved, flashSaved] = createSavedFlash();
  const [saving, setSaving] = createSignal(false);
  const [removingId, setRemovingId] = createSignal<Id | null>(null);
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
  let draftIdentity = 0;
  const identity = () => [selectedId(), draftIdentity];
  const capture = createAsyncScope(() => [identity(), options.data()]);
  const snapshot = (item: T | undefined) =>
    JSON.stringify(item == null ? null : options.snapshot ? options.snapshot(item) : item);

  const captureBaseline = () => {
    baseline = structuredClone(options.data());
  };
  const load = (item: T | undefined) => {
    draftIdentity++;
    options.load(item);
    captureBaseline();
    loadedItem = snapshot(item);
    remoteConflict = false;
  };

  const selected = () => options.items().find((item) => item.id === selectedId());
  const isDirty = () => baseline != null && !sameValue(options.data(), baseline);
  const activate = (id: Id) => {
    if (!options.activate || id === 'new') return;
    const sequence = ++activationSequence;
    void options.activate(id === 'default' ? null : id).catch((err) => {
      if (sequence === activationSequence) {
        setStatus(`Could not select for use: ${errorMessage(err)}`);
      }
    });
  };
  const applySelection = (id: Id, shouldActivate = true) => {
    rawNav.openDetail();
    setSelectedId(() => id);
    setStatus('');
    load(options.items().find((item) => item.id === id));
    if (shouldActivate) activate(id);
  };
  const select = (id: Id) => {
    if (id === selectedId()) {
      rawNav.openDetail();
      setStatus('');
      activate(id);
      return;
    }
    requestNavigation(() => applySelection(id));
  };
  const closeDetail = () => requestNavigation(rawNav.closeDetail);
  /** Imports and copies resolve unsaved edits before replacing the current draft. */
  const adopt = (item: T) => {
    requestNavigation(() => {
      rawNav.openDetail();
      setSelectedId(item.id);
      load(item);
      activate(item.id);
    });
  };
  // Wait for refs, then load without opening mobile detail. DOM defaults can
  // differ from load(undefined), especially for Select values.
  onMount(() => {
    if (selectedId() !== 'new') return;
    const initialId = initialPage.settingsEntity ?? options.initialId?.();
    const item =
      initialId != null
        ? options.items().find((candidate) => String(candidate.id) === String(initialId))
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
    const serialized = snapshot(item);
    // A settings update/socket invalidation can announce our own deletion before
    // its HTTP promise resolves. Let that operation complete its guarded selection.
    if (!item && removingId() === id) return;
    // The response reconciles updates observed during the request. Ending a save must
    // not reload an older cached DTO before its invalidation refetch arrives.
    if (untrack(saving)) return;
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
    if (saving()) return false;
    setSaving(true);
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
      const data = structuredClone(options.data());
      const selectedAtStart = snapshot(selected());
      const item =
        id === 'new'
          ? await options.create(data)
          : await options.patch(id, changedFields(baseline ?? data, data));
      const latest = id === 'new' ? undefined : selected();
      const response = snapshot(item);
      if (id !== 'new' && snapshot(latest) !== selectedAtStart && snapshot(latest) !== response) {
        remoteConflict = true;
        setStatus('This item changed elsewhere while saving. Discard to load it.', 'warning');
        return false;
      }
      const editedDuringSave = !sameValue(options.data(), data);
      setSelectedId(item.id);
      setStatus('');
      if (editedDuringSave) {
        // Keep later edits in the form, and only acknowledge the submitted snapshot.
        baseline = data;
        loadedItem = response;
        remoteConflict = false;
      } else {
        // Server-normalized values and secrets must become the new clean baseline.
        load(item);
      }
      if (id === 'new') activate(item.id);
      flashSaved();
      return !isDirty();
    } catch (err) {
      setStatus(errorMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  };
  // Duplication copies saved state, so resolve unsaved edits through the navigation guard.
  const duplicate = () => {
    const id = selectedId();
    if (id === 'new' || id === 'default') return;
    requestNavigation(() => {
      const current = capture();
      void (async () => {
        try {
          const item = await options.duplicate(id);
          if (!current()) return;
          adopt(item);
          flashSaved();
        } catch (err) {
          if (current()) setStatus(errorMessage(err));
        }
      })();
    });
  };
  const remove = async () => {
    if (removingId() !== null) return;
    const id = selectedId();
    const current = capture();
    if (
      id === 'new' ||
      id === 'default' ||
      !(await confirmAction({
        title: options.deletePrompt,
        message: 'This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    if (!current()) return;
    setRemovingId(() => id);
    try {
      await options.remove(id);
      if (!current()) return;
      applySelection(emptySelection, false);
      rawNav.closeDetail();
    } catch (err) {
      if (current()) setStatus(errorMessage(err));
    } finally {
      setRemovingId(null);
    }
  };
  const discard = () => {
    if (saving()) return;
    const id = selectedId();
    const item = options.items().find((candidate) => candidate.id === id);
    if (id !== 'new' && id !== 'default' && !item) {
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
    saving,
    save,
    discard,
  });

  return {
    selectedId,
    identity,
    capture,
    saving,
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
      options.load({ ...selected(), ...options.data(), ...data } as unknown as T, true);
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
