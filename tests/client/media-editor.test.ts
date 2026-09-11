import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
import { createRoot, untrack } from 'solid-js';
import {
  type Conversation,
  type MediaAsset,
  type MediaJob,
  type MediaJobDraft,
  type MediaWorkflow,
  type Message,
} from '@tinytavern/shared';
import {
  orderedMediaInputs,
  reconcileMediaInputSelection,
} from '../../client/src/media/inputSelection.ts';

test('bulk input selection retains slot assignments, gaps and sources outside the gallery', () => {
  const slots = ['input1', 'input2', 'input4'];
  const selectable = new Set([1, 2, 3]);
  const swapped = [
    { slot: 'input2', assetId: 1 },
    { slot: 'input1', assetId: 2 },
  ];
  const ordered = orderedMediaInputs(slots, swapped);
  assert.deepEqual(
    ordered.map((input) => input.assetId),
    [2, 1],
  );
  assert.deepEqual(reconcileMediaInputSelection(slots, swapped, [2, 1], selectable), ordered);
  assert.deepEqual(reconcileMediaInputSelection(slots, swapped, [1], selectable), [swapped[0]]);
  assert.deepEqual(reconcileMediaInputSelection(slots, [swapped[0]!], [1, 3], selectable), [
    { slot: 'input1', assetId: 3 },
    swapped[0],
  ]);
  const repeated = [
    { slot: 'input1', assetId: 1 },
    { slot: 'input4', assetId: 1 },
  ];
  assert.deepEqual(reconcileMediaInputSelection(slots, repeated, [1, 1], selectable), repeated);
  const avatar = { slot: 'input2', assetId: 99 };
  assert.deepEqual(reconcileMediaInputSelection(slots, [avatar], [3], selectable), [
    { slot: 'input1', assetId: 3 },
    avatar,
  ]);
});

test('media drafts retain edits across settings, generation and ordered job snapshots', async () => {
  const location = { hash: '#' };
  const history = {
    state: {},
    replaceState(state: object, _title: string, hash?: string) {
      this.state = state;
      if (hash !== undefined) location.hash = hash;
    },
    pushState(state: object, title: string, hash?: string) {
      this.replaceState(state, title, hash);
    },
  };
  Object.defineProperties(globalThis, {
    location: { configurable: true, value: location },
    history: { configurable: true, value: history },
    window: { configurable: true, value: { setTimeout, clearTimeout } },
    matchMedia: { configurable: true, value: () => ({ matches: false, addEventListener() {} }) },
    requestAnimationFrame: { configurable: true, value: () => 0 },
    cancelAnimationFrame: { configurable: true, value: () => {} },
  });
  type Control = {
    renderPrompt?: (message: Message, text?: string) => void;
    session?: { state: { selectedId: number | null; tree: { conversationId: number | null } } };
    disabled?: boolean;
    readOnly?: boolean;
    onChange?: (value: string) => void;
    onInput?: (event: unknown) => void;
    onClick?: () => void;
  };
  const controls = new Map<string, Control>();
  // Execute the real component's controller and callbacks; DOM rendering is outside this test.
  mock.module('react/jsx-dev-runtime', () => ({
    Fragment: Symbol('Fragment'),
    jsxDEV: (_type: unknown, props: Record<string, unknown>) => {
      const key =
        props.ariaLabel ??
        props['aria-label'] ??
        props.id ??
        props.title ??
        (typeof props.children === 'string' ? props.children : undefined);
      if (typeof key === 'string') controls.set(key, props as Control);
      if (props.children === 'Render') controls.set('render-media', props as Control);
      if (props.controls && props.values) controls.set('workflow-values', props as Control);
      if (props.embedded && props.session) controls.set('prompt-conversation', props as Control);
      return null;
    },
  }));
  const storePath = '../../client/src/state/store.ts';
  const {
    state,
    setState,
    applyMediaJob,
    openDialog,
    handleServerEvent,
    selectConversation,
    restoreConversationSelection,
  } = await import(storePath);
  const apiPath = '../../client/src/state/api.ts';
  const { api } = await import(apiPath);
  const stackPath = '../../client/src/state/dialogStack.ts';
  const { dialogStack, createDialogStack } = await import(stackPath);
  const contextPath = '../../client/src/state/dialogContext.ts';
  const { DialogContext } = await import(contextPath);
  const locationPath = '../../client/src/state/pageLocation.ts';
  const { parsePageLocation, formatPageLocation, navigatePageWithGuards, rememberMediaPage } =
    await import(locationPath);
  const mediaPath = '../../client/src/media/navigation.ts';
  const { openMediaTool, restorePage } = await import(mediaPath);
  const componentPath = '../../client/src/media/MediaToolsModal.tsx';
  const { default: MediaToolsModal } = await import(componentPath);
  const workflow = (id: string): MediaWorkflow => ({
    id,
    name: id,
    textOutputNodeId: null,
    chatPromptPresetId: null,
    standalonePromptPresetId: null,
    inputBindings: { standalone: { input1: 'selected:1' } },
    json: JSON.stringify({
      '1': {
        class_type: 'LoadImage',
        inputs: { image: 'sample.png' },
        _meta: { title: 'Input 1 [image:input1]' },
      },
      '2': { class_type: 'PrimitiveString', inputs: { value: '{{prompt}}' } },
      '3': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
      duration: {
        class_type: 'PrimitiveInt',
        _meta: { title: 'Duration [input]' },
        inputs: { value: 5 },
      },
    }),
  });
  const a = workflow('a');
  const b = workflow('b');
  setState('settings', 'mediaRendering', 'workflows', [a, b]);
  const source = {
    id: 10,
    kind: 'image',
    url: '/images/source.png',
    width: 400,
    height: 600,
  } as MediaAsset;
  const makeJob = (id: number, overrides: Partial<MediaJob> = {}): MediaJob => ({
    id,
    revision: 1,
    characterIds: [],
    workflowValues: {},
    draft: { id, revision: 1, state: 'open', selectedAssetId: null, savedAssetIds: [] },
    textResult: null,
    temporary: false,
    workflowId: 'b',
    presetId: null,
    state: 'draft',
    instruction: '',
    prompt: '',
    inputs: [],
    assets: [source],
    outputs: [],
    contextConversationId: null,
    galleryFolderId: null,
    messageId: null,
    destination: 'gallery',
    sourceJobId: null,
    seed: null,
    comfyPromptId: null,
    submitted: false,
    retrievalAvailable: false,
    error: null,
    cleanupPending: 0,
    createdAt: id,
    updatedAt: id,
    startedAt: null,
    ...overrides,
  });
  const originalApi = {
    createMediaJob: api.createMediaJob,
    editMediaJob: api.editMediaJob,
    mediaJob: api.mediaJob,
    mediaVariations: api.mediaVariations,
    mediaJobAction: api.mediaJobAction,
    rerunMediaJob: api.rerunMediaJob,
    acceptMediaVariation: api.acceptMediaVariation,
    discardMediaDraft: api.discardMediaDraft,
    conversation: api.conversation,
    restartMediaConversation: api.restartMediaConversation,
    migrateMediaConversation: api.migrateMediaConversation,
  };
  const keys: string[] = [];
  const created = new Map<string, MediaJob>();
  for (let key = 1; key <= 20; key++) {
    created.set(String(key), makeJob(99, { state: 'succeeded', submitted: true, draft: null }));
  }
  let nextCreatedId = 100;
  let submitted: Partial<MediaJobDraft> | undefined;
  let actionOptions: { promptMessageId?: number; promptExcerpt?: string } | undefined;
  let finishAction!: (job: MediaJob) => void;
  const nextAction = () =>
    new Promise<MediaJob>((resolve) => {
      finishAction = resolve;
    });
  api.createMediaJob = async (draft: MediaJobDraft, key: string) => {
    keys.push(key);
    submitted = structuredClone(draft);
    const existing = created.get(key);
    if (existing) return existing;
    const job = makeJob(nextCreatedId++, {
      ...draft,
      inputs: (draft.inputs ?? []).map((input) => ({ ...input, prompt: '' })),
      workflowId: draft.workflowId ?? null,
    });
    created.set(key, job);
    return job;
  };
  api.editMediaJob = async (job: MediaJob, draft: Partial<MediaJobDraft>) => {
    submitted = structuredClone(draft);
    return { ...job, ...draft, revision: job.revision + 1 } as MediaJob;
  };
  api.migrateMediaConversation = async (job: MediaJob) => job;
  api.mediaVariations = async () => [];
  api.mediaJobAction = async (
    job: MediaJob,
    _action: string,
    options: { promptMessageId?: number; promptExcerpt?: string },
  ) => {
    actionOptions = options;
    finishAction(job);
    return { ...job, revision: job.revision + 1, state: 'ready' };
  };
  const mount = () => {
    controls.clear();
    let dispose!: () => void;
    const frame = dialogStack.top()!;
    createRoot((cleanup) => {
      dispose = cleanup;
      DialogContext.Provider({
        value: { frame, active: () => dialogStack.top() === frame },
        get children() {
          return untrack(() => MediaToolsModal({ session: frame.media! }));
        },
      });
    });
    return dispose;
  };
  let dispose = () => {};
  try {
    const gallery = parsePageLocation('#+/gallery/12');
    dialogStack.restore(gallery);
    location.hash = formatPageLocation(gallery);
    openMediaTool('a', { input: { asset: source }, galleryFolderId: 7 });
    const frame = dialogStack.top()!;
    assert.notEqual(
      frame.media!.requestKey,
      frame.id,
      'Server creation keys are independent of dialog counters',
    );
    assert.match(frame.media!.requestKey, /^\d{15,30}$/);
    const restored = createDialogStack();
    restored.restore(parsePageLocation('#+/media/generate'));
    assert.notEqual(
      restored.top()!.media!.requestKey,
      frame.media!.requestKey,
      'Restored sessions also receive distinct request nonces',
    );
    dispose = mount();
    controls.get('Saved media workflow')!.onChange!('b');
    assert.equal(
      parsePageLocation(location.hash).media!.workflowId,
      'b',
      'A new editor keeps its workflow in the reload URL before creating a job',
    );
    controls.get('media-instruction')!.onInput!({
      currentTarget: { value: 'Animate the selected image' },
    });
    const parent = frame.page;
    openDialog({ chatId: null, modal: 'settings', settingsTab: 'workflows', settingsEntity: 'b' });
    setState('settings', 'mediaRendering', 'workflows', [b]);
    dialogStack.restore(parent);
    location.hash = formatPageLocation(parent);
    assert.equal(dialogStack.top(), frame, 'Closing settings retains the mounted media editor');
    const started = nextAction();
    controls.get('Write a new prompt from your instruction, then render it')!.onClick!();
    const current = await started;
    assert.equal(submitted!.workflowId, 'b');
    assert.equal(submitted!.instruction, 'Animate the selected image');
    assert.equal(
      submitted!.galleryFolderId,
      7,
      'The gallery destination survives workflow changes and child panes',
    );
    assert.deepEqual(submitted!.inputs, [{ slot: 'input1', assetId: source.id }]);
    assert.equal(keys[0], frame.media!.requestKey);
    assert.equal(
      current.id,
      100,
      'Generation creates this draft instead of returning an old frozen job with a reused counter key',
    );
    await Promise.resolve();
    await Promise.resolve();
    dispose();

    const older = makeJob(200, { prompt: 'Old prompt' });
    applyMediaJob(older);
    dialogStack.restore(parsePageLocation('#+/media/job/200'));
    location.hash = '#+/media/job/200';
    let finishRefresh!: (job: MediaJob) => void;
    api.mediaJob = () =>
      new Promise<MediaJob>((resolve) => {
        finishRefresh = resolve;
      });
    dispose = mount();
    applyMediaJob({ ...older, revision: 2, prompt: 'New prompt from socket' });
    finishRefresh(older);
    await Promise.resolve();
    await Promise.resolve();
    controls.get('media-instruction')!.onInput!({ currentTarget: { value: 'Next edit' } });
    const preparing = nextAction();
    controls.get('Write a new prompt from your instruction, then render it')!.onClick!();
    const accepted = await preparing;
    assert.equal(
      submitted!.prompt,
      'New prompt from socket',
      'Rejected HTTP snapshots cannot become the editor baseline',
    );
    assert.equal(accepted.revision, 3);
    assert.equal(state.mediaJobs[200]!.instruction, 'Next edit');
    await Promise.resolve();
    await Promise.resolve();
    dispose();

    const rendering = makeJob(300, {
      state: 'rendering',
      submitted: true,
      prompt: 'Original prompt',
      workflowValues: { duration: 5 },
    });
    applyMediaJob(rendering);
    setState('settings', 'mediaRendering', 'workflows', [a, b]);
    setState('settings', 'mediaRendering', 'defaultWorkflowId', 'b');
    dialogStack.restore(parsePageLocation('#+/media/job/300'));
    location.hash = '#+/media/job/300';
    api.mediaJob = async (id: number) => state.mediaJobs[id];
    const variationKeys: string[] = [];
    api.rerunMediaJob = async (job: MediaJob, key: string, values: Partial<MediaJobDraft>) => {
      variationKeys.push(key);
      submitted = structuredClone(values);
      return makeJob(300 + variationKeys.length, {
        ...values,
        draft: { ...job.draft!, revision: variationKeys.length + 1 },
        sourceJobId: job.id,
        inputs: (values.inputs ?? []).map((input) => ({ ...input, prompt: '' })),
      });
    };
    api.mediaJobAction = async (
      job: MediaJob,
      _action: string,
      options: { promptMessageId?: number; promptExcerpt?: string },
    ) => {
      actionOptions = options;
      finishAction(job);
      return { ...job, revision: job.revision + 1, state: 'queued', submitted: true };
    };
    for (let visit = 0; visit < 2; visit++) {
      dispose = mount();
      const closed = parsePageLocation('#');
      await new Promise<void>((resolve) =>
        navigatePageWithGuards(closed, () => {
          dialogStack.restore(closed);
          resolve();
        }),
      );
      assert.equal(
        variationKeys.length,
        0,
        'Closing an unchanged running job cannot create a variation',
      );
      dispose();
      dialogStack.restore(parsePageLocation('#+/media/job/300'));
      location.hash = '#+/media/job/300';
    }
    dispose = mount();
    assert.equal(controls.get('Saved media workflow')!.disabled, false);
    assert.equal(controls.get('Media prompt preset')!.disabled, false);
    assert.equal(controls.get('workflow-values')!.disabled, false);
    assert.equal(controls.get('media-prompt')!.readOnly, false);
    controls.get('Saved media workflow')!.onChange!('a');
    const changeValue = controls.get('workflow-values')!.onChange as unknown as (
      key: string,
      value: number,
    ) => void;
    changeValue('duration', 9);
    controls.get('media-instruction')!.onInput!({ currentTarget: { value: 'Next instruction' } });
    controls.get('media-prompt')!.onInput!({ currentTarget: { value: 'Next prompt' } });
    applyMediaJob({ ...rendering, revision: 2 });
    const queued = nextAction();
    controls.get('Queue another variation')!.onClick!();
    const second = await queued;
    assert.equal(second.id, 301);
    assert.equal(second.draft!.id, rendering.draft!.id);
    assert.equal(submitted!.workflowId, 'a');
    assert.deepEqual(submitted!.workflowValues, { duration: 9 });
    assert.equal(submitted!.instruction, 'Next instruction');
    assert.equal(submitted!.prompt, 'Next prompt');
    assert.equal(state.mediaJobs[300]!.prompt, 'Original prompt');
    assert.deepEqual(JSON.parse(JSON.stringify(state.mediaJobs[300]!.workflowValues)), {
      duration: 5,
    });
    await Promise.resolve();
    await Promise.resolve();
    changeValue('duration', 12);
    controls.get('media-prompt')!.onInput!({ currentTarget: { value: 'Third prompt' } });
    applyMediaJob({ ...rendering, revision: 3, state: 'succeeded' });
    const queueAgain = nextAction();
    controls.get('Queue another variation')!.onClick!();
    assert.equal((await queueAgain).id, 302);
    assert.deepEqual(submitted!.workflowValues, { duration: 12 });
    assert.equal(
      submitted!.prompt,
      'Third prompt',
      'Completion of an earlier variation cannot replace the next draft',
    );
    assert.notEqual(variationKeys[0], variationKeys[1]);
    await Promise.resolve();
    await Promise.resolve();
    applyMediaJob({
      ...state.mediaJobs[301]!,
      revision: state.mediaJobs[301]!.revision + 1,
      state: 'succeeded',
      outputs: [
        { ...source, id: 801 },
        { ...source, id: 802 },
      ],
    });
    applyMediaJob({
      ...state.mediaJobs[302]!,
      revision: state.mediaJobs[302]!.revision + 1,
      state: 'succeeded',
      outputs: [{ ...source, id: 803 }],
    });
    controls.get('Previous variation')!.onClick!();
    const restoredPreview = parsePageLocation(location.hash);
    assert.equal(restoredPreview.media!.jobId, 302, 'Preview navigation retains the editor anchor');
    assert.equal(restoredPreview.media!.previewJobId, 301);
    assert.equal(restoredPreview.media!.assetId, 802);
    const retainedEditor = dialogStack.top();
    openMediaTool('a', { jobId: 301, assetId: 801 });
    assert.equal(dialogStack.top(), retainedEditor, 'Opening an output retains the working editor');
    assert.equal(parsePageLocation(location.hash).media!.jobId, 302);
    assert.equal(parsePageLocation(location.hash).media!.previewJobId, 301);
    assert.equal(parsePageLocation(location.hash).media!.assetId, 801);
    openMediaTool('a', { jobId: 301, assetId: 802 });
    assert.equal(
      parsePageLocation(location.hash).media!.assetId,
      802,
      'Opening a sibling output selects its exact asset',
    );
    dispose();
    const restoredJobs = JSON.parse(JSON.stringify(state.mediaJobs)) as Record<number, MediaJob>;
    for (const id of Object.keys(state.mediaJobs)) setState('mediaJobs', Number(id), undefined!);
    let finishAnchor!: (job: MediaJob) => void;
    let finishVariations!: (jobs: MediaJob[]) => void;
    api.mediaJob = () =>
      new Promise<MediaJob>((resolve) => {
        finishAnchor = resolve;
      });
    api.mediaVariations = () =>
      new Promise<MediaJob[]>((resolve) => {
        finishVariations = resolve;
      });
    dialogStack.restore(parsePageLocation('#'));
    dialogStack.restore(restoredPreview);
    location.hash = formatPageLocation(restoredPreview);
    dispose = mount();
    finishAnchor(restoredJobs[302]!);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      parsePageLocation(location.hash).media!.previewJobId,
      301,
      'Loading the editor before its siblings cannot replace the saved preview',
    );
    assert.equal(parsePageLocation(location.hash).media!.assetId, 802);
    finishVariations([restoredJobs[300]!, restoredJobs[301]!, restoredJobs[302]!]);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(parsePageLocation(location.hash).media!.previewJobId, 301);
    const restoredQueue = nextAction();
    controls.get('Render the final prompt shown above')!.onClick!();
    await restoredQueue;
    assert.equal(submitted!.prompt, 'Third prompt');
    assert.deepEqual(submitted!.workflowValues, { duration: 12 });
    await Promise.resolve();
    await Promise.resolve();
    dispose();
    api.mediaJob = async (id: number) => state.mediaJobs[id];
    api.mediaVariations = async () => [];

    const preparingJob = makeJob(400, { state: 'preparing', prompt: 'Partial prompt' });
    applyMediaJob(preparingJob);
    dialogStack.restore(parsePageLocation('#+/media/job/400'));
    location.hash = '#+/media/job/400';
    dispose = mount();
    controls.get('media-instruction')!.onInput!({
      currentTarget: { value: 'Prepare another variation' },
    });
    applyMediaJob({ ...preparingJob, revision: 2, prompt: 'More partial prompt' });
    const prepared = nextAction();
    controls.get('Write a new prompt from your instruction, then render it')!.onClick!();
    const preparationCopy = await prepared;
    assert.notEqual(
      preparationCopy.id,
      400,
      'Prompt preparation must fork a running job even before Comfy submission',
    );
    assert.equal(
      submitted!.prompt,
      'More partial prompt',
      'Prompt streaming still updates untouched fields while editing other settings',
    );
    assert.equal(
      state.mediaJobs[400]!.instruction,
      '',
      'The running preparation keeps its captured instruction',
    );
    await Promise.resolve();
    await Promise.resolve();
    dispose();

    setState('settings', 'mediaRendering', 'workflows', [a, b]);
    const legacy = makeJob(449, { prompt: 'Saved full prompt' });
    applyMediaJob(legacy);
    let migrated = false;
    api.migrateMediaConversation = async (job: MediaJob) => {
      assert.equal(job.id, legacy.id);
      assert.equal(job.prompt, 'Saved full prompt');
      migrated = true;
      return { ...job, revision: job.revision + 1, draft: { ...job.draft!, conversationId: 776 } };
    };
    api.conversation = async (id: number) =>
      ({ id, title: 'Migrated prompts', promptMode: 'media' }) as Conversation;
    dialogStack.restore(parsePageLocation('#+/media/job/449'));
    location.hash = '#+/media/job/449';
    dispose = mount();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.ok(migrated, 'Opening a saved prompt automatically imports its discussion');
    assert.equal(state.mediaJobs[449]!.draft!.conversationId, 776);
    assert.equal(controls.get('prompt-conversation')!.session!.state.selectedId, 776);
    dispose();
    api.migrateMediaConversation = async (job: MediaJob) => job;

    const unstarted = makeJob(450);
    applyMediaJob(unstarted);
    dialogStack.restore(parsePageLocation('#+/media/job/450'));
    location.hash = '#+/media/job/450';
    dispose = mount();
    controls.get('Saved media workflow')!.onChange!('a');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      state.mediaJobs[450]!.workflowId,
      'a',
      'Changing an existing unstarted draft saves its workflow before starting a conversation',
    );
    const reloadPage = parsePageLocation(location.hash);
    const persisted = JSON.parse(JSON.stringify(state.mediaJobs[450])) as MediaJob;
    dispose();
    setState('mediaJobs', 450, undefined!);
    api.mediaJob = async () => persisted;
    dialogStack.restore(parsePageLocation('#'));
    dialogStack.restore(reloadPage);
    dispose = mount();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      state.mediaJobs[450]!.startedAt,
      null,
      'Saving the selection starts no generation',
    );
    const afterReload = nextAction();
    controls.get('Write a new prompt from your instruction, then render it')!.onClick!();
    assert.equal(
      (await afterReload).workflowId,
      'a',
      'The reopened editor uses the saved workflow',
    );
    await Promise.resolve();
    await Promise.resolve();
    dispose();
    api.mediaJob = async (id: number) => state.mediaJobs[id];

    const textResult = makeJob(500, {
      state: 'succeeded',
      textResult: 'Text to add to chat',
      destination: 'chat',
      contextConversationId: 900,
      submitted: true,
    });
    applyMediaJob(textResult);
    setState('tree', 'conversationId', 900);
    dialogStack.restore(parsePageLocation('#'));
    location.hash = '#';
    openMediaTool('b', { jobId: 500, conversationId: 900 });
    let acceptedText!: () => void;
    const textAccepted = new Promise<void>((resolve) => {
      acceptedText = resolve;
    });
    let acceptanceCount = 0;
    api.acceptMediaVariation = async (
      job: MediaJob,
      assetId: number | null,
      expectedDraftRevision: number,
    ) => {
      acceptanceCount++;
      assert.equal(job.id, textResult.id);
      assert.equal(assetId, null);
      assert.equal(expectedDraftRevision, 1);
      acceptedText();
      return { ...job, revision: 2, messageId: 901, draft: { ...job.draft!, revision: 2 } };
    };
    dispose = mount();
    assert.equal(controls.get('Add to chat')!.disabled, false);
    controls.get('Add to chat')!.onClick!();
    await textAccepted;
    await Promise.resolve();
    await Promise.resolve();
    controls.get('Add to chat')!.onClick!();
    assert.equal(acceptanceCount, 1, 'A saved text variation cannot be added twice');
    dispose();

    const launchJob = makeJob(460);
    const pendingJob = makeJob(461, {
      state: 'ready',
      startedAt: 1,
      prompt: 'Saved pending prompt',
      draft: { ...launchJob.draft!, revision: 2, conversationId: 777 },
    });
    applyMediaJob(launchJob);
    applyMediaJob(pendingJob);
    api.conversation = async (id: number) => ({
      id,
      title: 'Prompt conversation',
      promptMode: 'media',
      characterId: null,
      personaId: null,
      endpointId: null,
      speakerName: null,
      scenarioOverride: null,
      activeLeafId: null,
      mutationRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const conversations = [...state.conversations];
    setState('conversations', [...conversations, await api.conversation(777)]);
    selectConversation(777);
    assert.equal(state.selectedId, null, 'Media conversations cannot open in the main chat');
    location.hash = '#777';
    restoreConversationSelection();
    assert.equal(state.selectedId, null, 'Initial URL restoration excludes media conversations');
    assert.equal(parsePageLocation(location.hash).chatId, null);
    restorePage(parsePageLocation(`#777+/media/job/${pendingJob.id}`));
    assert.equal(state.selectedId, null, 'History navigation excludes media conversations');
    assert.equal(parsePageLocation(location.hash).chatId, null);
    assert.equal(
      dialogStack.top()!.page.media!.jobId,
      pendingJob.id,
      'The media panel remains accessible',
    );
    setState('conversations', conversations);
    for (const launchId of [undefined, launchJob.id]) {
      dialogStack.restore(parsePageLocation('#'));
      location.hash = '#';
      openMediaTool('a', { jobId: launchId });
      const frame = dialogStack.top()!;
      dispose = mount();
      rememberMediaPage({ ...frame.page.media!, jobId: pendingJob.id });
      dispose();
      // Hot reload remounts the component inside the retained frame, with its original props.
      assert.equal(frame.media!.jobId, launchId ?? null);
      dispose = mount();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(
        parsePageLocation(location.hash).media!.jobId,
        pendingJob.id,
        'Hot reload keeps the current pending job instead of restoring the launch job',
      );
      const session = controls.get('prompt-conversation')!.session!;
      assert.equal(session.state.selectedId, 777, 'The remounted panel reopens its saved thread');
      const reply = {
        id: 7770,
        conversationId: 777,
        parentId: null,
        activeChildId: 7771,
        role: 'assistant',
        status: 'done',
        content: 'Prompt:\n```text\nBlue sky\n```\nExplanation.',
        reasoning: null,
        model: null,
        name: null,
        genMeta: null,
        generationKind: 'normal',
        generationToken: null,
        media: [],
        activeImage: 0,
        imagePending: false,
        hasImageRender: false,
        createdAt: 1,
      } as Message;
      const later = {
        ...reply,
        id: 7771,
        parentId: reply.id,
        activeChildId: null,
        content: 'Later reply',
      };
      const tree = {
        t: 'tree',
        conversationId: 777,
        messages: [reply, later],
        activeLeafId: later.id,
        mutationRevision: 1,
      } as const;
      handleServerEvent(tree);
      assert.equal(
        session.state.tree.conversationId,
        777,
        'The remounted thread receives its tree',
      );
      const directRender = nextAction();
      controls.get('prompt-conversation')!.renderPrompt!(reply, 'Blue sky');
      assert.equal((await directRender).prompt, 'Blue sky', 'The reply action renders directly');
      assert.equal(actionOptions?.promptMessageId, reply.id);
      assert.equal(actionOptions?.promptExcerpt, 'Blue sky');
      await Promise.resolve();
      await Promise.resolve();
      dispose();
      dispose = mount();
      await Promise.resolve();
      await Promise.resolve();
      handleServerEvent(tree);
      const selectedRender = nextAction();
      controls.get('render-media')!.onClick!();
      assert.equal((await selectedRender).prompt, 'Blue sky');
      assert.equal(actionOptions?.promptMessageId, reply.id);
      assert.equal(
        actionOptions?.promptExcerpt,
        'Blue sky',
        'The selected excerpt survives remount and reaches Generate',
      );
      await Promise.resolve();
      await Promise.resolve();
      if (launchId === undefined) {
        api.restartMediaConversation = async (job: MediaJob, body: Record<string, unknown>) => {
          assert.equal(body.expectedPromptLeafId, later.id);
          assert.equal(body.expectedPromptRevision, tree.mutationRevision);
          applyMediaJob({ ...job, revision: job.revision + 1, prompt: '' });
          return api.conversation(777);
        };
        await controls.get('Restart prompt conversation')!.onClick!();
        assert.equal(frame.mediaPromptSelection(), null, 'Restart clears the selected old reply');
        assert.equal(
          controls.get('prompt-conversation')!.session!.state.tree.conversationId,
          null,
          'Restart discards the local tree and resubscribes even when the conversation ID is unchanged',
        );
      }
      dispose();
    }

    const savedReply = {
      id: 7780,
      conversationId: 778,
      parentId: null,
      activeChildId: 7781,
      role: 'assistant',
      status: 'done',
      content: 'Prompt:\n> ```text\n> Blue sky\n> Still camera\n> ```\nExplanation.',
      reasoning: null,
      model: null,
      name: null,
      genMeta: null,
      generationKind: 'normal',
      generationToken: null,
      media: [],
      activeImage: 0,
      imagePending: false,
      hasImageRender: false,
      createdAt: 1,
    } as Message;
    const laterReply = {
      ...savedReply,
      id: 7781,
      parentId: savedReply.id,
      activeChildId: null,
      content: 'Later reply',
    };
    const savedTree = {
      t: 'tree',
      conversationId: 778,
      messages: [savedReply, laterReply],
      activeLeafId: laterReply.id,
      mutationRevision: 1,
    } as const;
    for (const excerpt of [undefined, 'Blue sky\nStill camera']) {
      const saved = makeJob(480, {
        state: 'succeeded',
        submitted: true,
        startedAt: 1,
        prompt: excerpt ?? savedReply.content,
        promptMessageId: savedReply.id,
        draft: { ...makeJob(480).draft!, conversationId: 778 },
      });
      // A fresh frame has no memory of the earlier selection; the job may also need fetching.
      dialogStack.restore(parsePageLocation('#'));
      setState('mediaJobs', saved.id, undefined!);
      api.mediaJob = async (id: number) => (id === saved.id ? saved : state.mediaJobs[id]);
      dialogStack.restore(parsePageLocation('#+/media/job/480'));
      location.hash = '#+/media/job/480';
      dispose = mount();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      handleServerEvent(savedTree);
      const restoredRender = nextAction();
      controls.get('render-media')!.onClick!();
      assert.equal(
        (await restoredRender).prompt,
        saved.prompt,
        'A cold reopen renders the saved prompt instead of the newer reply',
      );
      assert.equal(actionOptions?.promptMessageId, savedReply.id);
      assert.equal(actionOptions?.promptExcerpt, excerpt);
      await Promise.resolve();
      await Promise.resolve();
      controls.get('Use latest reply')!.onClick!();
      dispose();
      dispose = mount();
      await Promise.resolve();
      await Promise.resolve();
      handleServerEvent(savedTree);
      const latestRender = nextAction();
      controls.get('render-media')!.onClick!();
      assert.equal(
        (await latestRender).prompt,
        laterReply.content,
        'An explicit Use latest reply choice survives hot reload',
      );
      assert.equal(actionOptions?.promptMessageId, laterReply.id);
      await Promise.resolve();
      await Promise.resolve();
      dispose();
    }
    api.mediaJob = async (id: number) => state.mediaJobs[id];

    const avatarPath = '../../client/src/images/AvatarGenerateModal.tsx';
    const { default: AvatarGenerateModal } = await import(avatarPath);
    let avatarJobId = 600;
    let discardCount = 0;
    api.discardMediaDraft = async () => {
      discardCount++;
    };
    for (const promptInput of [false, true]) {
      const avatarWorkflow = {
        ...a,
        inputBindings: {},
        json: promptInput
          ? '{"output":{"inputs":{"text":"{{prompt}}"}}}'
          : '{"output":{"inputs":{}}}',
      };
      setState('settings', 'mediaRendering', 'workflows', [avatarWorkflow]);
      setState('settings', 'mediaRendering', 'avatarWorkflowId', avatarWorkflow.id);
      api.createMediaJob = async (draft: MediaJobDraft) => {
        assert.deepEqual(draft.avatarContext, { kind: 'persona', id: 1 });
        assert.equal(draft.prompt, '');
        return makeJob(avatarJobId++, {
          avatarContext: draft.avatarContext,
          workflowId: avatarWorkflow.id,
        });
      };
      let started!: () => void;
      const avatarStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      api.mediaJobAction = async (
        ...[job, action, options]: Parameters<
          typeof import('../../client/src/state/api.ts').api.mediaJobAction
        >
      ) => {
        assert.equal(action, promptInput ? 'prepare' : 'render');
        assert.equal(options?.autoRender, true);
        started();
        return {
          ...job,
          revision: 2,
          startedAt: 1,
          state: promptInput ? 'preparing' : 'submitting',
        };
      };
      createRoot((cleanup) => {
        dispose = cleanup;
        untrack(() => AvatarGenerateModal({ kind: 'persona', id: 1, onClose: () => dispose() }));
      });
      await avatarStarted;
      await Promise.resolve();
      await Promise.resolve();
      dispose();
      await Promise.resolve();
      assert.equal(discardCount, 0, 'Closing a started avatar leaves its shared job running');
    }
  } finally {
    dispose();
    dialogStack.restore(parsePageLocation('#'));
    Object.assign(api, originalApi);
  }
});
