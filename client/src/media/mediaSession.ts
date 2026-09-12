import { batch, createEffect, createMemo, createSignal, on, onMount, onCleanup } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import {
  newRequestId,
  mediaJobActive,
  type MediaAsset,
  type MediaJob,
  type MediaJobDraft,
  type MediaJobInput,
  type MediaWorkflowValues,
} from '@tinytavern/shared';
import { mergeRemoteDraft, sameValue } from '../state/editorSync.ts';
import { api, ApiError } from '../state/api.ts';
import { state, applyMediaJob, mediaJobWasDeleted, handleServerEvent, galleryFoldersLoaded } from '../state/store.ts';
import { compareMediaJobs } from './jobCards.ts';
import { errorMessage } from '../util.ts';
import type { MediaToolSession } from './navigation.ts';

interface ToolDraft extends MediaJobDraft {
  workflowValues: MediaWorkflowValues;
  instruction: string;
  prompt: string;
  inputs: MediaJobInput[];
}

function draftFromJob(job: MediaJob): ToolDraft {
  return {
    seedOverride: job.seedOverride ?? null,
    avatarContext: job.avatarContext ?? null,
    workflowValues: { ...job.workflowValues },
    reviewBeforeSave: true,
    workflowId: job.workflowId,
    presetId: job.presetId,
    instruction: job.instruction,
    prompt: job.prompt,
    inputs: job.inputs.map(({ slot, assetId }) => ({ slot, assetId })),
    contextConversationId: job.contextConversationId,
    galleryFolderId: job.galleryFolderId ?? null,
    destination: job.destination,
  };
}

/** Own the working draft and accepted job lifecycle independently of preview selection. */
export function createMediaSession(
  session: MediaToolSession,
  options: {
    workflowId: () => string;
    presetId: () => string;
    workflowError: () => string;
    clearPreview: () => void;
  },
) {
  const createRequestKey = session.requestKey ?? newRequestId();
  const [jobId, setJobId] = createSignal(session.jobId);
  const [draftId, setDraftId] = createSignal<number | null>(null);
  const [variationsLoaded, setVariationsLoaded] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [assets, setAssets] = createStore<Record<number, MediaAsset>>(
    Object.fromEntries(session.assets.map((asset) => [asset.id, asset])),
  );
  const [draft, setDraft] = createStore<ToolDraft>({
    seedOverride: null,
    workflowValues: {},
    reviewBeforeSave: true,
    workflowId: session.workflowId,
    presetId: null,
    instruction: '',
    prompt: session.prompt ?? '',
    inputs: session.inputs,
    contextConversationId: session.contextConversationId,
    galleryFolderId: session.galleryFolderId ?? null,
    destination: session.destination,
  });
  let baseline = JSON.parse(JSON.stringify(draft)) as ToolDraft;
  let variationRequestKey = newRequestId();
  const job = () => (jobId() ? state.mediaJobs[jobId()!] : undefined);
  const variations = createMemo(() => {
    const current = job();
    const id = current?.draft?.id ?? draftId();
    if (!id) {
      return current ? [current] : [];
    }
    return Object.values(state.mediaJobs)
      .filter((item) => item.draft?.id === id)
      .sort(compareMediaJobs);
  });
  const review = createMemo(() => {
    let latest = job()?.draft;
    for (const item of variations()) {
      if (item.draft && (!latest || item.draft.revision > latest.revision)) {
        latest = item.draft;
      }
    }
    return latest;
  });
  const reviewing = () => review()?.state === 'open';
  const runningJob = () => variations().find((item) => mediaJobActive(item.state));
  const active = () => runningJob() !== undefined;
  const loadingJob = () => jobId() !== null && !job();
  const frozen = () => loadingJob() || (!reviewing() && (active() || job()?.submitted === true));
  const dirty = () => !sameValue(draft, baseline);
  // Read only the accepted store snapshot. A late HTTP response may already have
  // been superseded by a socket update or a deletion.
  const loadJob = (id: number, preserveEdits = false) => {
    const incoming = state.mediaJobs[id];
    if (!incoming) {
      return;
    }
    batch(() => {
      setDraftId(incoming.draft?.id ?? null);
      const next = draftFromJob(incoming);
      const values = preserveEdits ? mergeRemoteDraft({ ...baseline }, { ...draft }, { ...next }, true).draft : next;
      // A submitted variation owns its snapshot; edits here describe the next one.
      baseline = next;
      setDraft(values);
      setDraft('workflowValues', reconcile(values.workflowValues));
      for (const asset of incoming.assets) {
        setAssets(asset.id, asset);
      }
    });
  };
  let knownJobId: number | null = null;
  const recoverRemovedJob = (id: number) => {
    if (jobId() !== id || knownJobId !== id) {
      return;
    }
    const remaining = variations().at(-1);
    // Cancellation can delete the editor's anchor. Keep its working values while repointing it.
    if (remaining) baseline = draftFromJob(remaining);
    batch(() => {
      if (!remaining) {
        setDraftId(null);
        options.clearPreview();
      }
      setJobId(remaining?.id ?? null);
    });
  };
  createEffect(() => {
    const current = job();
    if (current) {
      knownJobId = current.id;
      setDraftId(current.draft?.id ?? null);
      return;
    }
    const id = jobId();
    if (id !== null && mediaJobWasDeleted(id)) recoverRemovedJob(id);
  });
  let refreshSequence = 0;
  onCleanup(() => {
    refreshSequence++;
  });
  const refreshVariations = async () => {
    const id = jobId();
    if (id === null) return;
    const sequence = ++refreshSequence;
    const isCurrent = () => jobId() === id && sequence === refreshSequence;
    let incoming: MediaJob[] = [];
    try {
      incoming = await api.mediaVariations(id, draftId());
    } catch (err) {
      if (!isCurrent()) return;
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    batch(() => {
      for (const item of incoming) applyMediaJob(item);
    });
    if (!isCurrent()) return;
    if (!incoming.some((item) => item.id === id)) {
      // A partial or stale history is not proof of deletion. Confirm only a missing anchor.
      try {
        applyMediaJob(await api.mediaJob(id));
      } catch (err) {
        if (!isCurrent()) return;
        if (err instanceof ApiError && err.status === 404 && knownJobId === id) {
          setVariationsLoaded(true);
          handleServerEvent({ t: 'mediaJobDeleted', id });
          recoverRemovedJob(id);
          return;
        }
        throw err;
      }
    }
    if (!isCurrent()) return;
    setVariationsLoaded(true);
    if (!busy()) loadJob(id, true);
  };
  const refreshOpenJob = () => {
    const id = jobId();
    if (id === null) return;
    if (job() && !busy()) loadJob(id, true);
    const refreshing = refreshVariations();
    const sequence = refreshSequence;
    void refreshing.catch((err: unknown) => {
      if (jobId() === id && sequence === refreshSequence) setError(errorMessage(err));
    });
  };
  onMount(refreshOpenJob);
  createEffect(
    on(
      () => state.connected,
      (connected) => {
        if (connected) refreshOpenJob();
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => [job()?.revision, job()?.prompt, busy()],
      () => {
        const incoming = job();
        if (incoming && !busy()) {
          loadJob(incoming.id, true);
        }
      },
    ),
  );

  const saveDraft = async (queue = false, prepare = false): Promise<MediaJob> => {
    const validationError = options.workflowError();
    if (validationError) {
      throw new Error(validationError);
    }
    const current = job();
    if (jobId() && !current) {
      throw new Error('The job is unavailable. Reopen it from the jobs list.');
    }
    const fork =
      current &&
      (current.submitted || mediaJobActive(current.state) || (queue && !['draft', 'ready'].includes(current.state)));
    if (current && ((!queue && frozen()) || (!fork && !dirty()))) {
      return current;
    }
    const values = JSON.parse(JSON.stringify(draft)) as ToolDraft;
    if (
      galleryFoldersLoaded() &&
      values.galleryFolderId != null &&
      !state.galleryFolders.some((folder) => folder.id === values.galleryFolderId)
    )
      values.galleryFolderId = null;
    if (prepare) values.prompt = '';
    values.workflowId = options.workflowId() || null;
    values.presetId = options.presetId() || null;
    const saved = fork
      ? await api.rerunMediaJob(current, variationRequestKey, values)
      : current
        ? await api.editMediaJob(current, values)
        : await api.createMediaJob(values, createRequestKey);
    variationRequestKey = newRequestId();
    batch(() => {
      applyMediaJob(saved);
      setJobId(saved.id);
      loadJob(saved.id);
    });
    const accepted = state.mediaJobs[saved.id];
    if (!accepted) {
      throw new Error('This job was deleted while saving.');
    }
    return accepted;
  };

  const perform = async (action: () => Promise<void>, recover?: () => void | Promise<unknown>) => {
    if (busy()) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
      await Promise.resolve(recover?.()).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return {
    draft,
    setDraft,
    assets,
    setAssets,
    jobId,
    setJobId,
    job,
    variations,
    review,
    reviewing,
    runningJob,
    active,
    loadingJob,
    frozen,
    variationsLoaded,
    busy,
    error,
    setError,
    dirty,
    loadJob,
    refreshVariations,
    saveDraft,
    perform,
  };
}
