import assert from 'node:assert/strict';
import { test } from 'bun:test';

test('gallery detail drafts survive cancelled navigation and failed saves', async () => {
  const { createRoot } = await import('solid-js');
  const { createSettingsNavigation } = await import('../../client/src/state/settingsSubmission.ts');
  const { createGalleryDetailEditor } =
    await import('../../client/src/components/gallery/galleryDetailEditor.ts');
  let saved = { prompt: 'Original prompt', characterIds: [1] };
  let fail = false;
  let error = '';
  let destination = '';
  let dispose!: () => void;
  const { editor, navigation } = createRoot((cleanup) => {
    dispose = cleanup;
    const editor = createGalleryDetailEditor({
      value: () => saved,
      generating: () => false,
      submit: async (value, expected) => {
        assert.deepEqual(expected, saved, 'Save checks the prompt and character baseline');
        if (fail) throw new Error('Save failed');
        saved = value;
        return saved;
      },
      onError: (message) => {
        error = message;
      },
    });
    const navigation = createSettingsNavigation();
    navigation.register({
      isDirty: editor.dirty,
      saving: editor.saving,
      save: editor.save,
      discard: editor.discard,
    });
    return { editor, navigation };
  });
  try {
    editor.setPrompt('Edited prompt');
    editor.setCharacterIds([2]);
    const leave = () => {
      destination = 'next image';
    };
    navigation.navigate(leave);
    assert(navigation.promptOpen());
    assert.equal(destination, '', 'A dirty detail cannot be replaced before confirmation');
    navigation.cancel();
    assert.equal(editor.prompt(), 'Edited prompt');
    assert.deepEqual(editor.characterIds(), [2]);
    fail = true;
    navigation.navigate(leave);
    await navigation.save();
    assert.equal(destination, '', 'Persistence failure keeps the detail mounted');
    assert.equal(error, 'Save failed');
    assert(editor.dirty());
    fail = false;
    navigation.navigate(leave);
    await navigation.save();
    assert.equal(destination, 'next image');
    assert.deepEqual(saved, { prompt: 'Edited prompt', characterIds: [2] });
    assert.equal(editor.dirty(), false);

    editor.setPrompt('Discard this');
    saved = { prompt: 'Updated elsewhere', characterIds: [3] };
    navigation.navigate(() => {
      destination = 'gallery grid';
    });
    navigation.discard();
    assert.equal(destination, 'gallery grid');
    assert.equal(editor.prompt(), saved.prompt);
    assert.deepEqual(editor.characterIds(), saved.characterIds);
    assert.equal(editor.dirty(), false);
  } finally {
    dispose();
  }
});

test('pinch translation and release preserve the pan origin', async () => {
  const { createPanZoom } = await import('../../client/src/panZoom.ts');
  const camera = { x: 0, y: 0, scale: 1 };
  const point = (clientX: number, clientY = 0) => ({ clientX, clientY });
  const gesture = createPanZoom(
    camera,
    () => {},
    (_x, _y, scale) => {
      camera.scale = scale;
    },
  );
  gesture.startPan(point(10, 20));
  gesture.pan(point(30, 50));
  gesture.startPinch(point(0), point(10));
  gesture.pinch(point(0), point(20));
  gesture.pinch(point(10), point(30));
  assert.deepEqual(camera, { x: 35, y: 30, scale: 2 });
  gesture.startPan(point(10));
  gesture.pan(point(12, 3));
  assert.deepEqual(camera, { x: 37, y: 33, scale: 2 });
  gesture.startPinch(point(0), point(0));
  gesture.pinch(point(0), point(20));
  assert.equal(camera.scale, 2);
});

// Model browser scroll clamping for both chat and prompt streaming.
function scrollArea(clientHeight: number, scrollHeight: number) {
  let top = 0;
  return {
    isConnected: true,
    clientHeight,
    scrollHeight,
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    },
  };
}

test('gallery layout', async () => {
  type GalleryItem = import('@tinytavern/shared').GalleryItem;
  const { filterGallery, indexGallery, layoutGallery, visibleGalleryRows } =
    await import('../../client/src/galleryModel.ts');

  const items: GalleryItem[] = Array.from({ length: 5000 }, (_, index) => ({
    id: index + 1,
    characters: index % 2 ? [{ id: 7, name: 'Ashina' }] : [],
    characterName: index % 2 ? 'Ashina' : 'Uploads',
    sourceMessageId: null,
    sourceConversationId: null,
    sourceImage: null,
    prompt: index % 3 ? 'Blue forest at night' : 'Warm sunlight',
    image: `/images/${index}.png`,
    imageWidth: [600, 1200, 1000, 2000][index % 4]!,
    imageHeight: 1000,
    createdAt: index,
    updatedAt: index,
  }));
  for (const width of [320, 768, 1920]) {
    for (const size of [140, 240, 320]) {
      const layout = layoutGallery(items, width, size);
      assert.equal(layout.rowById.size, items.length);
      assert.equal(layout.rows.flatMap((row) => row.cells).length, items.length);
      let end = -8;
      for (const [index, row] of layout.rows.entries()) {
        assert(row.height > 0);
        assert(Math.abs(row.top - (end + 8)) < 1e-7);
        end = row.top + row.height;
        let right = -8;
        for (const cell of row.cells) {
          assert(Math.abs(cell.left - (right + 8)) < 1e-7);
          assert(
            Math.abs(cell.width / row.height - cell.item.imageWidth! / cell.item.imageHeight!) <
              1e-7,
          );
          assert.equal(layout.rowById.get(cell.item.id), index);
          right = cell.left + cell.width;
        }
        assert(right <= width + 1e-7, 'No row overflows the viewport');
        if (index < layout.rows.length - 1)
          assert(Math.abs(right - width) < 1e-7, 'Complete rows fill the width');
      }
      const visible = visibleGalleryRows(layout.rows, 20000, 700);
      assert(
        visible.end - visible.start < 35,
        'DOM work remains bounded independently of collection size',
      );
      assert(layout.rows[visible.start]!.top <= 20000);
      assert(Math.abs(layout.height - end) < 1e-7);
    }
  }
  assert.equal(layoutGallery([], 1000, 240).height, 0);
  assert.equal(layoutGallery(items, 0, 240).height, 0);
  assert(
    layoutGallery(
      items.slice(0, 100).map((item) => ({ ...item, imageWidth: 1, imageHeight: 100000 })),
      320,
      240,
    ).rows.every((row) => row.height > 0),
    'Extreme portrait dimensions never produce zero-height rows',
  );
  assert.equal(
    layoutGallery(items.slice(0, 1), 1920, 240).rows[0]!.height,
    240,
    'Sparse final rows do not balloon',
  );
  const index = indexGallery(items);
  const filtered = filterGallery(index, 'NIGHT blue', 'id:7', true);
  assert(
    filtered.every(
      (item) =>
        item.characters.some((character) => character.id === 7) &&
        item.prompt === 'Blue forest at night',
    ),
  );
  assert(filtered[0]!.id < filtered[1]!.id);
  assert.equal(filterGallery(index, 'absent', 'all', false).length, 0);
  assert.equal(filterGallery(index, '', 'name:Uploads', false).length, 2500);

  const combined = {
    ...items[1]!,
    characters: [
      { id: 7, name: 'Ashina' },
      { id: 8, name: 'Haeun' },
    ],
    characterName: 'Ashina, Haeun',
  };
  const combinedIndex = indexGallery([combined]);
  assert.equal(filterGallery(combinedIndex, '', 'id:7', false).length, 1);
  assert.equal(filterGallery(combinedIndex, '', 'id:8', false).length, 1);
  assert.equal(filterGallery(combinedIndex, '', 'id:9', false).length, 0);
});

test('media job cards', async () => {
  const { compileMediaWorkflow } = await import('@tinytavern/shared');
  type MediaJob = import('@tinytavern/shared').MediaJob;
  type MediaWorkflow = import('@tinytavern/shared').MediaWorkflow;
  const {
    groupMediaJobs,
    jobPromptExcerpt,
    mediaJobPreviews,
    mediaVariations,
    mediaVariationIndex,
  } = await import('../../client/src/media/jobCards.ts');

  const { createMediaWorkflowControls, mediaWorkflowView } =
    await import('../../client/src/media/workflowDefaults.ts');
  const { createRoot, createSignal } = await import('solid-js');

  function job(id: number, overrides: Partial<MediaJob> = {}): MediaJob {
    return {
      id,
      characterIds: [],
      workflowValues: {},
      draft: null,
      revision: 1,
      textResult: null,
      temporary: false,
      workflowId: null,
      workflowSnapshot: null,
      presetId: null,
      state: 'draft',
      instruction: '',
      prompt: '',
      inputs: [],
      assets: [],
      outputs: [],
      contextConversationId: null,
      messageId: null,
      destination: 'gallery',
      sourceJobId: null,
      seed: null,
      comfyPromptId: null,
      submitted: false,
      retrievalAvailable: false,
      error: null,
      cleanupPending: 0,
      createdAt: 1,
      updatedAt: 1,
      startedAt: null,
      ...overrides,
    };
  }
  const draft = {
    id: 4,
    revision: 1,
    state: 'open' as const,
    selectedAssetId: null,
    savedAssetIds: [],
  };
  const running = job(1, { draft, state: 'rendering', createdAt: 2 });
  const newer = job(2, { draft, createdAt: 3 });
  const complete = job(3, { draft, state: 'succeeded' });
  const standalone = job(4, { createdAt: 4 });
  let groups = groupMediaJobs([
    complete,
    newer,
    standalone,
    running,
    job(5, { temporary: true, createdAt: 10 }),
  ]);
  assert.deepEqual(
    groups.map((group) => group.id),
    [4, -4],
  );
  assert.equal(groups[1]!.job.id, 1, 'An older active variation remains visible');
  assert.equal(groups[1]!.jobs.length, 3, 'All variations remain available to the card');
  const asset = { id: 42 } as import('@tinytavern/shared').MediaAsset;
  complete.outputs = [asset];
  const previews = mediaJobPreviews([running, newer, complete]);
  assert.deepEqual(
    previews.results,
    [{ job: complete, asset }],
    'Only completed outputs count as variations',
  );
  assert.deepEqual(
    previews.pending,
    [running],
    'A rendering alternative has its own tile beside completed results',
  );
  const queue = mediaVariations([newer, running, complete]);
  assert.deepEqual(
    queue.map((item) => item.job.id),
    [3, 1, 2],
  );
  assert.equal(
    mediaVariationIndex(queue, { jobId: running.id }, asset.id),
    1,
    'A pending variation is selectable beside the finished result',
  );
  running.state = 'succeeded';
  running.outputs = [{ ...asset, id: 43 }];
  const finishedQueue = mediaVariations([newer, running, complete]);
  assert.equal(
    mediaVariationIndex(finishedQueue, { jobId: running.id }, asset.id),
    1,
    'The selected WIP stays selected when its output arrives',
  );
  assert.equal(
    mediaVariationIndex(finishedQueue, { jobId: complete.id, assetId: asset.id }, 43),
    0,
    'Another completion cannot steal the preview from the viewed result',
  );
  newer.state = 'failed';
  assert.equal(
    mediaVariations([newer, running, complete]).length,
    3,
    'A failed attempt keeps its slot in the selector',
  );
  groups = groupMediaJobs([newer, running, complete]);
  assert.equal(groups[0]!.job.id, 2);
  newer.state = 'cancelled';
  const afterCancel = mediaVariations([newer, running, complete]);
  assert.equal(afterCancel.length, 2, 'Cancellation removes the variation instead of a tombstone');
  assert.equal(
    mediaVariationIndex(afterCancel, { jobId: newer.id }, null),
    1,
    'Removing the viewed variation selects a remaining result',
  );
  assert.equal(groupMediaJobs([newer, running, complete])[0]!.job.id, running.id);
  assert.deepEqual(groupMediaJobs([newer]), [], 'A cancelled-only draft leaves no job card');
  assert.equal(
    mediaVariationIndex(
      mediaVariations([{ ...complete, outputs: [asset, { ...asset, id: 44 }] }]),
      { jobId: complete.id, assetId: 44 },
      asset.id,
    ),
    1,
    'A linked result ID selects the exact output ahead of shared draft selection',
  );

  const long = 'x'.repeat(1000);
  assert.equal(
    jobPromptExcerpt(job(6, { state: 'preparing', reasoning: `${long}new reasoning` })).text,
    `${long}new reasoning`,
  );
  const writing = jobPromptExcerpt(
    job(7, {
      state: 'preparing',
      prompt: `${long}new prompt`,
      reasoning: 'hidden reasoning',
    }),
  );
  assert.equal(writing.text, `${long}new prompt`);
  for (const [overrides, text] of [
    [{ state: 'ready', prompt: `Prompt ${long}`, instruction: 'instruction' }, `Prompt ${long}`],
    [{ instruction: 'Use this character' }, 'Use this character'],
  ] as const)
    assert.equal(jobPromptExcerpt(job(8, overrides)).text, text);

  const snapshot: MediaWorkflow = {
    id: 'render-workflow',
    name: 'Captured workflow',
    inputBindings: {},
    textOutputNodeId: null,
    chatPromptPresetId: null,
    standalonePromptPresetId: null,
    json: JSON.stringify({
      duration: {
        class_type: 'PrimitiveInt',
        _meta: { title: 'Duration [input]' },
        inputs: { value: 5 },
      },
    }),
  };
  const edited = { ...snapshot, name: 'Edited workflow', json: snapshot.json.replace('5', '9') };
  const other = { ...snapshot, id: 'other-workflow' };
  const captured = job(10, {
    state: 'rendering',
    workflowId: snapshot.id,
    workflowSnapshot: snapshot,
    workflowValues: { duration: 7 },
  });
  const localValues = { duration: 20 };
  // Captured selection and values survive both editing and deleting the saved workflow.
  for (const workflows of [[edited, other], []]) {
    const locked = mediaWorkflowView(captured, other.id, workflows, localValues, true);
    assert.deepEqual(locked, { id: snapshot.id, workflow: snapshot, values: { duration: 7 } });
    assert.equal(locked.workflow, snapshot, 'Keep the captured graph identity');
  }
  const unlocked = mediaWorkflowView(captured, other.id, [other], localValues, false);
  assert.equal(unlocked.workflow, other);
  assert.equal(unlocked.values, localValues, 'Unlocked edits retain their local values');
  const defaulted = mediaWorkflowView(
    job(11, { workflowSnapshot: snapshot }),
    snapshot.id,
    [edited],
    {},
    true,
  );
  assert.equal(
    compileMediaWorkflow(defaulted.workflow!.json).controls[0]!.value,
    5,
    'Omitted overrides use captured control defaults',
  );
  createRoot((dispose) => {
    try {
      const [view, setView] = createSignal(unlocked);
      const controls = createMediaWorkflowControls(() => view().workflow?.json);
      const initial = controls();
      setView({ ...unlocked, workflow: { ...other }, values: { duration: 30 } });
      assert.equal(
        controls(),
        initial,
        'Refreshing job metadata or values preserves every workflow control identity',
      );
      setView({ ...unlocked, workflow: edited });
      assert.notEqual(controls(), initial);
      assert.equal(controls().controls[0]!.value, 9, 'Changed graphs rebuild controls');
      setView({ ...unlocked, workflow: { ...edited, json: '{' } });
      assert.ok(controls().error);
      assert.equal(controls().controls.length, 0);
      setView(unlocked);
      assert.equal(controls().error, '');
      assert.equal(controls().controls[0]!.value, 5);
    } finally {
      dispose();
    }
  });
});

test('chat scroll', async () => {
  const { createChatScroll } = await import('../../client/src/chatScroll.ts');

  // Model native clamping when reparsing Markdown shrinks a message. Scroll events
  // and ResizeObserver callbacks may arrive in either order around the next render.
  function fixture() {
    const element = scrollArea(200, 1000);
    const scroll = createChatScroll(element);
    scroll.follow();
    scroll.onScroll();
    return {
      element,
      scroll,
      resize(value: number) {
        element.scrollHeight = value;
        element.scrollTop = element.scrollTop;
      },
    };
  }

  for (const notifyBeforeFollow of [true, false]) {
    const { element, scroll, resize } = fixture();
    resize(700);
    if (notifyBeforeFollow) scroll.onScroll();
    scroll.follow();
    scroll.onScroll();
    resize(1100);
    scroll.follow();
    assert.equal(element.scrollTop, 900, 'Markdown contraction must not stop later following');
  }

  {
    const { element, scroll, resize } = fixture();
    // Browser anchoring can also adjust the offset away from the bottom.
    element.scrollTop = 650;
    scroll.onScroll();
    resize(1100);
    scroll.follow();
    assert.equal(element.scrollTop, 900, 'layout movement alone must not pause following');
  }

  {
    const { element, scroll, resize } = fixture();
    // Input intent precedes its scroll event; a queued programmatic scroll event
    // and a streaming resize between them must not swallow that intent.
    scroll.pause();
    scroll.onScroll();
    resize(1100);
    scroll.follow();
    assert.equal(element.scrollTop, 800);
    element.scrollTop = 750;
    scroll.onScroll();
    resize(1200);
    scroll.follow();
    assert.equal(element.scrollTop, 750, 'streaming must respect reading older content');

    element.scrollTop = 1000;
    scroll.onScroll();
    resize(1300);
    scroll.follow();
    assert.equal(element.scrollTop, 1100, 'scrolling down to the bottom resumes following');
  }

  {
    const { element, scroll, resize } = fixture();
    scroll.pause();
    element.scrollTop = 799.5;
    scroll.onScroll();
    resize(1100);
    scroll.follow();
    assert.equal(element.scrollTop, 799.5, 'fractional upward input beats bottom tolerance');

    resize(600);
    scroll.onScroll();
    resize(1000);
    scroll.follow();
    assert.equal(element.scrollTop, 400, 'a contraction must not resume paused following');

    scroll.reset();
    scroll.follow();
    assert.equal(element.scrollTop, 800, 'opening a conversation resets following');
  }
});

test('stream scroll', async () => {
  const { createStreamScroll } = await import('../../client/src/streamScroll.ts');

  const area = scrollArea(100, 400);
  let element: typeof area | undefined;
  const frames = new Map<number, () => void>();
  let sequence = 0;
  const scroll = createStreamScroll(
    () => element,
    (callback) => {
      frames.set(++sequence, callback);
      return sequence;
    },
    (frame) => {
      frames.delete(frame);
    },
  );
  function paint() {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback();
  }
  scroll.update(null, true);
  assert.equal(frames.size, 0, 'Normal prompt edits do not trigger scrolling');
  scroll.update('job-a', false); // Reasoning is displayed; the textarea does not exist yet.
  scroll.update('job-a', true);
  element = area; // Solid mounts the prompt textarea before the animation frame.
  scroll.update('job-a', true);
  scroll.update('job-a', true);
  assert.equal(frames.size, 1, 'Token updates coalesce into one layout read/write per frame');
  paint();
  assert.equal(area.scrollTop, 300);
  scroll.onScroll();
  area.scrollHeight = 600;
  scroll.update('job-a', true);
  paint();
  assert.equal(area.scrollTop, 500, 'Actual prompt text follows each streamed chunk');
  scroll.update('job-a', true);
  area.scrollTop = 200;
  scroll.onScroll();
  paint();
  assert.equal(area.scrollTop, 200, 'Scrolling up cancels a queued jump to the bottom');
  area.scrollHeight = 800;
  scroll.update('job-a', true);
  assert.equal(frames.size, 0, 'Manual reading remains undisturbed as tokens arrive');
  area.scrollTop = 700;
  scroll.onScroll();
  area.scrollHeight = 900;
  scroll.update('job-a', true);
  paint();
  assert.equal(area.scrollTop, 800, 'Scrolling back to the bottom resumes following');
  area.scrollHeight = 1000;
  scroll.update(null, true);
  scroll.update(null, true);
  paint();
  assert.equal(area.scrollTop, 900, 'The final completion snapshot is followed too');
  area.scrollTop = 100;
  scroll.onScroll();
  scroll.update(null, true);
  assert.equal(frames.size, 0, 'Completed prompt editing retains the cursor position');
  scroll.update('job-b', true);
  paint();
  assert.equal(area.scrollTop, 900, 'A new generation starts following again');
  scroll.update('job-b', true);
  scroll.update('job-b', false);
  assert.equal(frames.size, 0, 'Covered panes and pickers cancel pending scrolling');
  area.scrollHeight = 1100;
  scroll.update('job-b', true);
  paint();
  assert.equal(area.scrollTop, 1000, 'An uncovered pane catches up with the stream');
  scroll.update('job-b', true);
  scroll.dispose();
  assert.equal(frames.size, 0, 'Unmount releases pending animation callbacks');
});
