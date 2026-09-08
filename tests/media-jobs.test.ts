import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { requireTestIsolation } from './isolation.ts';
import type { MediaJob, MediaWorkflow } from '@tinytavern/shared';

requireTestIsolation();
process.env.COMFY_POLL_MS = '5';

const { stmt, IMAGES_DIR, mediaAssetForPath } = await import('../server/src/db.ts');
const { makePlaceholderPng } = await import('../server/src/pngCard.ts');
const { saveImage, deleteImageFiles } = await import('../server/src/images.ts');
const { getSettings, putSettings } = await import('../server/src/settingsStore.ts');
const { requireMediaJob, mediaJobRow, mediaJobDto, updateMediaJob, observeMediaJob } =
  await import('../server/src/mediaJobStore.ts');
const {
  createMediaJob,
  createMediaJobFromAsset,
  editMediaJob,
  startMediaJob,
  cancelMediaJob,
  retryMediaRetrieval,
} = await import('../server/src/mediaJobs.ts');
const { initMediaWorker, tickMediaWorker, stopMediaWorker } =
  await import('../server/src/mediaWorker.ts');
const { drainRemoteCleanup } = await import('../server/src/mediaRemote.ts');
const { startMessageImageRender } = await import('../server/src/mediaImageAdapter.ts');
const { appendMessage, getMessage } = await import('../server/src/tree.ts');

const raster = makePlaceholderPng();
const base = 'http://127.0.0.1:1';
const imageWorkflow: MediaWorkflow = {
  id: 'image',
  name: 'Image',
  operation: 'image',
  referenceCount: 0,
  json: '{"1":{"class_type":"Text","inputs":{"text":"{{prompt}}","seed":{{seed}}}},"9":{"class_type":"SaveImage","inputs":{"filename_prefix":"{{job_id}}"}}}',
  galleryPromptPresetId: null,
  chatPromptPresetId: null,
};
const editWorkflow: MediaWorkflow = {
  ...imageWorkflow,
  id: 'edit',
  name: 'Edit',
  operation: 'image-edit',
  referenceCount: 3,
  json: JSON.stringify({
    '1': { class_type: 'Text', inputs: { text: '{{prompt}}', seed: 123 } },
    reference3: { class_type: 'LoadImage', inputs: { image: 'reference3.png' } },
    reference1: { class_type: 'LoadImage', inputs: { image: 'samples/reference1.png' } },
    reference2: { class_type: 'LoadImage', inputs: { image: 'reference2.png [input]' } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: '{{job_id}}' } },
  }),
};
putSettings({
  ...getSettings(),
  mediaRendering: {
    comfyUrl: base,
    workflows: [imageWorkflow, editWorkflow],
    defaults: { 'image:0': imageWorkflow.id },
    avatarWorkflowId: null,
    jobTimeoutSeconds: 60,
  },
});

interface SubmittedJob {
  id: string;
  state: 'queued' | 'done' | 'cancelled';
  prompt: Record<string, { inputs: Record<string, unknown> }>;
  extra: Record<string, unknown>;
  extraOutput: 'image' | 'video' | null;
}
const submitted = new Map<string, SubmittedJob>();
const uploads: { name: string; subfolder: string; data: Buffer }[] = [];
const deleted = new Set<string>();
const deleteAttempts = new Map<string, number>();
let submitCount = 0;
let loseAcceptance = false;
let holdQueue = false;
let failDownloads = false;
let holdDownloads = false;
let downloadAborted = false;
let failDeletion = false;
let extraOutput: SubmittedJob['extraOutput'] = null;
let downloadCount = 0;
const cancellations: string[] = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, base, 'Tests never contact a live Comfy endpoint');
  if (url.pathname === '/upload/image') {
    const form = init!.body as FormData;
    const image = form.get('image') as File;
    const subfolder = String(form.get('subfolder'));
    uploads.push({ name: image.name, subfolder, data: Buffer.from(await image.arrayBuffer()) });
    return Response.json({ name: image.name, subfolder, type: 'input' });
  }
  if (url.pathname === '/prompt') {
    const body = JSON.parse(String(init!.body));
    submitCount++;
    assert(!submitted.has(body.prompt_id), 'A Comfy prompt is submitted at most once');
    submitted.set(body.prompt_id, {
      id: body.prompt_id,
      state: holdQueue ? 'queued' : 'done',
      prompt: body.prompt,
      extra: body.extra_data,
      extraOutput,
    });
    if (loseAcceptance) {
      loseAcceptance = false;
      throw new TypeError('Connection lost after Comfy accepted the job');
    }
    return Response.json({ prompt_id: body.prompt_id });
  }
  if (url.pathname === '/queue') {
    const queued = [...submitted.values()].filter((job) => job.state === 'queued');
    return Response.json({ queue_running: [], queue_pending: queued.map((job) => [1, job.id]) });
  }
  if (url.pathname.startsWith('/history/')) {
    const id = url.pathname.slice('/history/'.length);
    const job = submitted.get(id);
    if (!job || job.state === 'queued' || job.state === 'cancelled') {
      return Response.json({});
    }
    const output = (filename: string, type = 'output') => ({ filename, subfolder: id, type });
    return Response.json({
      [id]: {
        status: { completed: true, status_str: 'success' },
        outputs: {
          '9': { images: [output('first.png'), output('second.png')] },
          metadata: { files: [output('trace.json', 'temp')] },
          ...(job.extraOutput === 'image'
            ? { '10': { images: [output('preview.png', 'temp')] } }
            : job.extraOutput === 'video'
              ? { '10': { videos: [output('extra.webm')] } }
              : {}),
        },
      },
    });
  }
  if (url.pathname.endsWith('/cancel')) {
    const id = url.pathname.split('/')[3]!;
    cancellations.push(id);
    const job = submitted.get(id);
    if (job) {
      job.state = 'cancelled';
    }
    return Response.json({ cancelled: Boolean(job) });
  }
  if (url.pathname === '/view') {
    const identity = url.searchParams.toString();
    if (init?.method === 'DELETE') {
      deleteAttempts.set(identity, (deleteAttempts.get(identity) ?? 0) + 1);
      if (failDeletion) {
        return new Response('retry', { status: 503 });
      }
      deleted.add(identity);
      return new Response(null, { status: 204 });
    }
    downloadCount++;
    if (failDownloads && url.searchParams.get('filename') === 'second.png') {
      return new Response('temporary failure', { status: 503 });
    }
    if (holdDownloads) {
      return new Response(
        new ReadableStream({
          cancel() {
            downloadAborted = true;
          },
        }),
      );
    }
    return new Response(raster, { headers: { 'content-type': 'image/png' } });
  }
  throw new Error(`Unexpected mock Comfy request: ${url.pathname}`);
};

async function waitFor(id: string, state: MediaJob['state']): Promise<MediaJob> {
  // Completion is transient: capture its notification before automatic deletion.
  let completed: MediaJob | undefined;
  const unsubscribe = observeMediaJob(id, (row) => {
    if (row.state === 'succeeded') completed = mediaJobDto(row);
  });
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      tickMediaWorker();
      const row = mediaJobRow(id);
      const job = row ? mediaJobDto(row) : completed;
      if (job?.state === state) return job;
      await sleep(10);
    }
    assert.fail(`Job did not reach ${state}: ${JSON.stringify(mediaJobRow(id))}`);
  } finally {
    unsubscribe();
  }
}

function draft(requestKey: string, extra: Record<string, unknown> = {}) {
  return createMediaJob({ requestKey, operation: 'image', prompt: 'A landscape', ...extra });
}

try {
  initMediaWorker();
  const first = draft('idempotent');
  assert.equal(draft('idempotent').id, first.id);
  assert.throws(() => requireMediaJob(first.id, first.revision - 1), /changed/);
  loseAcceptance = true;
  failDeletion = true;
  startMediaJob(requireMediaJob(first.id), {}, false);
  const finished = await waitFor(first.id, 'succeeded');
  assert.equal(submitCount, 1, 'Lost acceptance is reconciled without another submission');
  assert.equal(finished.outputs.length, 2);
  for (const asset of finished.outputs) {
    assert.match(
      asset.url,
      new RegExp(`^/images/media-${asset.id}\\.(png|jpe?g|webp|webm)$`),
      'Worker outputs use ownership-neutral original names',
    );
  }
  assert.equal(stmt('SELECT count(*) AS n FROM gallery_items').get()!.n, 2);
  assert.deepEqual(readFileSync(join(IMAGES_DIR, basename(finished.outputs[0]!.url))), raster);
  assert.throws(() => requireMediaJob(first.id), { status: 404 });
  assert.equal(
    stmt('SELECT id FROM media_jobs WHERE request_key = ?').get('idempotent'),
    undefined,
    'Success deletes the full job, including its request key, even when remote cleanup fails',
  );
  assert.equal(
    stmt("SELECT owner_id FROM media_owners WHERE owner_type = 'job' AND owner_id = ?").get(
      first.id,
    ),
    undefined,
  );

  failDeletion = false;
  stmt("UPDATE media_remote_files SET retry_at = 0 WHERE state = 'pending'").run();
  await drainRemoteCleanup();
  assert(
    [...deleted].some(
      (identity) => identity.includes('trace.json') && identity.includes('type=temp'),
    ),
  );

  for (const kind of ['image', 'video'] as const) {
    extraOutput = kind;
    const invalid = draft(`multiple-${kind}-outputs`);
    const downloadsBefore = downloadCount;
    startMediaJob(requireMediaJob(invalid.id), {}, false);
    const failed = await waitFor(invalid.id, 'failed');
    assert.match(failed.error!, /multiple output nodes \(9, 10\)/);
    assert.equal(downloadCount, downloadsBefore, 'Multiple output nodes fail before downloading');
    assert.equal(failed.outputs.length, 0);
    assert.equal(requireMediaJob(invalid.id).retention_deadline, null);
    await drainRemoteCleanup();
    assert.equal(
      stmt(
        "SELECT count(*) AS n FROM media_remote_files WHERE job_id = ? AND state != 'deleted'",
      ).get(invalid.id)!.n,
      0,
      'Invalid workflows still clean every remote output, including temporary files',
    );
  }
  extraOutput = null;

  const sourcePath = saveImage('.png', raster);
  stmt(`
    INSERT INTO gallery_items(character_name, prompt, image, created_at, updated_at)
    VALUES ('Input', 'Saved source description', ?, 1, 1)
  `).run(sourcePath);
  const sourceId = mediaAssetForPath(sourcePath)!.id;
  const editInstruction = '  Preserve the face.\nChange the lighting to sunset.  ';
  const edit = draft('references', {
    instruction: editInstruction,
    operation: 'image-edit',
    workflowId: editWorkflow.id,
    inputs: [
      { slot: 'reference2', assetId: sourceId },
      { slot: 'reference3', assetId: sourceId },
      { slot: 'reference1', assetId: sourceId },
    ],
  });
  startMediaJob(requireMediaJob(edit.id), {}, false);
  const edited = await waitFor(edit.id, 'succeeded');
  assert.equal(uploads.length, 1, 'Repeated references upload only once per job');
  assert.deepEqual(uploads[0]!.data, raster);
  const graph = submitted.get(edited.comfyPromptId!)!.prompt;
  assert.equal(uploads[0]!.subfolder, '', 'Uploads do not leave per-job directories behind');
  const uploadedPath = `tinytavern-${edit.id}-asset-${sourceId}.png`;
  assert.equal(uploads[0]!.name, uploadedPath);
  assert.equal(graph.reference3!.inputs.image, uploadedPath);
  assert.equal(graph.reference1!.inputs.image, uploadedPath);
  assert.equal(graph.reference2!.inputs.image, uploadedPath);
  await drainRemoteCleanup();
  assert(
    deleted.has(
      new URLSearchParams({
        filename: uploadedPath,
        subfolder: '',
        type: 'input',
      }).toString(),
    ),
    'Cleanup deletes the exact uploaded file from the input root',
  );
  assert.throws(() => requireMediaJob(edit.id), { status: 404 });
  assert(
    existsSync(join(IMAGES_DIR, sourcePath.slice(8))),
    'Saved result recipes retain rerun inputs',
  );

  const renderingSettings = getSettings().mediaRendering;
  putSettings({
    ...getSettings(),
    mediaRendering: { ...renderingSettings, workflows: [imageWorkflow] },
  });
  const restored = createMediaJobFromAsset(edited.outputs[0]!.id, { requestKey: 'recipe-rerun' });
  assert.equal(restored.inputs.length, 3);
  assert.equal(
    restored.instruction,
    editInstruction,
    'Rerun restores the instruction after job deletion',
  );
  assert.equal(restored.workflowSnapshot?.json, editWorkflow.json);
  editMediaJob(requireMediaJob(restored.id), { prompt: 'A changed edit prompt' });
  startMediaJob(requireMediaJob(restored.id), {}, false);
  const restoredResult = await waitFor(restored.id, 'succeeded');
  assert.equal(uploads[1]!.name, `tinytavern-${restored.id}-asset-${sourceId}.png`);
  assert.notEqual(
    uploads[1]!.name,
    uploadedPath,
    'Separate jobs never overwrite each other’s inputs',
  );
  assert.equal(
    restoredResult.outputs.length,
    2,
    'Recipes rerun after job history and saved workflow deletion',
  );
  assert.equal(
    submitted.get(restoredResult.comfyPromptId!)!.prompt['1']!.inputs.text,
    'A changed edit prompt',
  );
  const conversationId = Number(
    stmt(`
    INSERT INTO conversations(title, created_at, updated_at) VALUES ('Image alternatives', 1, 1)
  `).run().lastInsertRowid,
  );
  const message = appendMessage(
    conversationId,
    'tool',
    'A new edit with literal {{seed}}',
    null,
    'done',
  );
  stmt('UPDATE messages SET images_json = ? WHERE id = ?').run(
    JSON.stringify([edited.outputs[0]!.url]),
    message.id,
  );
  const uploadsBeforeSwipe = uploads.length;
  const swipe = startMessageImageRender(getMessage(message.id)!);
  assert(
    getMessage(message.id)!.imagePending,
    'Starting a recipe swipe synchronously marks its message pending',
  );
  const swiped = await waitFor(swipe.id, 'succeeded');
  const updatedMessage = getMessage(message.id)!;
  assert.equal(swiped.messageId, message.id);
  assert.equal(updatedMessage.content, message.content);
  assert.equal(updatedMessage.status, 'done');
  assert.equal(
    updatedMessage.media.length,
    3,
    'All new recipe outputs append to the original image alternatives',
  );
  assert.equal(updatedMessage.activeImage, 2);
  assert.deepEqual(
    swiped.inputs,
    edited.inputs,
    'Image-edit swipes retain the source and ordered reference slots',
  );
  assert.equal(
    uploads.length,
    uploadsBeforeSwipe + 1,
    'Repeated recipe inputs still upload only once per swipe',
  );
  assert.equal(submitted.get(swiped.comfyPromptId!)!.prompt['1']!.inputs.text, message.content);
  assert.throws(() => requireMediaJob(swiped.id), { status: 404 });
  stmt("UPDATE messages SET images_json = '[]', active_image = 0 WHERE id = ?").run(message.id);
  deleteImageFiles(updatedMessage.media.map((asset) => asset.url));
  const emptyMessage = getMessage(message.id)!;
  assert(
    emptyMessage.hasImageRender,
    'Deleting the last image retains the message rendering recipe',
  );
  const emptySwipe = startMessageImageRender(emptyMessage);
  const recreated = await waitFor(emptySwipe.id, 'succeeded');
  assert.deepEqual(
    recreated.inputs,
    edited.inputs,
    'A recipe with no remaining outputs still retains its reference inputs',
  );
  assert.equal(getMessage(message.id)!.media.length, 2);
  putSettings({ ...getSettings(), mediaRendering: renderingSettings });

  const removedResult = restoredResult.outputs[0]!;
  stmt('DELETE FROM gallery_items WHERE image = ?').run(removedResult.url);
  deleteImageFiles([removedResult.url]);
  assert(
    !existsSync(join(IMAGES_DIR, basename(removedResult.url))),
    'Completed history does not keep a deleted result file alive',
  );
  assert.equal(
    stmt('SELECT id FROM media_assets WHERE id = ?').get(restoredResult.outputs[1]!.id)?.id,
    restoredResult.outputs[1]!.id,
    'Deleting one result retains the other destination-owned result',
  );

  holdQueue = true;
  const pending = draft('cancel');
  startMediaJob(requireMediaJob(pending.id), {}, false);
  await waitFor(pending.id, 'queued');
  const pendingId = requireMediaJob(pending.id).comfy_prompt_id!;
  cancelMediaJob(requireMediaJob(pending.id));
  await waitFor(pending.id, 'cancelled');
  assert.deepEqual(cancellations, [pendingId], 'Cancellation targets only the recorded job');

  putSettings({ ...getSettings(), mediaRendering: { ...renderingSettings, jobTimeoutSeconds: 0 } });
  const unlimited = draft('unlimited');
  startMediaJob(requireMediaJob(unlimited.id), {}, false);
  await waitFor(unlimited.id, 'queued');
  assert.equal(
    requireMediaJob(unlimited.id).deadline,
    null,
    'Unlimited Comfy jobs have no wall-clock deadline',
  );
  cancelMediaJob(requireMediaJob(unlimited.id));
  await waitFor(unlimited.id, 'cancelled');
  putSettings({ ...getSettings(), mediaRendering: renderingSettings });

  const expired = draft('expired');
  startMediaJob(requireMediaJob(expired.id), {}, false);
  await waitFor(expired.id, 'queued');
  updateMediaJob(expired.id, { deadline: Date.now() - 1 });
  const expiredResult = await waitFor(expired.id, 'cancelled');
  assert(expiredResult.error?.includes('time limit'), 'The overall deadline cancels queued work');

  holdQueue = false;
  holdDownloads = true;
  const interruptedDownload = draft('cancel-download');
  startMediaJob(requireMediaJob(interruptedDownload.id), {}, false);
  await waitFor(interruptedDownload.id, 'downloading');
  cancelMediaJob(requireMediaJob(interruptedDownload.id));
  await waitFor(interruptedDownload.id, 'cancelled');
  assert(
    downloadAborted,
    'Cancel interrupts an in-flight download rather than waiting for its request timeout',
  );
  holdDownloads = false;

  holdQueue = false;
  failDownloads = true;
  const partial = draft('partial');
  startMediaJob(requireMediaJob(partial.id), {}, false);
  const failed = await waitFor(partial.id, 'failed');
  assert.equal(failed.outputs.length, 1, 'Partial ingestion remains durable');
  const countBeforeRetry = submitCount;
  failDownloads = false;
  retryMediaRetrieval(requireMediaJob(partial.id));
  const retried = await waitFor(partial.id, 'succeeded');
  assert.equal(retried.outputs.length, 2);
  assert.equal(submitCount, countBeforeRetry, 'Retrieval retry never resubmits the workflow');
  assert.equal(
    retried.outputs[0]!.id,
    failed.outputs[0]!.id,
    'Already-ingested results are reused',
  );

  const restart = draft('restart');
  holdQueue = true;
  startMediaJob(requireMediaJob(restart.id), {}, false);
  await waitFor(restart.id, 'queued');
  const restartRow = requireMediaJob(restart.id);
  stopMediaWorker();
  await sleep(30);
  submitted.get(restartRow.comfy_prompt_id!)!.state = 'done';
  updateMediaJob(restart.id, { state: 'reconciling', comfy_prompt_id: null });
  const countBeforeRestart = submitCount;
  initMediaWorker();
  await waitFor(restart.id, 'succeeded');
  assert.equal(submitCount, countBeforeRestart, 'Restart recovers the saved submission identity');
  assert.equal(stmt('PRAGMA foreign_key_check').all().length, 0);
  holdQueue = false;
  const controlledWorkflow = {
    ...imageWorkflow,
    id: 'controlled',
    json: JSON.stringify({
      text: { class_type: 'Text', inputs: { text: '{{prompt}}', seed: 123 } },
      frames: {
        class_type: 'PrimitiveInt',
        inputs: { value: 81 },
        _meta: { title: 'Frames [input: min=1, max=241, step=4]' },
      },
      style: {
        class_type: 'PrimitiveString',
        inputs: { value: '' },
        _meta: { title: 'Style [input]' },
      },
      resolution: {
        class_type: 'ResolutionSelector',
        inputs: { aspect_ratio: '1:1 (Square)', megapixels: 1, multiple: 16 },
        _meta: { title: 'Resolution [input]' },
      },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: '{{job_id}}' } },
    }),
  };
  const settings = getSettings();
  putSettings({
    ...settings,
    mediaRendering: {
      ...settings.mediaRendering,
      workflows: [...settings.mediaRendering.workflows, controlledWorkflow],
    },
  });
  const values = {
    frames: 121,
    style: 'literal {{prompt}} "quote"\n',
    'resolution.aspect_ratio': '3:2 (Photo)',
    'resolution.megapixels': 2.5,
  };
  assert.throws(
    () =>
      draft('bad-controls', { workflowId: controlledWorkflow.id, workflowValues: { frames: 82 } }),
    /steps/,
  );
  const controlled = draft('controlled', {
    workflowId: controlledWorkflow.id,
    workflowValues: values,
  });
  assert.deepEqual(controlled.workflowValues, values);
  assert.throws(
    () => editMediaJob(requireMediaJob(controlled.id), { workflowValues: { unknown: 1 } }),
    /Unknown workflow input/,
  );
  assert.deepEqual(
    mediaJobDto(requireMediaJob(controlled.id)).workflowValues,
    values,
    'Invalid edits do not change saved values',
  );
  const updatedWorkflow = {
    ...controlledWorkflow,
    json: controlledWorkflow.json.replace('"multiple":16', '"multiple":32'),
  };
  const updatedSettings = getSettings();
  putSettings({
    ...updatedSettings,
    mediaRendering: {
      ...updatedSettings.mediaRendering,
      workflows: updatedSettings.mediaRendering.workflows.map((workflow) =>
        workflow.id === controlledWorkflow.id ? updatedWorkflow : workflow,
      ),
    },
  });
  const fresh = draft('controlled-updated', {
    workflowId: controlledWorkflow.id,
    workflowValues: {},
  });
  startMediaJob(requireMediaJob(fresh.id), {}, false);
  const freshResult = await waitFor(fresh.id, 'succeeded');
  assert.equal(
    submitted.get(freshResult.comfyPromptId!)!.prompt.resolution!.inputs.multiple,
    32,
    'New jobs use edited source even when the workflow ID is unchanged',
  );
  startMediaJob(requireMediaJob(controlled.id), {}, false);
  const rendered = await waitFor(controlled.id, 'succeeded');
  const sent = submitted.get(rendered.comfyPromptId!)!.prompt;
  assert.equal(sent.frames!.inputs.value, values.frames);
  assert.equal(sent.style!.inputs.value, values.style);
  assert.equal(sent.text!.inputs.seed, rendered.seed);
  assert.deepEqual(sent.resolution!.inputs, {
    aspect_ratio: '3:2 (Photo)',
    megapixels: 2.5,
    multiple: 16,
  });
  const rerun = createMediaJobFromAsset(rendered.outputs[0]!.id, {
    requestKey: 'controlled-rerun',
  });
  assert.deepEqual(rerun.workflowValues, values, 'The durable asset recipe retains controls');
  assert.equal(
    rerun.workflowSnapshot!.json,
    controlledWorkflow.json,
    'Reruns retain their persisted original graph after the saved workflow changes',
  );
  const editedControls = editMediaJob(requireMediaJob(rerun.id), {
    workflowValues: { ...values, frames: 161 },
  });
  assert.equal(editedControls.workflowValues.frames, 161);
  const switched = editMediaJob(requireMediaJob(rerun.id), {
    workflowId: imageWorkflow.id,
    workflowValues: {},
  });
  assert.deepEqual(switched.workflowValues, {});
} finally {
  stopMediaWorker();
  await sleep(30);
  globalThis.fetch = originalFetch;
}

console.log(
  'Media jobs cover submission reconciliation, pinned/deduplicated inputs, targeted cancellation, partial retrieval, cleanup and restart recovery',
);
