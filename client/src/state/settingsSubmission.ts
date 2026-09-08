import { createEffect, createSignal, untrack } from 'solid-js';

export interface SettingsSectionActions {
  isDirty: () => boolean;
  /** A page's Save button may have started a submission before navigation was requested. */
  saving?: () => boolean;
  /** Returns false when validation or persistence failed. */
  save: () => Promise<boolean>;
  discard: () => void;
}

/** Submission mechanics shared by settings pages; drafts and validation stay with each editor. */
export function createSettingsSubmission<D, S extends { revision: number }>(options: {
  revision: () => number;
  isDirty: () => boolean;
  snapshot: () => D;
  submit: (draft: D, revision: number) => Promise<S>;
  accepted: (draft: D, settings: S) => void;
  discard: () => void;
  onError: (message: string) => void;
}) {
  const [saving, setSaving] = createSignal(false);
  let revision = options.revision();
  const discard = () => {
    if (saving()) return;
    options.discard();
    revision = options.revision();
    options.onError('');
  };
  createEffect(() => {
    void options.revision();
    // An invalidation can overtake the save response. Recheck clean drafts when that save ends.
    if (!saving() && !untrack(options.isDirty)) untrack(discard);
  });
  return {
    saving,
    isDirty: options.isDirty,
    discard,
    async save(): Promise<boolean> {
      if (saving()) return false;
      if (!options.isDirty()) return true;
      setSaving(true);
      options.onError('');
      try {
        const draft = options.snapshot();
        const settings = await options.submit(draft, revision);
        revision = settings.revision;
        options.accepted(draft, settings);
        // A navigation guard may leave only after edits made during the request are saved too.
        return !options.isDirty();
      } catch (error) {
        options.onError(
          error instanceof Error && 'status' in error && error.status === 409
            ? 'Settings changed elsewhere. Discard to load them, then review your changes.'
            : error instanceof Error
              ? error.message
              : String(error),
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
  };
}

/** One guard owns the mounted editor and a single deferred navigation. */
export function createSettingsNavigation() {
  const [promptOpen, setPromptOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  let activeActions: SettingsSectionActions | undefined;
  let pendingNavigation: (() => void) | undefined;
  const isSaving = () => saving() || activeActions?.saving?.() === true;

  const cancel = () => {
    pendingNavigation = undefined;
    setPromptOpen(false);
  };
  const finish = () => {
    const action = pendingNavigation;
    cancel();
    action?.();
  };
  return {
    promptOpen,
    saving: isSaving,
    register(actions: SettingsSectionActions) {
      activeActions = actions;
      return () => {
        if (activeActions === actions) activeActions = undefined;
      };
    },
    navigate(action: () => void) {
      if (!isSaving() && !activeActions?.isDirty()) action();
      else {
        pendingNavigation = action;
        setPromptOpen(true);
      }
    },
    cancel,
    async save() {
      if (!activeActions || isSaving()) return;
      const actions = activeActions;
      const navigation = pendingNavigation;
      setSaving(true);
      try {
        const saved = await actions.save();
        // A closed prompt or replacement editor must not complete an old save.
        if (actions !== activeActions || navigation !== pendingNavigation) return;
        if (saved) finish();
        else cancel();
      } finally {
        setSaving(false);
      }
    },
    discard() {
      if (isSaving()) return;
      activeActions?.discard();
      finish();
    },
  };
}
