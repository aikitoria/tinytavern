import { entityOptions, editReferencedEntity } from '../state/entityReferences.ts';
import { newRequestId } from '@tinytavern/shared';
import { canFillMediaInputs } from './automaticInputs.ts';
import { orderedMediaInputs, reconcileMediaInputSelection } from './inputSelection.ts';
import { mergeRemoteDraft } from '../state/editorSync.ts';
import MediaResultDetails from './MediaResultDetails.tsx';
import { resultWorkflowDetails } from './resultWorkflowDetails.ts';
import { createStreamScroll } from '../streamScroll.ts';
import { prepareTextareaResize } from '../textareaResize.ts';
import { useDialogActive, useDialogNavigationGuard } from '../state/dialogContext.ts';
import { rememberMediaPage } from '../state/pageLocation.ts';
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onMount,
  onCleanup,
} from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import {
  faArrowLeft,
  faArrowUp,
  faArrowDown,
  faImage,
  faDownload,
  faExpand,
  faCircleInfo,
  faChevronLeft,
  faChevronRight,
  faRotateRight,
} from '@fortawesome/free-solid-svg-icons';
import {
  compileMediaWorkflow,
  mediaInputLabel,
  mediaJobActive,
  mediaPromptSettingsKey,
  workflowInputError,
  type MediaWorkflowValues,
  type GalleryItem,
  type MediaAsset,
  type MediaJob,
  type MediaJobDraft,
  type MediaJobInput,
} from '@tinytavern/shared';
import Modal from '../components/ui/Modal.tsx';
import ImageViewer from '../components/ui/ImageViewer.tsx';
import Select from '../components/ui/Select.tsx';
import FontAwesomeIcon from '../components/ui/FontAwesomeIcon.tsx';
import PromptGenerationStatus from './PromptGenerationStatus.tsx';
import GalleryModal from '../components/gallery/GalleryModal.tsx';
import MediaJobStatus from './MediaJobStatus.tsx';
import { api, ApiError } from '../state/api.ts';
import {
  applyMediaJob,
  handleServerEvent,
  mediaJobWasDeleted,
  state,
  toast,
} from '../state/store.ts';
import { download, errorMessage } from '../util.ts';
import { leaveMediaTool, openMediaJobs, type MediaToolSession } from './navigation.ts';
import MediaPlayer from './MediaPlayer.tsx';
import VideoFullscreenButton from './VideoFullscreenButton.tsx';
import VideoPreview from './VideoPreview.tsx';
import MediaActions from './MediaActions.tsx';
import WorkflowInputs from './WorkflowInputs.tsx';
import {
  createMediaWorkflowControls,
  imageWorkflowDefaults,
  mediaWorkflowView,
} from './workflowDefaults.ts';
import {
  groupMediaJobs,
  mediaVariations,
  mediaVariationIndex,
  MEDIA_JOB_STATUS as STATUS_LABELS,
} from './jobCards.ts';

const selectRowClass =
  'items-center grid min-w-0 gap-y-2 gap-x-3 [&>label]:text-sm [&>label]:font-semibold [&>label]:text-foreground [&>label]:m-0 [&>*]:min-w-0 narrow-panel:grid-cols-1 narrow-panel:gap-1 grid-cols-[minmax(0,_42%)_minmax(0,_1fr)]';

interface ToolDraft extends MediaJobDraft {
  workflowValues: MediaWorkflowValues;
  instruction: string;
  prompt: string;
  inputs: MediaJobInput[];
}

function draftFromJob(job: MediaJob): ToolDraft {
  return {
    avatarContext: job.avatarContext ?? null,
    workflowValues: { ...job.workflowValues },
    reviewBeforeSave: true,
    workflowId: job.workflowId,
    presetId: job.presetId,
    instruction: job.instruction,
    prompt: job.prompt,
    inputs: job.inputs.map(({ slot, assetId }) => ({ slot, assetId })),
    contextConversationId: job.contextConversationId,
    destination: job.destination,
  };
}

export default function MediaToolsModal(props: { session: MediaToolSession }) {
  let videoPlayer: HTMLVideoElement | undefined;
  let promptArea: HTMLTextAreaElement | undefined;
  const session = props.session;
  const createRequestKey = session.requestKey ?? newRequestId();
  const [jobId, setJobId] = createSignal(session.jobId);
  const [draftId, setDraftId] = createSignal<number | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const paneActive = useDialogActive();
  const [fullSizeImage, setFullSizeImage] = createSignal<string | null>(null);
  const [picker, setPicker] = createSignal<MediaJobInput['slot'] | '@all' | null>(null);
  const [assets, setAssets] = createStore<Record<number, MediaAsset>>(
    Object.fromEntries(session.assets.map((asset) => [asset.id, asset])),
  );
  const [draft, setDraft] = createStore<ToolDraft>({
    workflowValues: {},
    reviewBeforeSave: true,
    workflowId: session.workflowId,
    presetId: null,
    instruction: '',
    prompt: session.prompt ?? '',
    inputs: session.inputs,
    contextConversationId: session.contextConversationId,
    destination: session.destination,
  });
  let baseline = JSON.parse(JSON.stringify(draft)) as ToolDraft;
  let baselineJson = JSON.stringify(baseline);
  let variationRequestKey = newRequestId();
  createEffect(() => {
    if (!paneActive()) return;
    const selected = selectedVariation();
    rememberMediaPage({
      workflowId: draft.workflowId ?? null,
      jobId: selected?.job.id ?? jobId(),
      assetId:
        selected?.job.outputs.length === 1
          ? undefined
          : (selected?.asset?.id ?? (loadingJob() ? session.assetId : undefined)),
      contextConversationId: draft.contextConversationId ?? null,
    });
  });
  const contextConversation = createMemo(() =>
    state.conversations.find((conversation) => conversation.id === draft.contextConversationId),
  );
  const chatTitle = () => contextConversation()?.title ?? 'Linked chat';
  const usesChatContext = () => draft.contextConversationId !== null;
  const inputContext = () =>
    draft.avatarContext ? 'avatar' : usesChatContext() ? 'chat' : 'standalone';
  const job = () => (jobId() ? state.mediaJobs[jobId()!] : undefined);
  const variations = createMemo(() => {
    const current = job();
    const id = current?.draft?.id ?? draftId();
    if (!id) return current ? [current] : [];
    return Object.values(state.mediaJobs)
      .filter((item) => item.draft?.id === id)
      .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
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
  const preview = () =>
    selectedVariation()?.asset ? undefined : selectedVariation()?.job.progress?.preview;
  const videoPreview = () => {
    const video = selectedVariation()?.asset
      ? undefined
      : selectedVariation()?.job.progress?.videoPreview;
    return video && Object.values(video.frames).some(Boolean) ? video : undefined;
  };
  const candidates = createMemo(() => mediaVariations(variations()));
  const completedCount = () =>
    candidates().filter((item) => item.asset || item.job.textResult).length;
  const pendingCount = () => variations().filter((item) => mediaJobActive(item.state)).length;
  const queuedCount = () =>
    variations().filter((item) =>
      ['preparing', 'submitting', 'reconciling', 'queued'].includes(item.state),
    ).length;
  const [resultDetails, setResultDetails] = createSignal<{
    instruction: string;
    prompt: string;
    variation: number;
    workflow: ReturnType<typeof resultWorkflowDetails>;
  } | null>(null);
  const [viewedVariation, setViewedVariation] = createSignal<{
    jobId: number;
    assetId?: number;
  } | null>(session.jobId === null ? null : { jobId: session.jobId, assetId: session.assetId });
  const selectedIndex = () =>
    mediaVariationIndex(candidates(), viewedVariation(), review()?.selectedAssetId);
  const selectedVariation = () => candidates()[selectedIndex()];
  const cancelTarget = () => {
    const selected = selectedVariation()?.job;
    return selected && mediaJobActive(selected.state) ? selected : runningJob();
  };
  const selected = createMemo(
    () => {
      const item = selectedVariation();
      return item?.asset ? { job: item.job, asset: item.asset } : undefined;
    },
    undefined,
    { equals: (a, b) => a?.job === b?.job && a?.asset === b?.asset },
  );
  const hasResults = () =>
    Boolean(videoPreview() || preview() || selected() || selectedVariation()?.job.textResult);
  const sourcePreviewLabel = () => inputLabel(orderedInputs()[0]?.slot ?? 'source');
  const sourcePreview = () =>
    orderedInputs()[0] ? assets[orderedInputs()[0]!.assetId] : session.assets[0];
  const title = () =>
    loadingJob()
      ? 'Loading media job…'
      : usesChatContext()
        ? 'Generate media from chat'
        : 'Generate media';
  const workflows = createMemo(() => {
    const snapshot = job()?.workflowSnapshot;
    const saved = state.settings.mediaRendering.workflows;
    return snapshot
      ? [...saved.filter((workflow) => workflow.id !== snapshot.id), snapshot]
      : saved;
  });
  const workflowView = createMemo(() =>
    mediaWorkflowView(
      job(),
      draft.workflowId ?? state.settings.mediaRendering.defaultWorkflowId ?? '',
      workflows(),
      draft.workflowValues,
      frozen(),
    ),
  );
  const workflowOptions = createMemo(() => {
    const editable = new Set(
      state.settings.mediaRendering.workflows.map((workflow) => workflow.id),
    );
    return entityOptions('workflows', workflows()).map((option) =>
      editable.has(option.value) ? option : { ...option, edit: undefined },
    );
  });
  const selectedWorkflow = () => workflowView().id;
  const workflowControls = createMediaWorkflowControls(() => workflowView().workflow?.json);
  const workflowInterface = createMemo(() => {
    try {
      const json = workflowView().workflow?.json;
      return json?.trim() ? compileMediaWorkflow(json) : null;
    } catch {
      return null;
    }
  });
  const slots = () => workflowInterface()?.imageInputs.map((input) => input.name) ?? [];
  const orderedInputs = createMemo(() => orderedMediaInputs(slots(), draft.inputs));
  const selectableAssetIds = createMemo(
    () =>
      new Set(
        state.gallery.flatMap((item) => (item.media?.kind === 'image' ? [item.media.id] : [])),
      ),
  );
  const bulkInputCapacity = () =>
    slots().length -
    orderedInputs().filter((input) => !selectableAssetIds().has(input.assetId)).length;
  const canFillFromContext = createMemo(() => {
    const conversation = contextConversation();
    const personaId =
      draft.avatarContext?.kind === 'persona'
        ? draft.avatarContext.id
        : (conversation?.personaId ?? state.settings.defaultPersonaId);
    const characterId =
      draft.avatarContext?.kind === 'character'
        ? draft.avatarContext.id
        : conversation?.characterId;
    return canFillMediaInputs(
      slots(),
      workflowView().workflow?.inputBindings[inputContext()] ?? {},
      draft.inputs,
      {
        selectedAssets: session.assets,
        characterAvatar: Boolean(state.characters.find((item) => item.id === characterId)?.avatar),
        personaAvatar: Boolean(state.personas.find((item) => item.id === personaId)?.avatar),
      },
    );
  });
  const hasPrompt = () => workflowInterface()?.slots.has('prompt') ?? false;
  const inputLabel = (slot: string) =>
    workflowInterface()?.imageInputs.find((input) => input.name === slot)?.label ??
    mediaInputLabel(slot);
  const fillSelectedInputs = (inputs: MediaJobInput[], workflow = workflowView().workflow) => {
    if (!workflow) return inputs;
    const next = [...inputs];
    const bindings = workflow.inputBindings[inputContext()] ?? {};
    for (const [slot, source] of Object.entries(bindings)) {
      if (next.some((input) => input.slot === slot) || !source.startsWith('selected:')) continue;
      const asset = session.assets[Number(source.slice(9)) - 1];
      if (asset?.kind === 'image') next.push({ slot, assetId: asset.id });
    }
    return next;
  };
  createEffect(
    on(
      () => workflowView().id,
      () => {
        if (!jobId())
          setDraft(
            'inputs',
            fillSelectedInputs(draft.inputs.filter((input) => slots().includes(input.slot))),
          );
      },
    ),
  );
  const workflowError = createMemo(() => {
    if (workflowControls().error) return workflowControls().error;
    for (const control of workflowControls().controls) {
      const error = workflowInputError(
        control,
        workflowView().values[control.key] ?? control.value,
      );
      if (error) return error;
    }
    return '';
  });
  createEffect(
    on(workflowControls, ({ controls }) => {
      if (jobId()) return;
      const image = session.assets[0];
      if (!image || !draft.inputs.some((input) => input.assetId === image.id)) return;
      const defaults = imageWorkflowDefaults(controls, image);
      for (const [key, value] of Object.entries(defaults)) {
        if (draft.workflowValues[key] === undefined) setDraft('workflowValues', key, value);
      }
    }),
  );
  const resetWorkflowValues = () => setDraft('workflowValues', reconcile({}));
  const mediaPrompts = () => state.settings[mediaPromptSettingsKey(usesChatContext())];
  const selectedPromptId = () => draft.presetId ?? '';
  const updateInstruction = (instruction: string) => setDraft('instruction', instruction);
  const defaultPromptId = createMemo(() => {
    const workflow = workflowView().workflow;
    return (
      (usesChatContext() ? workflow?.chatPromptPresetId : workflow?.standalonePromptPresetId) ??
      mediaPrompts().defaultPresetId
    );
  });
  const defaultPromptLabel = createMemo(() => {
    const id = defaultPromptId();
    return id
      ? (mediaPrompts().presets.find((item) => item.id === id)?.name ?? 'Preset unavailable')
      : 'Built-in prompt';
  });
  const promptOptions = () => [
    {
      value: '',
      label: 'Workflow default',
      edit: () =>
        editReferencedEntity(
          mediaPromptSettingsKey(usesChatContext()),
          defaultPromptId() ?? 'default',
        ),
    },
    ...entityOptions(mediaPromptSettingsKey(usesChatContext()), mediaPrompts().presets),
  ];
  const preparingPrompt = () => job()?.state === 'preparing' && draft.prompt === baseline.prompt;
  const currentPrompt = () => draft.prompt;
  const thinking = () => preparingPrompt() && !currentPrompt();
  const promptScroll = createStreamScroll(
    () => promptArea,
    requestAnimationFrame,
    cancelAnimationFrame,
  );
  createEffect(() => {
    currentPrompt();
    promptScroll.update(
      preparingPrompt() ? job()!.id : null,
      paneActive() && picker() === null && !thinking(),
    );
  });
  onCleanup(promptScroll.dispose);
  const dirty = () => JSON.stringify(draft) !== baselineJson;
  const inputForSlot = (slot: MediaJobInput['slot']) =>
    draft.inputs.find((input) => input.slot === slot);

  // Read only the accepted store snapshot. A late HTTP response may already have
  // been superseded by a socket update or a deletion.
  const loadJob = (id: number, preserveEdits = false) => {
    const incoming = state.mediaJobs[id];
    if (!incoming) return;
    batch(() => {
      setDraftId(incoming.draft?.id ?? null);
      const next = draftFromJob(incoming);
      const values = preserveEdits
        ? mergeRemoteDraft({ ...baseline }, { ...draft }, { ...next }, true).draft
        : next;
      // A submitted variation owns its snapshot; edits here describe the next one.
      baseline = next;
      baselineJson = JSON.stringify(next);
      setDraft(values);
      setDraft('workflowValues', reconcile(values.workflowValues));
      for (const asset of incoming.assets) {
        setAssets(asset.id, asset);
      }
    });
  };
  let knownJobId: number | null = null;
  const recoverRemovedJob = (id: number) => {
    if (jobId() !== id || knownJobId !== id) return;
    const remaining = variations().at(-1);
    // Cancellation can delete the editor's anchor. Keep its working values while repointing it.
    if (remaining) baseline = draftFromJob(remaining);
    baselineJson = remaining ? JSON.stringify(baseline) : '';
    batch(() => {
      if (!remaining) {
        setDraftId(null);
        setViewedVariation(null);
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
  const jobRefreshError = async (id: number, err: unknown) => {
    if (jobId() !== id) return;
    if (err instanceof ApiError && err.status === 404 && knownJobId === id) {
      try {
        // The deleted anchor may have been the only cached job when the socket disconnected.
        await refreshVariations();
      } catch (refreshError) {
        if (jobId() === id) setError(errorMessage(refreshError));
        return;
      }
      if (jobId() !== id) return;
      handleServerEvent({ t: 'mediaJobDeleted', id });
      recoverRemovedJob(id);
    } else {
      setError(errorMessage(err));
    }
  };
  const refreshVariations = async () => {
    if (!jobId()) {
      return;
    }
    const incoming = await api.mediaVariations(jobId()!, draftId());
    for (const item of incoming) {
      applyMediaJob(item);
    }
  };
  const refreshOpenJob = () => {
    const id = jobId();
    if (id) {
      void refreshVariations().catch((err: unknown) => jobRefreshError(id, err));
      const existing = state.mediaJobs[id];
      if (existing && !busy()) {
        loadJob(id, true);
      }
      void api
        .mediaJob(id)
        .then((incoming) => {
          applyMediaJob(incoming);
          if (jobId() === id && !busy()) {
            loadJob(id, true);
          }
        })
        .catch((err: unknown) => jobRefreshError(id, err));
    }
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

  const saveDraft = async (queue = false): Promise<MediaJob> => {
    if (workflowError()) throw new Error(workflowError());
    const current = job();
    if (jobId() && !current) {
      throw new Error('The job is unavailable. Reopen it from the jobs list.');
    }
    const fork =
      current &&
      (current.submitted ||
        mediaJobActive(current.state) ||
        (queue && !['draft', 'ready'].includes(current.state)));
    if (current && ((!queue && frozen()) || (!fork && !dirty()))) {
      return current;
    }
    const values = JSON.parse(JSON.stringify(draft)) as ToolDraft;
    values.workflowId = selectedWorkflow() || null;
    values.presetId = selectedPromptId() || null;
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
    if (!accepted) throw new Error('This job was deleted while saving.');
    return accepted;
  };

  const perform = async (action: () => Promise<void>, recover?: () => void | Promise<unknown>) => {
    if (busy()) return;
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

  const run = (action: 'prepare' | 'render' | 'cancel' | 'retry-retrieval', autoRender = false) =>
    perform(
      async () => {
        const current =
          action === 'cancel'
            ? cancelTarget()!
            : action === 'retry-retrieval'
              ? job()!
              : await saveDraft(action === 'render' && reviewing());
        const conversation =
          current.contextConversationId === state.tree.conversationId
            ? state.tree
            : state.conversations.find((item) => item.id === current.contextConversationId);
        if (action === 'render' || action === 'prepare') {
          setViewedVariation({ jobId: current.id });
        }
        const result = await api.mediaJobAction(current, action, {
          autoRender,
          expectedActiveLeafId: conversation?.activeLeafId,
          expectedMutationRevision: conversation?.mutationRevision,
        });
        applyMediaJob(result);
        if (action !== 'cancel') {
          loadJob(result.id);
        }
      },
      () => {
        if (jobId())
          void api
            .mediaJob(jobId()!)
            .then(applyMediaJob)
            .catch(() => {});
      },
    );

  const saveOnLeave = async () => {
    if (!jobId()) return;
    const current = job();
    if (!current) return;
    if (current.startedAt === null && current.state === 'draft') {
      await refreshVariations();
      const related = variations();
      if (related.every((item) => item.startedAt === null && item.state === 'draft')) {
        if (current.draft?.state === 'open') {
          await api.discardMediaDraft(current, review()!.revision, true);
        } else {
          await api.deleteMediaJob(current);
        }
        for (const item of related) {
          handleServerEvent({ t: 'mediaJobDeleted', id: item.id });
        }
        return;
      }
    }
    if (dirty() && !frozen()) await saveDraft();
  };

  useDialogNavigationGuard((action) => {
    if (busy()) return;
    void saveOnLeave()
      .then(action)
      .catch((err) => {
        setError(errorMessage(err));
        if (!paneActive()) toast(errorMessage(err));
      });
  });

  const back = () =>
    perform(async () => {
      await saveOnLeave();
      leaveMediaTool();
    });

  const fillFromContext = () =>
    canFillFromContext() &&
    !frozen() &&
    perform(async () => {
      const current = await saveDraft();
      const filled = await api.editMediaJob(current, {
        fillInputs: {
          selectedAssetIds: session.assets.map((asset) => asset.id),
          avatar: draft.avatarContext ?? undefined,
        },
      });
      applyMediaJob(filled);
      loadJob(filled.id);
    });
  createEffect(
    on(
      () => workflowView().id,
      (id) => {
        if (!canFillFromContext()) return;
        if (jobId() || frozen()) return;
        queueMicrotask(() => {
          if (selectedWorkflow() === id && !busy()) void fillFromContext();
        });
      },
    ),
  );
  const chooseWorkflow = (value: string) => {
    const workflow = workflows().find((item) => item.id === value);
    let allowed: string[] = [];
    try {
      allowed = workflow
        ? compileMediaWorkflow(workflow.json).imageInputs.map((input) => input.name)
        : [];
    } catch {
      /* The workflow error is displayed by its editor. */
    }
    batch(() => {
      resetWorkflowValues();
      setDraft({
        workflowId: value || null,
        presetId: null,
        inputs: fillSelectedInputs(
          draft.inputs.filter((input) => allowed.includes(input.slot)),
          workflow,
        ),
      });
    });
    if (workflow && canFillFromContext() && jobId()) void fillFromContext();
  };
  const selectReferences = (items: GalleryItem[]) => {
    const destination = picker();
    if (destination === null) return;
    for (const item of items) {
      setAssets(item.media!.id, item.media!);
    }
    setDraft(
      'inputs',
      destination === '@all'
        ? reconcileMediaInputSelection(
            slots(),
            draft.inputs,
            items.map((item) => item.media!.id),
            selectableAssetIds(),
          )
        : [
            ...draft.inputs.filter((input) => input.slot !== destination),
            ...items.slice(0, 1).map((item) => ({ slot: destination, assetId: item.media!.id })),
          ],
    );
    setPicker(null);
  };
  const moveReference = (slot: MediaJobInput['slot'], direction: -1 | 1) => {
    const otherSlot = slots()[slots().indexOf(slot) + direction];
    if (!otherSlot) return;
    setDraft(
      'inputs',
      draft.inputs.map((input) => {
        if (input.slot === slot) {
          return { ...input, slot: otherSlot };
        }
        if (input.slot === otherSlot) {
          return { ...input, slot };
        }
        return input;
      }),
    );
  };
  const rerun = () => {
    if (!job()) return;
    return perform(async () => {
      const next = await api.rerunMediaJob(job()!, newRequestId(), { reviewBeforeSave: true });
      applyMediaJob(next);
      setJobId(next.id);
      loadJob(next.id);
    });
  };
  const jobGroups = createMemo(() => groupMediaJobs(Object.values(state.mediaJobs)));
  const chooseCandidate = (index: number) => {
    const candidate = candidates()[index];
    if (!candidate || busy()) {
      return;
    }
    // Preview selection is navigation, retained in the URL without locking the editor.
    setViewedVariation({ jobId: candidate.job.id, assetId: candidate.asset?.id });
  };
  const savedAssetIds = () => review()?.savedAssetIds ?? [];
  const acceptableVariation = () => {
    const variation = selectedVariation();
    return variation?.job.state === 'succeeded' &&
      (variation.asset ||
        (variation.job.textResult !== null && variation.job.destination === 'chat'))
      ? variation
      : undefined;
  };
  const selectedSaved = () => {
    const variation = acceptableVariation();
    return variation
      ? variation.asset
        ? savedAssetIds().includes(variation.asset.id)
        : variation.job.messageId !== null
      : false;
  };
  const hasSavedResults = () =>
    savedAssetIds().length > 0 ||
    variations().some((item) => item.textResult !== null && item.messageId !== null);
  const copyResultText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      toast(errorMessage(err));
    }
  };
  const accept = async () => {
    const variation = acceptableVariation();
    if (!variation || selectedSaved() || !reviewing() || busy()) {
      return;
    }
    await perform(async () => {
      const conversation =
        variation.job.contextConversationId === state.tree.conversationId
          ? state.tree
          : state.conversations.find((item) => item.id === variation.job.contextConversationId);
      if (variation.job.destination === 'chat' && !conversation) {
        throw new Error('The destination conversation is unavailable.');
      }
      applyMediaJob(
        await api.acceptMediaVariation(
          variation.job,
          variation.asset?.id ?? null,
          review()!.revision,
          conversation ?? state.tree,
        ),
      );
    }, refreshVariations);
  };
  const discard = () => {
    if (!reviewing()) return;
    return perform(async () => {
      await api.discardMediaDraft(job()!, review()!.revision);
      leaveMediaTool();
    }, refreshVariations);
  };

  const runningCount = () => jobGroups().filter((group) => mediaJobActive(group.job.state)).length;

  return (
    <>
      <Modal
        title={title()}
        fullscreen
        hideCloseButton
        class="media-tools-modal"
        onClose={() => void back()}
        headerStart={
          <button
            class="page-back icon-btn flex-none border-transparent bg-clear"
            aria-label="Back"
            title="Back"
            onClick={() => void back()}
            disabled={busy()}
          >
            <FontAwesomeIcon icon={faArrowLeft} size={13} />
          </button>
        }
        headerExtra={
          <div class="flex items-center justify-end flex-1 min-w-0 gap-2 [&>button]:inline-flex [&>button]:items-center [&>button]:justify-center [&>button]:gap-1 [&>button]:min-h-control [&>button]:h-control">
            <button onClick={openMediaJobs} disabled={busy()}>
              Jobs{runningCount() ? ` (${runningCount()})` : ''}
            </button>
          </div>
        }
      >
        <div class="media-workspace flex flex-col flex-1 min-h-0 overflow-hidden mobile:overflow-visible [&>.notice]:m-4">
          <Show when={error()}>
            <p class="notice notice-error" role="alert">
              {error()}
            </p>
          </Show>
          <div class="gallery-detail min-w-0 min-h-0 flex flex-1 media-tool-layout mobile:flex-col mobile:overflow-visible">
            <section
              class="gallery-detail-stage items-center flex flex-col min-w-0 min-h-0 flex-1 justify-center relative overflow-hidden gap-gallery-image p-gallery-image mobile:flex-none mobile:min-h-55 mobile:h-[calc(100dvh_-_60px)]"
              aria-label="Media preview"
            >
              <Show when={selectedVariation()?.job.textResult}>
                {(text) => (
                  <div class="form-stack w-full min-h-0 overflow-auto">
                    <pre class="whitespace-pre-wrap">{text()}</pre>
                    <button onClick={() => void copyResultText(text())}>Copy text</button>
                    <button onClick={() => setDraft('prompt', text())}>Use as prompt</button>
                  </div>
                )}
              </Show>
              <div class="media-preview-content grid place-items-center flex-1 min-h-0 overflow-hidden w-full">
                <Show
                  when={hasResults()}
                  fallback={
                    <Show
                      when={selectedVariation() ? undefined : sourcePreview()}
                      fallback={
                        <div class="m-auto p-4 text-center">
                          <h3>Media preview</h3>
                          <p class="hint">
                            {selectedVariation()
                              ? STATUS_LABELS[selectedVariation()!.job.state]
                              : 'Your result will appear here.'}
                          </p>
                        </div>
                      }
                    >
                      {(asset) => (
                        <img
                          class="media-result block object-contain w-full max-h-[100cqh]"
                          src={asset().url}
                          alt={sourcePreviewLabel()}
                        />
                      )}
                    </Show>
                  }
                >
                  <Show
                    when={videoPreview() || preview()}
                    fallback={
                      <Show when={selected()} keyed>
                        {(candidate) => (
                          <Show
                            when={candidate.asset.kind === 'video'}
                            fallback={
                              <button
                                type="button"
                                class="grid place-items-center w-full min-h-0 overflow-hidden p-0 border-0 rounded-none bg-clear cursor-zoom-in [&:hover:not(:disabled)]:bg-clear"
                                aria-label="Open full-size image; zoom and pan"
                                onClick={() => setFullSizeImage(candidate.asset.url)}
                              >
                                <img
                                  class="media-result block object-contain w-full max-h-[100cqh]"
                                  src={candidate.asset.url}
                                  alt="Generated image"
                                />
                              </button>
                            }
                          >
                            <MediaPlayer
                              ref={(player) => {
                                videoPlayer = player;
                              }}
                              asset={candidate.asset}
                              class="media-result block object-contain w-full max-h-[100cqh]"
                              active={paneActive() && picker() === null}
                              autoPlay
                              loop
                            />
                          </Show>
                        )}
                      </Show>
                    }
                  >
                    <Show
                      when={videoPreview()}
                      fallback={
                        <img
                          class="media-result block object-contain w-full max-h-[100cqh]"
                          src={preview()}
                          alt="Generation preview"
                        />
                      }
                    >
                      {(video) => (
                        <VideoPreview
                          preview={video()}
                          active={paneActive() && picker() === null}
                        />
                      )}
                    </Show>
                  </Show>
                </Show>
              </div>
              <Show when={selectedVariation() || (!hasResults() && sourcePreview())}>
                <div class="flex flex-col items-center flex-none gap-2 w-full">
                  <Show when={!selectedVariation() && !hasResults() && sourcePreview()}>
                    <span class="hint">{sourcePreviewLabel()}</span>
                  </Show>
                  <Show when={!videoPreview() && !preview() && selected()}>
                    {(candidate) => (
                      <div class="flex flex-wrap justify-center gap-2 flex-none p-0 [&_button]:inline-flex [&_button]:items-center [&_button]:justify-center [&_button]:gap-1 [&_button]:h-control [&_button]:py-1 [&_button]:px-2 [&_button]:text-dim [&_button]:bg-clear [&_button]:border-transparent [&_button]:text-xs">
                        <button
                          type="button"
                          onClick={() =>
                            setResultDetails({
                              instruction: candidate().job.instruction,
                              prompt: candidate().job.prompt,
                              variation: selectedIndex() + 1,
                              workflow: resultWorkflowDetails(candidate().job),
                            })
                          }
                        >
                          <FontAwesomeIcon icon={faCircleInfo} size={14} /> Result details
                        </button>
                        <button type="button" onClick={() => download(candidate().asset.url)}>
                          <FontAwesomeIcon icon={faDownload} size={14} /> Download
                        </button>
                        <MediaActions
                          asset={candidate().asset}
                          conversationId={candidate().job.contextConversationId}
                        />
                        <Show when={candidate().asset.kind === 'video'}>
                          <VideoFullscreenButton
                            asset={candidate().asset}
                            player={() => videoPlayer}
                          />
                        </Show>
                        <Show when={candidate().asset.kind === 'image'}>
                          <button
                            type="button"
                            title="Open full-size image"
                            aria-label="Open full-size image"
                            onClick={() => setFullSizeImage(candidate().asset.url)}
                          >
                            <FontAwesomeIcon icon={faExpand} size={14} />{' '}
                            <Show
                              when={candidate().asset.width && candidate().asset.height}
                              fallback="Full size"
                            >
                              {candidate().asset.width} × {candidate().asset.height}
                            </Show>
                          </button>
                        </Show>
                      </div>
                    )}
                  </Show>
                  <Show when={candidates().length > 0}>
                    <div
                      class="whitespace-nowrap flex items-center gap-1 justify-center text-xs text-dim"
                      aria-label="Variations"
                    >
                      <button
                        class="icon-btn"
                        aria-label="Previous variation"
                        disabled={busy() || selectedIndex() <= 0}
                        onClick={() => chooseCandidate(selectedIndex() - 1)}
                      >
                        <FontAwesomeIcon icon={faChevronLeft} size={14} />
                      </button>
                      <span class="text-center tabular-nums" aria-live="polite">
                        Variation {selectedIndex() + 1} / {candidates().length}
                      </span>
                      <button
                        class="icon-btn"
                        aria-label="Next variation"
                        disabled={busy() || selectedIndex() >= candidates().length - 1}
                        onClick={() => chooseCandidate(selectedIndex() + 1)}
                      >
                        <FontAwesomeIcon icon={faChevronRight} size={14} />
                      </button>
                    </div>
                  </Show>
                </div>
              </Show>
            </section>
            <aside
              class="detail-panel media-tool-form flex flex-col gap-4 flex-none min-h-0 p-4 overflow-y-auto bg-panel border-l border-l-solid border-l-subtle [&>*]:shrink-0 [&_textarea]:block [&_textarea]:w-full [&_textarea]:min-h-20 [&_textarea]:resize-y [&_.hint]:m-0 [&_.hint]:text-xs [&_.notice]:m-0 [&_.notice]:text-xs mobile:w-full mobile:overflow-visible [&.media-tool-form]:gap-0 [&.media-tool-form]:min-w-0 [&.media-tool-form]:p-0 [&.media-tool-form]:overflow-hidden mobile:[&.media-tool-form]:overflow-visible [&>.media-tool-fields]:flex [&>.media-tool-fields]:flex-col [&>.media-tool-fields]:min-h-0 [&>.media-tool-fields]:gap-2 [&>.media-tool-fields]:p-3 [&>.media-tool-fields]:overflow-y-auto [&>.media-tool-fields]:flex-auto [&_.field-group]:p-2 [&_.field-group_label]:text-sm [&_.field-group_label]:font-semibold [&_.field-group_label]:mt-2 [&_.field-group_label]:text-foreground [&_.workflow-inputs_label]:m-0 [&_.key-row]:flex-wrap [&_[role=status]]:m-0 mobile:[&>.media-tool-fields]:flex-none mobile:[&>.media-tool-fields]:overflow-visible w-[var(--detail-panel-width,_450px)]"
              aria-label="Media controls"
            >
              <div class="media-tool-fields [&>*]:shrink-0 [&>textarea]:min-h-16 [&>#media-prompt]:shrink-0 [&>#media-prompt]:min-h-45 [&>#media-prompt]:flex-auto [&>.media-prompt-thinking]:shrink-0 [&>.media-prompt-thinking]:min-h-45 [&>.media-prompt-thinking]:flex-auto [&>label]:text-sm [&>label]:font-semibold [&>label]:mt-2 [&>label]:text-foreground mobile:[&>#media-prompt]:flex-none mobile:[&>.media-prompt-thinking]:flex-none">
                <dl
                  class="grid m-0 text-sm gap-y-1 gap-x-3 [&_dt]:text-dim [&_dd]:m-0 [&_dd]:wrap-anywhere grid-cols-[auto_minmax(0,_1fr)_auto_auto]"
                  aria-label="Context and destination"
                >
                  <dt>Context</dt>
                  <dd>
                    {draft.avatarContext
                      ? 'Avatar'
                      : usesChatContext()
                        ? `Chat: ${chatTitle()}`
                        : 'Standalone'}
                  </dd>
                  <dt>Destination</dt>
                  <dd>
                    {draft.destination === 'chat'
                      ? 'This chat'
                      : workflowView().workflow?.textOutputNodeId != null
                        ? 'Text result'
                        : 'Gallery'}
                  </dd>
                </dl>
                <div class="form-stack">
                  <div class={selectRowClass}>
                    <label>Workflow</label>
                    <Select
                      ariaLabel="Saved media workflow"
                      value={selectedWorkflow()}
                      buttonLabel={selectedWorkflow() ? undefined : 'Choose a workflow'}
                      disabled={busy() || frozen() || workflows().length === 0}
                      options={workflowOptions()}
                      onChange={chooseWorkflow}
                    />
                  </div>
                  <Show when={canFillFromContext()}>
                    <button disabled={busy() || frozen()} onClick={() => void fillFromContext()}>
                      Fill from context
                    </button>
                  </Show>
                  <Show when={slots().length > 1 && bulkInputCapacity() > 0}>
                    <button disabled={busy() || frozen()} onClick={() => setPicker('@all')}>
                      Choose input images
                    </button>
                  </Show>
                </div>
                <For each={slots()}>
                  {(slot) => (
                    <div
                      class="flex items-center gap-3 field-group [&_.key-row]:flex-wrap"
                      role="group"
                      aria-labelledby={`media-input-${slot}`}
                    >
                      <div class="h-12 border border-solid border-line bg-canvas grid place-items-center overflow-hidden text-dim rounded-sm grow-0 shrink-0 basis-12 [&_img]:min-h-0 [&_img]:object-contain [&_img]:size-full">
                        <Show
                          when={inputForSlot(slot)}
                          fallback={<FontAwesomeIcon icon={faImage} size={24} />}
                        >
                          {(input) => (
                            <img
                              src={
                                assets[input().assetId]?.thumbnail ?? assets[input().assetId]?.url
                              }
                              alt={inputLabel(slot)}
                              decoding="async"
                            />
                          )}
                        </Show>
                      </div>
                      <div class="form-stack flex-row items-center flex-1 min-w-0 flex-wrap [&_.media-reference-label]:mr-auto">
                        <span
                          class="media-reference-label m-0 text-sm font-semibold text-foreground"
                          id={`media-input-${slot}`}
                        >
                          {mediaInputLabel(slot)}
                          {inputLabel(slot) !== mediaInputLabel(slot)
                            ? ` · ${inputLabel(slot)}`
                            : ''}
                        </span>
                        <div class="key-row flex items-center gap-2 [&_input]:flex-1 [&_input]:min-w-0 [&_.select-control]:flex-1 [&_.select-control]:min-w-0 [&>button:not(.select-btn)]:whitespace-nowrap [&>button:not(.select-btn)]:shrink-0">
                          <button disabled={busy() || frozen()} onClick={() => setPicker(slot)}>
                            {inputForSlot(slot) ? 'Replace' : 'Choose image'}
                          </button>
                          <Show when={inputForSlot(slot)}>
                            <button
                              disabled={busy() || frozen()}
                              onClick={() =>
                                setDraft(
                                  'inputs',
                                  draft.inputs.filter((input) => input.slot !== slot),
                                )
                              }
                            >
                              Remove
                            </button>
                            <Show when={slots().length > 1}>
                              <button
                                class="icon-btn"
                                title={`Move ${inputLabel(slot).toLowerCase()} up`}
                                aria-label={`Move ${inputLabel(slot).toLowerCase()} up`}
                                disabled={busy() || frozen() || slots().indexOf(slot) === 0}
                                onClick={() => moveReference(slot, -1)}
                              >
                                <FontAwesomeIcon icon={faArrowUp} size={14} />
                              </button>
                              <button
                                class="icon-btn"
                                title={`Move ${inputLabel(slot).toLowerCase()} down`}
                                aria-label={`Move ${inputLabel(slot).toLowerCase()} down`}
                                disabled={
                                  busy() || frozen() || slots().indexOf(slot) >= slots().length - 1
                                }
                                onClick={() => moveReference(slot, 1)}
                              >
                                <FontAwesomeIcon icon={faArrowDown} size={14} />
                              </button>
                            </Show>
                          </Show>
                        </div>
                      </div>
                    </div>
                  )}
                </For>
                <Show when={workflowControls().controls.length > 0}>
                  <div
                    class="items-start grid gap-2 field-group [&_.setting-label]:m-0 [&_.setting-label]:min-h-6 [&_.workflow-input>label]:min-h-6"
                    role="group"
                    aria-label="Workflow inputs"
                  >
                    <WorkflowInputs
                      controls={workflowControls().controls}
                      values={workflowView().values}
                      disabled={busy() || frozen()}
                      onChange={(key, value) => setDraft('workflowValues', key, value)}
                    />
                  </div>
                </Show>
                <Show when={workflowError()}>
                  <p class="notice notice-error" role="alert">
                    {workflowError()}
                  </p>
                </Show>
                <Show when={workflows().length === 0}>
                  <p class="hint">Add a workflow in Settings → Media rendering.</p>
                </Show>
                <Show when={hasPrompt()}>
                  <Show when={!draft.avatarContext}>
                    <div class={selectRowClass}>
                      <label>Prompt preset</label>
                      <Select
                        ariaLabel="Media prompt preset"
                        value={selectedPromptId()}
                        buttonLabel={
                          draft.presetId ? undefined : `Default: ${defaultPromptLabel()}`
                        }
                        disabled={busy() || frozen()}
                        options={promptOptions()}
                        onChange={(value) => setDraft('presetId', value || null)}
                      />
                    </div>
                  </Show>
                  <div class="mt-1 flex items-center flex-wrap justify-between gap-y-1 gap-x-2 [&>label]:m-0 [&>label]:text-sm [&>label]:font-semibold">
                    <label for="media-instruction">Instruction</label>
                    <div class="key-row flex items-center gap-2 [&_input]:flex-1 [&_input]:min-w-0 [&_.select-control]:flex-1 [&_.select-control]:min-w-0 [&>button:not(.select-btn)]:whitespace-nowrap [&>button:not(.select-btn)]:shrink-0">
                      <button
                        disabled={
                          busy() || frozen() || !selectedWorkflow() || Boolean(workflowError())
                        }
                        title={
                          usesChatContext()
                            ? 'Prepare a prompt from this chat’s active branch and your instruction'
                            : 'Prepare a prompt from your instruction'
                        }
                        onClick={() => void run('prepare')}
                      >
                        Prepare prompt
                      </button>
                      <button
                        disabled={
                          busy() || frozen() || !selectedWorkflow() || Boolean(workflowError())
                        }
                        title="Prepare a new prompt from your instruction, then render it"
                        onClick={() => void run('prepare', true)}
                      >
                        Prepare and render
                      </button>
                    </div>
                  </div>
                  <textarea
                    id="media-instruction"
                    rows={3}
                    value={draft.instruction}
                    readOnly={busy() || frozen()}
                    onInput={(event) => updateInstruction(event.currentTarget.value)}
                  />
                  <div class="flex items-center gap-2 flex-wrap justify-between mt-2 [&_label]:text-sm [&_label]:font-semibold [&_label]:text-foreground [&_label]:m-0">
                    <label for={thinking() ? undefined : 'media-prompt'}>Final prompt</label>
                    <Show when={preparingPrompt()}>
                      <PromptGenerationStatus active={paneActive()} content={currentPrompt()} />
                    </Show>
                  </div>
                  <Show
                    when={thinking()}
                    fallback={
                      <textarea
                        id="media-prompt"
                        onPointerDown={prepareTextareaResize}
                        ref={promptArea}
                        onScroll={promptScroll.onScroll}
                        rows={8}
                        value={currentPrompt()}
                        readOnly={busy() || frozen()}
                        onInput={(event) => setDraft('prompt', event.currentTarget.value)}
                      />
                    }
                  >
                    <div class="media-prompt-thinking p-3 border border-solid border-control-line bg-thinking flex rounded-sm [&_.prompt-generation-status]:flex-1 [&_.prompt-generation-status]:min-h-0 [&_.prompt-generation-reasoning]:flex-1 [&_.prompt-generation-reasoning]:min-h-0 [&_.prompt-generation-reasoning]:max-h-none [&_.prompt-generation-reasoning]:p-0 [&_.prompt-generation-reasoning]:border-clear [&_.prompt-generation-reasoning]:bg-clear h-[11rem]">
                      <PromptGenerationStatus
                        active={paneActive()}
                        content=""
                        showStatus={false}
                        reasoning={job()?.reasoning}
                      />
                    </div>
                  </Show>
                </Show>
              </div>
              <div class="py-2 px-3 border-t border-t-solid border-t-subtle flex flex-col flex-none gap-2 bg-panel mobile:sticky mobile:bottom-0 mobile:z-2 mobile:pb-[max(var(--space-2),_env(safe-area-inset-bottom))]">
                <Show when={candidates().length > 0}>
                  <p class="text-xs text-dim m-0" aria-label="Variation queue" role="status">
                    {completedCount()} / {candidates().length} variations complete
                    <Show when={queuedCount()}> · {queuedCount()} queued</Show>
                    <Show when={pendingCount() > queuedCount()}>
                      {' '}
                      · {pendingCount() - queuedCount()} running
                    </Show>
                  </p>
                </Show>
                <Show when={selectedVariation()?.job ?? runningJob() ?? job()}>
                  {(current) => (
                    <Show when={current().state !== 'draft' || current().error}>
                      <div class="form-stack media-rendering leading-4 gap-1">
                        <Show when={current().state !== 'draft'}>
                          <MediaJobStatus job={current()} />
                        </Show>
                        <Show
                          when={
                            current().state === 'succeeded' &&
                            current().outputs.length === 0 &&
                            !current().textResult
                          }
                        >
                          <p class="hint">
                            The saved results have been removed. You can still rerun this job.
                          </p>
                        </Show>
                        <Show when={current().error}>
                          <p class="notice notice-error">{current().error}</p>
                        </Show>
                      </div>
                    </Show>
                  )}
                </Show>
                <div class="media-tool-actions grid grid-flow-col auto-cols-fr items-center min-w-0 gap-2 [&>button]:inline-flex [&>button]:items-center [&>button]:justify-center [&>button]:gap-1 [&>button]:h-control [&>button]:py-0 [&>button]:px-2 [&>button]:min-w-0 [&>button]:whitespace-nowrap">
                  <Show when={!frozen() || (reviewing() && !loadingJob())}>
                    <button
                      class="primary-btn"
                      title={
                        reviewing() && candidates().length > 0
                          ? 'Queue another variation'
                          : 'Render the final prompt shown above'
                      }
                      disabled={
                        busy() ||
                        (hasPrompt() && !draft.prompt.trim()) ||
                        !selectedWorkflow() ||
                        Boolean(workflowError())
                      }
                      onClick={() => void run('render')}
                    >
                      Generate
                    </button>
                  </Show>
                  <Show when={active()}>
                    <button
                      title="Cancel generation"
                      disabled={busy() || cancelTarget()?.state === 'cancelling'}
                      onClick={() => void run('cancel')}
                    >
                      Cancel
                    </button>
                  </Show>
                  <Show when={job()?.retrievalAvailable}>
                    <button
                      title="Retry download"
                      disabled={busy()}
                      onClick={() => void run('retry-retrieval')}
                    >
                      Retry
                    </button>
                  </Show>
                  <Show when={reviewing()}>
                    <Show
                      when={
                        selectedVariation()?.job.textResult == null ||
                        selectedVariation()?.job.destination === 'chat'
                      }
                    >
                      <button
                        title={draft.destination === 'chat' ? 'Add to chat' : 'Save to gallery'}
                        disabled={busy() || !acceptableVariation() || selectedSaved()}
                        onClick={() => void accept()}
                      >
                        {selectedSaved()
                          ? draft.destination === 'chat'
                            ? 'Added'
                            : 'Saved'
                          : draft.destination === 'chat'
                            ? 'Add'
                            : 'Save'}
                      </button>
                    </Show>
                    <button
                      title="Finish draft and discard unsaved variations"
                      disabled={busy()}
                      onClick={() => void discard()}
                    >
                      {hasSavedResults() ? 'Finish' : 'Discard'}
                    </button>
                  </Show>
                  <Show when={job()?.submitted && !active() && !reviewing()}>
                    <button disabled={busy()} onClick={() => void rerun()}>
                      <FontAwesomeIcon icon={faRotateRight} size={14} /> Rerun
                    </button>
                  </Show>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </Modal>
      <Show when={fullSizeImage()}>
        {(url) => <ImageViewer src={url()} onClose={() => setFullSizeImage(null)} />}
      </Show>
      <Show when={resultDetails()}>
        {(details) => (
          <MediaResultDetails
            instruction={details().instruction}
            prompt={details().prompt}
            variation={details().variation}
            workflow={details().workflow}
            disabled={busy() || frozen()}
            onCopy={(text) => void copyResultText(text)}
            onUseInstruction={() => {
              updateInstruction(details().instruction);
              setResultDetails(null);
            }}
            onUsePrompt={() => {
              setDraft('prompt', details().prompt);
              setResultDetails(null);
            }}
            onClose={() => setResultDetails(null)}
          />
        )}
      </Show>
      <Show when={picker()}>
        {(slot) => (
          <GalleryModal
            picker={{
              maximum: slot() === '@all' ? bulkInputCapacity() : 1,
              selectedAssetIds: orderedInputs()
                .filter((input) =>
                  slot() === '@all' ? slots().includes(input.slot) : input.slot === slot(),
                )
                .map((input) => input.assetId),
              onConfirm: selectReferences,
              onCancel: () => setPicker(null),
            }}
          />
        )}
      </Show>
    </>
  );
}
