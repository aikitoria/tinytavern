import { newRequestId } from '@tinytavern/shared';
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
  faCircleInfo,
  faChevronLeft,
  faChevronRight,
  faRotateRight,
  faCheck,
  faTrashCan,
} from '@fortawesome/free-solid-svg-icons';
import {
  MEDIA_OPERATIONS,
  chatImagePromptPresets,
  defaultChatImagePrompt,
  mediaInputSlots,
  mediaJobActive,
  mediaWorkflowKey,
  mediaPromptSettingsKey,
  operationHasReferences,
  compileMediaWorkflow,
  workflowInputError,
  type MediaWorkflowValues,
  type GalleryItem,
  type MediaAsset,
  type MediaJob,
  type MediaJobDraft,
  type MediaJobInput,
  type MediaOperation,
} from '@tinytavern/shared';
import Modal from '../components/Modal.tsx';
import Select from '../components/Select.tsx';
import FontAwesomeIcon from '../components/FontAwesomeIcon.tsx';
import PromptGenerationStatus from '../components/PromptGenerationStatus.tsx';
import GalleryModal from '../components/GalleryModal.tsx';
import SamplerProgress from '../images/SamplerProgress.tsx';
import { api } from '../state/api.ts';
import { applyMediaJob, handleServerEvent, state, toast } from '../state/store.ts';
import { download, errorMessage } from '../util.ts';
import { leaveMediaTool, openMediaJobs, type MediaToolSession } from './navigation.ts';
import MediaPlayer from './MediaPlayer.tsx';
import VideoFullscreenButton from './VideoFullscreenButton.tsx';
import VideoPreview from './VideoPreview.tsx';
import MediaActions from './MediaActions.tsx';
import WorkflowInputs from './WorkflowInputs.tsx';
import { imageWorkflowDefaults, mediaWorkflowView } from './workflowDefaults.ts';
import {
  groupMediaJobs,
  MEDIA_JOB_STATUS as STATUS_LABELS,
  MEDIA_INPUT_LABELS as INPUT_LABELS,
} from './jobCards.ts';
import './media.css';

interface ToolDraft extends MediaJobDraft {
  workflowValues: MediaWorkflowValues;
  instruction: string;
  prompt: string;
  inputs: MediaJobInput[];
}

function draftFromJob(job: MediaJob): ToolDraft {
  return {
    workflowValues: { ...job.workflowValues },
    reviewBeforeSave: true,
    operation: job.operation,
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
  const [jobId, setJobId] = createSignal(session.jobId);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const paneActive = useDialogActive();
  const [picker, setPicker] = createSignal<MediaJobInput['slot'] | 'references' | null>(null);
  const [referenceCount, setReferenceCount] = createSignal(
    operationHasReferences(session.operation) ? 1 : 0,
  );
  const [assets, setAssets] = createStore<Record<number, MediaAsset>>(
    Object.fromEntries(session.assets.map((asset) => [asset.id, asset])),
  );
  const [draft, setDraft] = createStore<ToolDraft>({
    workflowValues: {},
    reviewBeforeSave: true,
    operation: session.operation,
    workflowId: null,
    presetId: null,
    instruction: '',
    prompt: session.prompt ?? '',
    inputs: session.inputs,
    contextConversationId: session.contextConversationId,
    destination: session.destination,
  });
  let baseline = JSON.stringify(draft);
  let variationRequestKey = newRequestId();
  createEffect(() => {
    if (!paneActive()) return;
    rememberMediaPage({
      operation: draft.operation,
      jobId: jobId(),
      contextConversationId: draft.contextConversationId ?? null,
    });
  });
  const contextConversation = createMemo(() =>
    state.conversations.find((conversation) => conversation.id === draft.contextConversationId),
  );
  const chatTitle = () => contextConversation()?.title ?? 'Linked chat';
  const usesChatContext = () =>
    draft.contextConversationId !== null && draft.operation !== 'image-edit';
  const job = () => (jobId() ? state.mediaJobs[jobId()!] : undefined);
  const variations = createMemo(() => {
    const current = job();
    if (!current) {
      return [];
    }
    if (!current.draft) {
      return [current];
    }
    return Object.values(state.mediaJobs)
      .filter((item) => item.draft?.id === current.draft!.id)
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
  const frozen = () => loadingJob() || active() || (job()?.submitted === true && !reviewing());
  const [showLivePreview, setShowLivePreview] = createSignal(true);
  const preview = () => (showLivePreview() ? runningJob()?.progress?.preview : undefined);
  const videoPreview = () => {
    const video = showLivePreview() ? runningJob()?.progress?.videoPreview : undefined;
    return video && Object.values(video.frames).some(Boolean) ? video : undefined;
  };
  const candidates = createMemo(() =>
    variations().flatMap((item) =>
      item.state === 'succeeded' ? item.outputs.map((asset) => ({ asset, job: item })) : [],
    ),
  );
  const [resultDetails, setResultDetails] = createSignal<{
    instruction: string;
    prompt: string;
    variation: number;
    workflow: ReturnType<typeof resultWorkflowDetails>;
  } | null>(null);
  const [viewedAssetId, setViewedAssetId] = createSignal<number | null>(null);
  const selectedIndex = () => {
    const assetId = reviewing()
      ? review()?.selectedAssetId
      : (viewedAssetId() ?? review()?.selectedAssetId);
    const index = candidates().findIndex((item) => item.asset.id === assetId);
    return index < 0 ? candidates().length - 1 : index;
  };
  const selected = () => candidates()[selectedIndex()];
  const hasResults = () => Boolean(videoPreview() || preview() || selected());
  const sourcePreviewLabel = () =>
    draft.operation === 'video-first' ? 'First frame' : 'Reference 1';
  const sourcePreview = () => {
    const input = draft.inputs.find(
      (item) => item.slot === 'reference1' || item.slot === 'first_frame',
    );
    return input ? assets[input.assetId] : undefined;
  };
  const title = () =>
    loadingJob()
      ? 'Loading media job…'
      : draft.operation.startsWith('video')
        ? usesChatContext()
          ? 'Create video from chat'
          : 'Create video'
        : draft.operation === 'image'
          ? usesChatContext()
            ? 'Create image from chat'
            : 'Create image'
          : 'Edit image';
  const operationChoices = () =>
    MEDIA_OPERATIONS.filter((operation) => {
      const operationFamily = job()?.operation ?? session.operation;
      if (operationFamily.startsWith('video')) {
        return operation.kind === 'video';
      }
      return operationFamily === 'image' ? operation.id === 'image' : operation.id === 'image-edit';
    });
  const workflows = createMemo(() => {
    const locked = frozen() ? (runningJob() ?? job()) : undefined;
    const operation = locked?.operation ?? draft.operation;
    const count = locked?.workflowSnapshot?.referenceCount ?? referenceCount();
    const compatible = state.settings.mediaRendering.workflows.filter(
      (workflow) => workflow.operation === operation && workflow.referenceCount === count,
    );
    const snapshot = (locked ?? job())?.workflowSnapshot;
    if (snapshot && snapshot.operation === operation && snapshot.referenceCount === count) {
      return [...compatible.filter((workflow) => workflow.id !== snapshot.id), snapshot];
    }
    return compatible;
  });
  const slots = () => mediaInputSlots(draft.operation, referenceCount());
  const workflowView = createMemo(() =>
    mediaWorkflowView(
      runningJob() ?? job(),
      draft.workflowId ??
        state.settings.mediaRendering.defaults[
          mediaWorkflowKey(draft.operation, referenceCount())
        ] ??
        '',
      workflows(),
      draft.workflowValues,
      frozen(),
    ),
  );
  const selectedWorkflow = () => workflowView().id;
  const workflowControls = createMemo(() => {
    const workflow = workflowView().workflow;
    try {
      return {
        controls: workflow?.json ? compileMediaWorkflow(workflow.json).controls : [],
        error: '',
      };
    } catch (err) {
      return { controls: [], error: errorMessage(err) };
    }
  });
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
  const createsChatImage = () =>
    draft.operation === 'image' && draft.contextConversationId !== null;
  const hasInstruction = createMemo(() => Boolean(draft.instruction.trim()));
  const chatPresets = createMemo(() =>
    chatImagePromptPresets(state.settings.imageGeneration, hasInstruction()),
  );
  const mediaPrompts = () =>
    state.settings[mediaPromptSettingsKey(draft.operation, usesChatContext())];
  const selectedPromptId = createMemo(() => {
    if (createsChatImage()) {
      return (
        draft.presetId ??
        defaultChatImagePrompt(state.settings.imageGeneration, draft.instruction).id
      );
    }
    return draft.presetId ?? '';
  });
  const updateInstruction = (instruction: string) => {
    const previousPreset = createsChatImage()
      ? chatPresets().find((preset) => preset.id === selectedPromptId())
      : undefined;
    batch(() => {
      setDraft('instruction', instruction);
      if (previousPreset && !chatPresets().some((preset) => preset.id === previousPreset.id)) {
        const matchingPreset = chatPresets().find((preset) => preset.name === previousPreset.name);
        const nextPreset =
          matchingPreset ?? defaultChatImagePrompt(state.settings.imageGeneration, instruction);
        setDraft('presetId', nextPreset.id);
      }
    });
  };
  const defaultPromptLabel = createMemo(() => {
    const snapshot = job()?.workflowSnapshot;
    const workflow =
      snapshot?.id === selectedWorkflow()
        ? snapshot
        : workflows().find((item) => item.id === selectedWorkflow());
    const id =
      (usesChatContext() ? workflow?.chatPromptPresetId : workflow?.galleryPromptPresetId) ??
      mediaPrompts().defaults[draft.operation];
    if (!id) {
      return 'Built-in prompt';
    }
    return mediaPrompts().presets.find((item) => item.id === id)?.name ?? 'Preset unavailable';
  });
  const promptOptions = createMemo(() => {
    if (createsChatImage()) {
      return chatPresets().map((preset) => ({ value: preset.id, label: preset.name }));
    }
    return [
      { value: '', label: 'Default' },
      ...mediaPrompts()
        .presets.filter((preset) => preset.operation === draft.operation)
        .map((preset) => ({ value: preset.id, label: preset.name })),
    ];
  });
  const preparingPrompt = () => showLivePreview() && runningJob()?.state === 'preparing';
  const currentPrompt = () => (preparingPrompt() ? (runningJob()?.prompt ?? '') : draft.prompt);
  const thinking = () => preparingPrompt() && !currentPrompt();
  const promptScroll = createStreamScroll(
    () => promptArea,
    requestAnimationFrame,
    cancelAnimationFrame,
  );
  createEffect(() => {
    currentPrompt();
    promptScroll.update(
      preparingPrompt() ? runningJob()!.id : null,
      paneActive() && picker() === null && !thinking(),
    );
  });
  onCleanup(promptScroll.dispose);
  const dirty = () => JSON.stringify(draft) !== baseline;
  const inputForSlot = (slot: MediaJobInput['slot']) =>
    draft.inputs.find((input) => input.slot === slot);

  const loadJob = (incoming: MediaJob) =>
    batch(() => {
      const next = draftFromJob(incoming);
      setDraft(next);
      setDraft('workflowValues', reconcile(next.workflowValues));
      const workflow =
        incoming.workflowSnapshot ??
        state.settings.mediaRendering.workflows.find(
          (item) => item.id === incoming.workflowId && item.operation === incoming.operation,
        );
      setReferenceCount(
        operationHasReferences(incoming.operation)
          ? Math.max(
              1,
              workflow?.referenceCount ?? 0,
              incoming.inputs.filter((input) => input.slot.startsWith('reference')).length,
            )
          : 0,
      );
      for (const asset of incoming.assets) {
        setAssets(asset.id, asset);
      }
      baseline = JSON.stringify(next);
    });
  const refreshVariations = async () => {
    if (!jobId()) {
      return;
    }
    const incoming = await api.mediaVariations(jobId()!);
    for (const item of incoming) {
      applyMediaJob(item);
    }
  };
  const refreshOpenJob = () => {
    const id = jobId();
    if (id) {
      void refreshVariations().catch((err: unknown) => setError(errorMessage(err)));
      const existing = state.mediaJobs[id];
      if (existing && !dirty()) {
        loadJob(existing);
      }
      void api
        .mediaJob(id)
        .then((incoming) => {
          applyMediaJob(incoming);
          if (jobId() === id && !dirty()) {
            loadJob(incoming);
          }
        })
        .catch((err: unknown) => setError(errorMessage(err)));
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
        if (incoming && !dirty() && !busy()) {
          loadJob(incoming);
        }
      },
    ),
  );

  const saveDraft = async (): Promise<MediaJob> => {
    if (workflowError()) throw new Error(workflowError());
    const current = job();
    if (jobId() && !current) {
      throw new Error('The job is unavailable. Reopen it from the jobs list.');
    }
    if (current && (frozen() || (!dirty() && !current.submitted))) {
      return current;
    }
    const values = JSON.parse(JSON.stringify(draft)) as ToolDraft;
    values.workflowId = selectedWorkflow() || null;
    values.presetId = selectedPromptId() || null;
    const saved = current?.submitted
      ? await api.rerunMediaJob(current, variationRequestKey, values)
      : current
        ? await api.editMediaJob(current, values)
        : await api.createMediaJob(values, session.id);
    variationRequestKey = newRequestId();
    loadJob(saved);
    setJobId(saved.id);
    applyMediaJob(saved);
    return saved;
  };

  const run = async (
    action: 'prepare' | 'render' | 'cancel' | 'retry-retrieval',
    autoRender = false,
  ) => {
    if (busy()) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const current =
        action === 'cancel'
          ? runningJob()!
          : action === 'retry-retrieval'
            ? job()!
            : await saveDraft();
      const conversation =
        current.contextConversationId === state.tree.conversationId
          ? state.tree
          : state.conversations.find((item) => item.id === current.contextConversationId);
      if (action === 'render' || action === 'prepare') {
        setShowLivePreview(true);
      }
      const result = await api.mediaJobAction(current, action, {
        autoRender,
        expectedActiveLeafId: conversation?.activeLeafId,
        expectedMutationRevision: conversation?.mutationRevision,
      });
      applyMediaJob(result);
      if (action !== 'cancel') {
        loadJob(result);
      }
    } catch (err) {
      setError(errorMessage(err));
      if (jobId()) {
        void api
          .mediaJob(jobId()!)
          .then(applyMediaJob)
          .catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  };

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

  const back = async () => {
    if (busy()) return;
    setBusy(true);
    setError('');
    try {
      await saveOnLeave();
      leaveMediaTool();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const chooseOperation = (value: string) => {
    const operation = value as MediaOperation;
    const count = operationHasReferences(operation) ? Math.max(1, referenceCount()) : 0;
    const allowed = mediaInputSlots(operation, count);
    // Slot validation must see the new operation and reference count together.
    batch(() => {
      resetWorkflowValues();
      setDraft({
        operation,
        workflowId: null,
        presetId: null,
        inputs: draft.inputs.filter((input) => allowed.includes(input.slot)),
      });
      setReferenceCount(count);
    });
  };
  const chooseReferenceCount = (value: string) => {
    resetWorkflowValues();
    const count = Number(value);
    const allowed = mediaInputSlots(draft.operation, count);
    setDraft({
      workflowId: null,
      inputs: draft.inputs.filter((input) => allowed.includes(input.slot)),
    });
    setReferenceCount(count);
  };
  const selectReferences = (items: GalleryItem[]) => {
    const destination = picker();
    const replacements: MediaJobInput[] = items.map((item, index) => ({
      slot:
        destination === 'references'
          ? (`reference${index + 1}` as MediaJobInput['slot'])
          : (destination as MediaJobInput['slot']),
      assetId: item.media!.id,
    }));
    for (const item of items) {
      setAssets(item.media!.id, item.media!);
    }
    const retained = draft.inputs.filter((input) =>
      destination === 'references'
        ? !input.slot.startsWith('reference')
        : input.slot !== destination,
    );
    setDraft('inputs', [...retained, ...replacements]);
    if (destination === 'references') {
      if (referenceCount() !== items.length || draft.workflowId !== null) resetWorkflowValues();
      setReferenceCount(items.length);
      setDraft('workflowId', null);
    }
    setPicker(null);
  };
  const moveReference = (slot: MediaJobInput['slot'], direction: -1 | 1) => {
    const index = Number(slot.slice('reference'.length));
    const otherSlot = `reference${index + direction}` as MediaJobInput['slot'];
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
  const rerun = async () => {
    if (!job() || busy()) {
      return;
    }
    setBusy(true);
    try {
      const next = await api.rerunMediaJob(job()!, newRequestId(), { reviewBeforeSave: true });
      applyMediaJob(next);
      setJobId(next.id);
      loadJob(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const jobGroups = createMemo(() => groupMediaJobs(Object.values(state.mediaJobs)));
  const chooseCandidate = async (index: number) => {
    const candidate = candidates()[index];
    if (!candidate || busy()) {
      return;
    }
    if (!reviewing()) {
      setViewedAssetId(candidate.asset.id);
      setShowLivePreview(false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      applyMediaJob(await api.selectMediaVariation(job()!, candidate.asset.id, review()!.revision));
      setShowLivePreview(false);
    } catch (err) {
      setError(errorMessage(err));
      await refreshVariations().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  const savedAssetIds = () => review()?.savedAssetIds ?? [];
  const selectedSaved = () => Boolean(selected() && savedAssetIds().includes(selected()!.asset.id));
  const copyResultText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      toast(errorMessage(err));
    }
  };
  const accept = async () => {
    if (!selected() || selectedSaved() || !reviewing() || busy() || active()) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const conversation =
        job()!.contextConversationId === state.tree.conversationId
          ? state.tree
          : state.conversations.find((item) => item.id === job()!.contextConversationId);
      if (job()!.destination === 'chat' && !conversation) {
        throw new Error('The destination conversation is unavailable.');
      }
      applyMediaJob(
        await api.acceptMediaVariation(
          job()!,
          selected()!.asset.id,
          review()!.revision,
          conversation ?? state.tree,
        ),
      );
    } catch (err) {
      setError(errorMessage(err));
      await refreshVariations().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    if (!reviewing() || busy()) {
      return;
    }
    setBusy(true);
    try {
      await api.discardMediaDraft(job()!, review()!.revision);
      leaveMediaTool();
    } catch (err) {
      setError(errorMessage(err));
      await refreshVariations().catch(() => {});
    } finally {
      setBusy(false);
    }
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
        headerExtra={
          <div class="page-header-actions">
            <button class="page-back" onClick={() => void back()} disabled={busy()}>
              <FontAwesomeIcon icon={faArrowLeft} size={13} /> Back
            </button>
            <button onClick={openMediaJobs} disabled={busy()}>
              Jobs{runningCount() ? ` (${runningCount()})` : ''}
            </button>
          </div>
        }
      >
        <div class="media-workspace">
          <Show when={error()}>
            <p class="notice notice-error" role="alert">
              {error()}
            </p>
          </Show>
          <div class="gallery-detail media-tool-layout">
            <section class="gallery-detail-stage media-results" aria-label="Media preview">
              <div class="media-preview-content">
                <Show
                  when={hasResults()}
                  fallback={
                    <Show
                      when={sourcePreview()}
                      fallback={
                        <div class="media-empty-preview">
                          <h3>
                            {draft.operation.startsWith('video')
                              ? 'Video preview'
                              : 'Image preview'}
                          </h3>
                          <p class="hint">
                            {active()
                              ? STATUS_LABELS[runningJob()!.state]
                              : 'Your result will appear here.'}
                          </p>
                        </div>
                      }
                    >
                      {(asset) => (
                        <img class="media-result" src={asset().url} alt={sourcePreviewLabel()} />
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
                              <img
                                class="media-result"
                                src={candidate.asset.url}
                                alt="Generated image"
                              />
                            }
                          >
                            <MediaPlayer
                              ref={(player) => {
                                videoPlayer = player;
                              }}
                              asset={candidate.asset}
                              class="media-result"
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
                        <img class="media-result" src={preview()} alt="Generation preview" />
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
              <Show when={selected() || (!hasResults() && sourcePreview())}>
                <div class="media-preview-footer">
                  <Show when={!hasResults() && sourcePreview()}>
                    <span class="hint">{sourcePreviewLabel()}</span>
                  </Show>
                  <Show when={candidates().length > 1}>
                    <div class="media-variation-nav" aria-label="Variations">
                      <button
                        class="icon-btn"
                        aria-label="Previous variation"
                        disabled={busy() || selectedIndex() <= 0}
                        onClick={() => void chooseCandidate(selectedIndex() - 1)}
                      >
                        <FontAwesomeIcon icon={faChevronLeft} size={14} />
                      </button>
                      <span aria-live="polite">
                        Variation {selectedIndex() + 1} / {candidates().length}
                      </span>
                      <button
                        class="icon-btn"
                        aria-label="Next variation"
                        disabled={busy() || selectedIndex() >= candidates().length - 1}
                        onClick={() => void chooseCandidate(selectedIndex() + 1)}
                      >
                        <FontAwesomeIcon icon={faChevronRight} size={14} />
                      </button>
                    </div>
                  </Show>
                  <Show when={!videoPreview() && !preview() && selected()}>
                    {(candidate) => (
                      <div class="media-preview-actions">
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
                      </div>
                    )}
                  </Show>
                </div>
              </Show>
            </section>
            <aside class="detail-panel media-tool-form" aria-label="Media controls">
              <div class="media-tool-fields">
                <dl class="media-tool-context" aria-label="Context and destination">
                  <dt>Context</dt>
                  <dd>{usesChatContext() ? `Chat: ${chatTitle()}` : 'Standalone'}</dd>
                  <dt>Destination</dt>
                  <dd>{draft.destination === 'chat' ? 'This chat' : 'Gallery'}</dd>
                </dl>
                <Show when={operationChoices().length > 1}>
                  <div class="media-tool-field">
                    <label>Operation</label>
                    <Select
                      ariaLabel="Media operation"
                      value={draft.operation}
                      disabled={busy() || frozen()}
                      options={operationChoices().map((operation) => ({
                        value: operation.id,
                        label: operation.label,
                      }))}
                      onChange={chooseOperation}
                    />
                  </div>
                </Show>
                <Show when={operationHasReferences(draft.operation)}>
                  <div class="media-tool-field">
                    <label>Reference images</label>
                    <div class="key-row">
                      <Select
                        ariaLabel="Reference count"
                        value={String(referenceCount())}
                        disabled={busy() || frozen()}
                        options={[1, 2, 3].map((count) => ({
                          value: String(count),
                          label: String(count),
                        }))}
                        onChange={chooseReferenceCount}
                      />
                      <button disabled={busy() || frozen()} onClick={() => setPicker('references')}>
                        Choose references
                      </button>
                    </div>
                  </div>
                </Show>
                <For each={slots()}>
                  {(slot) => (
                    <div
                      class="media-reference-row field-group"
                      role="group"
                      aria-labelledby={`media-input-${slot}`}
                    >
                      <div class="media-reference-thumbnail">
                        <Show
                          when={inputForSlot(slot)}
                          fallback={<FontAwesomeIcon icon={faImage} size={24} />}
                        >
                          {(input) => (
                            <img
                              src={
                                assets[input().assetId]?.thumbnail ?? assets[input().assetId]?.url
                              }
                              alt={INPUT_LABELS[slot]}
                              decoding="async"
                            />
                          )}
                        </Show>
                      </div>
                      <div class="form-stack media-reference-controls">
                        <span class="media-reference-label" id={`media-input-${slot}`}>
                          {INPUT_LABELS[slot]}
                        </span>
                        <div class="key-row">
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
                            <Show when={slot.startsWith('reference')}>
                              <button
                                class="icon-btn"
                                title={`Move ${INPUT_LABELS[slot].toLowerCase()} up`}
                                aria-label={`Move ${INPUT_LABELS[slot].toLowerCase()} up`}
                                disabled={busy() || frozen() || slot === 'reference1'}
                                onClick={() => moveReference(slot, -1)}
                              >
                                <FontAwesomeIcon icon={faArrowUp} size={14} />
                              </button>
                              <button
                                class="icon-btn"
                                title={`Move ${INPUT_LABELS[slot].toLowerCase()} down`}
                                aria-label={`Move ${INPUT_LABELS[slot].toLowerCase()} down`}
                                disabled={
                                  busy() || frozen() || Number(slot.slice(9)) >= referenceCount()
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
                <div class="media-tool-field">
                  <label>Workflow</label>
                  <Select
                    ariaLabel="Saved media workflow"
                    value={selectedWorkflow()}
                    buttonLabel={selectedWorkflow() ? undefined : 'Choose a workflow'}
                    disabled={busy() || frozen() || workflows().length === 0}
                    options={workflows().map((workflow) => ({
                      value: workflow.id,
                      label: workflow.name,
                    }))}
                    onChange={(value) => {
                      resetWorkflowValues();
                      setDraft('workflowId', value || null);
                    }}
                  />
                </div>
                <Show when={workflowControls().controls.length > 0}>
                  <div
                    class="workflow-inputs field-group"
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
                  <p class="hint">
                    Add a workflow for this operation in Settings → Media rendering.
                  </p>
                </Show>
                <div class="media-tool-field">
                  <label>Prompt preset</label>
                  <Select
                    ariaLabel="Media prompt preset"
                    value={selectedPromptId()}
                    buttonLabel={
                      createsChatImage() || draft.presetId
                        ? undefined
                        : `Default: ${defaultPromptLabel()}`
                    }
                    disabled={busy() || frozen()}
                    options={promptOptions()}
                    onChange={(value) => setDraft('presetId', value || null)}
                  />
                </div>
                <div class="media-instruction-heading">
                  <label for="media-instruction">Instruction</label>
                  <div class="key-row">
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
                <div class="media-prompt-heading">
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
                  <div class="media-prompt-thinking">
                    <PromptGenerationStatus
                      active={paneActive()}
                      content=""
                      showStatus={false}
                      reasoning={runningJob()?.reasoning}
                    />
                  </div>
                </Show>
              </div>
              <div class="media-tool-footer">
                <Show when={runningJob() ?? job()}>
                  {(current) => (
                    <Show
                      when={
                        current().state !== 'draft' || current().error || savedAssetIds().length
                      }
                    >
                      <div class="form-stack media-rendering">
                        <Show when={current().state !== 'draft' || savedAssetIds().length}>
                          <div class="media-render-heading">
                            <p class="media-render-status" role="status">
                              <Show when={current().state !== 'draft'}>
                                {STATUS_LABELS[current().state]}
                              </Show>
                              <Show when={savedAssetIds().length}>
                                <span class="media-saved-count">
                                  {current().state !== 'draft' ? ' · ' : ''}
                                  {savedAssetIds().length} saved
                                </span>
                              </Show>
                            </p>
                            <Show
                              when={
                                active() &&
                                current().state !== 'preparing' &&
                                current().progress?.node
                              }
                            >
                              {(node) => (
                                <span class="media-current-node" title={node().name}>
                                  {node().name}
                                </span>
                              )}
                            </Show>
                          </div>
                        </Show>
                        <Show
                          when={current().state === 'succeeded' && current().outputs.length === 0}
                        >
                          <p class="hint">
                            The saved results have been removed. You can still rerun this job.
                          </p>
                        </Show>
                        <Show when={current().error}>
                          <p class="notice notice-error">{current().error}</p>
                        </Show>
                        <Show when={active() && current().state !== 'preparing'}>
                          <div class="media-render-progress">
                            <div class="media-progress-row media-graph-progress">
                              <SamplerProgress
                                progress={current().progress?.graph}
                                stepsLabel="Nodes"
                                stepsClass="media-progress-count"
                              />
                            </div>
                            <div class="media-progress-row">
                              <SamplerProgress
                                progress={current().progress}
                                stepsLabel="Steps"
                                stepsClass="media-progress-count"
                              />
                            </div>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  )}
                </Show>
                <div class="form-actions">
                  <Show when={!frozen()}>
                    <button
                      class="primary-btn"
                      title="Render the final prompt shown above"
                      disabled={
                        busy() ||
                        !draft.prompt.trim() ||
                        !selectedWorkflow() ||
                        Boolean(workflowError())
                      }
                      onClick={() => void run('render')}
                    >
                      {reviewing() && candidates().length > 0 ? 'Generate another' : 'Render'}
                    </button>
                  </Show>
                  <Show when={active()}>
                    <button
                      disabled={busy() || runningJob()?.state === 'cancelling'}
                      onClick={() => void run('cancel')}
                    >
                      Cancel generation
                    </button>
                  </Show>
                  <Show when={job()?.retrievalAvailable}>
                    <button disabled={busy()} onClick={() => void run('retry-retrieval')}>
                      Retry download
                    </button>
                  </Show>
                  <Show when={reviewing()}>
                    <button
                      class="primary-btn"
                      disabled={busy() || active() || !selected() || selectedSaved()}
                      onClick={() => void accept()}
                    >
                      <FontAwesomeIcon icon={faCheck} size={14} />{' '}
                      {selectedSaved()
                        ? draft.destination === 'chat'
                          ? 'Added to chat'
                          : 'Saved to gallery'
                        : draft.destination === 'chat'
                          ? 'Add to chat'
                          : 'Save to gallery'}
                    </button>
                    <button disabled={busy()} onClick={() => void discard()}>
                      <FontAwesomeIcon
                        icon={savedAssetIds().length ? faCheck : faTrashCan}
                        size={14}
                      />{' '}
                      {savedAssetIds().length ? 'Finish' : 'Discard draft'}
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
              maximum: slot() === 'references' ? 3 : 1,
              selectedAssetIds: draft.inputs
                .filter((input) =>
                  slot() === 'references'
                    ? input.slot.startsWith('reference')
                    : input.slot === slot(),
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
