import { route, HttpError, type Ctx } from '../http/router.ts';
import { objectBody, positiveId } from '../http/validation.ts';
import { stmt } from '../db/db.ts';
import {
  activeMediaJobs,
  mediaJobDto,
  requireMediaJob,
  type MediaJobRow,
} from '../media/mediaJobStore.ts';
import {
  cancelMediaJob,
  createMediaJob,
  createMediaJobFromAsset,
  deleteMediaJob,
  editMediaJob,
  retryMediaRetrieval,
  startMediaJob,
} from '../media/mediaJobs.ts';
import {
  acceptMediaVariation,
  discardMediaDraft,
  mediaDraftJobs,
  selectMediaVariation,
} from '../media/mediaDrafts.ts';
import { tickMediaWorker } from '../media/mediaWorker.ts';
import { getMediaAssetInputs, getMediaAssetResultDetails } from '../media/mediaRecipes.ts';
import { publicMediaAsset } from '../media/mediaUrls.ts';

function jobForMutation(id: number, body: Record<string, unknown>) {
  if (!Number.isSafeInteger(body.expectedRevision)) {
    throw new HttpError(400, 'expectedRevision is required');
  }
  return requireMediaJob(id, body.expectedRevision);
}

route.get('/api/media/jobs', ({ req }) => {
  const query = new URL(req.url!, 'http://localhost').searchParams;
  const before = query.get('before');
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(query.get('limit')) || 100)));
  let rows;
  if (before === null) {
    rows = stmt('SELECT * FROM media_jobs ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
  } else {
    const separator = before.indexOf(':');
    const timestamp = Number(before.slice(0, separator));
    const id = Number(before.slice(separator + 1));
    if (separator < 1 || !Number.isSafeInteger(timestamp) || !Number.isSafeInteger(id) || id <= 0) {
      throw new HttpError(400, 'Invalid media history cursor');
    }
    rows = stmt(`
      SELECT * FROM media_jobs WHERE (created_at, id) < (?, ?)
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(timestamp, id, limit);
  }
  return (rows as unknown as MediaJobRow[]).map(mediaJobDto);
});

route.get('/api/media/jobs/active', activeMediaJobs);

route.get('/api/media/jobs/:id', ({ params }) =>
  mediaJobDto(requireMediaJob(positiveId(params.id, 'job ID'))),
);

route.post('/api/media/jobs', ({ body }) => createMediaJob(objectBody(body)));

route.get('/api/media/assets/:id/inputs', ({ params }) =>
  getMediaAssetInputs(positiveId(params.id, 'asset ID')).map((input) => ({
    ...input,
    asset: input.asset ? publicMediaAsset(input.asset) : null,
  })),
);

route.post('/api/media/assets/:id/rerun', ({ params, body }) =>
  createMediaJobFromAsset(positiveId(params.id, 'asset ID'), objectBody(body)),
);

route.get('/api/media/assets/:id/details', ({ params }) =>
  getMediaAssetResultDetails(positiveId(params.id, 'asset ID')),
);

/** All JSON job mutations validate the same revision before their synchronous action. */
function mutateJob(
  apply: (row: MediaJobRow, body: Record<string, unknown>) => unknown,
  tick = false,
) {
  return ({ params, body }: Ctx) => {
    const values = objectBody(body);
    const result = apply(jobForMutation(positiveId(params.id, 'job ID'), values), values);
    if (tick) queueMicrotask(tickMediaWorker);
    return result;
  };
}

route.patch('/api/media/jobs/:id', mutateJob(editMediaJob));
for (const action of ['prepare', 'render'] as const) {
  route.post(
    `/api/media/jobs/:id/${action}`,
    mutateJob((row, body) => startMediaJob(row, body, action === 'prepare'), true),
  );
}
route.post('/api/media/jobs/:id/cancel', mutateJob(cancelMediaJob, true));
route.post('/api/media/jobs/:id/retry-retrieval', mutateJob(retryMediaRetrieval, true));
route.post(
  '/api/media/jobs/:id/rerun',
  mutateJob((row, body) => createMediaJob(body, row)),
);
route.post('/api/media/jobs/:id/select', mutateJob(selectMediaVariation));
route.post('/api/media/jobs/:id/accept', mutateJob(acceptMediaVariation));
route.post(
  '/api/media/jobs/:id/discard',
  mutateJob((row, body) => {
    discardMediaDraft(row, body);
    return { ok: true };
  }, true),
);

route.del('/api/media/jobs/:id', ({ params, req }) => {
  const query = new URL(req.url!, 'http://localhost').searchParams;
  const revision = query.get('expectedRevision');
  const values = { expectedRevision: revision === null ? undefined : Number(revision) };
  deleteMediaJob(jobForMutation(positiveId(params.id, 'job ID'), values));
  return { ok: true };
});

route.get('/api/media/jobs/:id/variations', ({ params }) =>
  mediaDraftJobs(requireMediaJob(positiveId(params.id, 'job ID'))).map(mediaJobDto),
);
