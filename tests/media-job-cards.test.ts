import assert from 'node:assert/strict';
import { compileMediaWorkflow, type MediaJob, type MediaWorkflow } from '@tinytavern/shared';
import { groupMediaJobs, jobPromptExcerpt } from '../client/src/media/jobCards.ts';
import { mediaWorkflowView } from '../client/src/media/workflowDefaults.ts';

function job(id: string, overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    id,
    characterIds: [],
    workflowValues: {},
    draft: null,
    revision: 1,
    operation: 'video',
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
  id: 'variations',
  revision: 1,
  state: 'open' as const,
  selectedAssetId: null,
  savedAssetIds: [],
};
const running = job('running', { draft, state: 'rendering', createdAt: 2 });
const newer = job('newer', { draft, createdAt: 3 });
const complete = job('complete', { draft, state: 'succeeded' });
const standalone = job('standalone', { createdAt: 4 });
let groups = groupMediaJobs([
  complete,
  newer,
  standalone,
  running,
  job('description', { operation: 'image-describe', createdAt: 10 }),
]);
assert.deepEqual(
  groups.map((group) => group.id),
  ['standalone', 'variations'],
);
assert.equal(groups[1]!.job.id, 'running', 'An older active variation remains visible');
assert.equal(groups[1]!.jobs.length, 3, 'All variations remain available to the card');
running.state = 'succeeded';
groups = groupMediaJobs([newer, running, complete]);
assert.equal(groups[0]!.job.id, 'newer');

const long = 'x'.repeat(1000);
assert.deepEqual(
  jobPromptExcerpt(job('thinking', { state: 'preparing', reasoning: `${long}new reasoning` })),
  { label: 'Thinking…', text: `…${long.slice(-407)}new reasoning` },
);
const writing = jobPromptExcerpt(
  job('writing', {
    state: 'preparing',
    prompt: `${long}new prompt`,
    reasoning: 'hidden reasoning',
  }),
);
assert.equal(writing.label, 'Writing prompt…');
assert(writing.text.endsWith('new prompt'));
assert(writing.text.length <= 421);
assert.equal(
  jobPromptExcerpt(
    job('ready', { state: 'ready', prompt: `Prompt ${long}`, instruction: 'instruction' }),
  ).text,
  `Prompt ${long.slice(0, 413)}…`,
);
assert.equal(
  jobPromptExcerpt(job('draft', { instruction: 'Use this character' })).text,
  'Use this character',
);

const snapshot: MediaWorkflow = {
  id: 'render-workflow',
  name: 'Captured workflow',
  operation: 'video',
  referenceCount: 0,
  chatPromptPresetId: null,
  galleryPromptPresetId: null,
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
const captured = job('captured', {
  state: 'rendering',
  workflowId: snapshot.id,
  workflowSnapshot: snapshot,
  workflowValues: { duration: 7 },
});
const localValues = { duration: 20 };
const locked = mediaWorkflowView(captured, other.id, [edited, other], localValues, true);
assert.equal(locked.id, snapshot.id, 'Locked selection follows the running variation');
assert.equal(locked.workflow, snapshot, 'Edited saved settings cannot replace the captured graph');
assert.deepEqual(
  locked.values,
  { duration: 7 },
  'Locked values cannot come from a stale local draft',
);
assert.equal(compileMediaWorkflow(locked.workflow!.json).controls[0]!.value, 5);
assert.equal(
  mediaWorkflowView(captured, other.id, [], localValues, true).workflow,
  snapshot,
  'Deleted workflows remain visible from the job snapshot',
);
assert.equal(mediaWorkflowView(captured, other.id, [other], localValues, false).workflow, other);
assert.equal(
  mediaWorkflowView(captured, other.id, [other], localValues, false).values,
  localValues,
  'Unlocked edits retain their local values',
);
const defaulted = mediaWorkflowView(
  job('defaults', { workflowSnapshot: snapshot }),
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
console.log(
  'Media cards preserve active variations and bounded streaming excerpts; locked workflow controls use captured job settings.',
);
