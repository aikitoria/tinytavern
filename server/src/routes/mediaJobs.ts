import { route, HttpError } from '../router.ts';
import { objectBody, positiveId } from '../validation.ts';
import { stmt } from '../db.ts';
import { mediaJobDto, requireMediaJob, type MediaJobRow } from '../mediaJobStore.ts';
import {
  cancelMediaJob,
  createMediaJob,
  createMediaJobFromAsset,
  deleteMediaJob,
  editMediaJob,
  retryMediaRetrieval,
  startMediaJob,
} from '../mediaJobs.ts';
import {
  acceptMediaVariation,
  discardMediaDraft,
  mediaDraftJobs,
  selectMediaVariation,
} from '../mediaDrafts.ts';
import { tickMediaWorker } from '../mediaWorker.ts';
import { getMediaAssetInputs } from '../mediaRecipes.ts';
import { publicMediaAsset } from '../mediaUrls.ts';

function jobForMutation(id: string, body: Record<string, unknown>) {
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
    const id = before.slice(separator + 1);
    if (separator < 1 || !Number.isInteger(timestamp) || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
      throw new HttpError(400, 'Invalid media history cursor');
    }
    rows = stmt(`
      SELECT * FROM media_jobs WHERE created_at < ? OR (created_at = ? AND id < ?)
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(timestamp, timestamp, id, limit);
  }
  return (rows as unknown as MediaJobRow[]).map(mediaJobDto);
});

route.get('/api/media/jobs/active', () => {
  const rows = stmt(`
    SELECT * FROM media_jobs
    WHERE state NOT IN ('draft', 'ready', 'succeeded', 'failed', 'cancelled')
    ORDER BY created_at, id
  `).all() as unknown as MediaJobRow[];
  return rows.map(mediaJobDto);
});

route.get('/api/media/jobs/:id', ({ params }) => mediaJobDto(requireMediaJob(params.id!)));

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

route.patch('/api/media/jobs/:id', ({ params, body }) => {
  const values = objectBody(body);
  return editMediaJob(jobForMutation(params.id!, values), values);
});

for (const action of ['prepare', 'render'] as const) {
  route.post(`/api/media/jobs/:id/${action}`, ({ params, body }) => {
    const values = objectBody(body);
    const result = startMediaJob(jobForMutation(params.id!, values), values, action === 'prepare');
    queueMicrotask(tickMediaWorker);
    return result;
  });
}

route.post('/api/media/jobs/:id/cancel', ({ params, body }) => {
  const values = objectBody(body);
  const result = cancelMediaJob(jobForMutation(params.id!, values));
  queueMicrotask(tickMediaWorker);
  return result;
});

route.post('/api/media/jobs/:id/retry-retrieval', ({ params, body }) => {
  const result = retryMediaRetrieval(jobForMutation(params.id!, objectBody(body)));
  queueMicrotask(tickMediaWorker);
  return result;
});

route.post('/api/media/jobs/:id/rerun', ({ params, body }) => {
  const values = objectBody(body);
  const source = jobForMutation(params.id!, values);
  return createMediaJob(values, source);
});

route.del('/api/media/jobs/:id', ({ params, req }) => {
  const query = new URL(req.url!, 'http://localhost').searchParams;
  const revision = query.get('expectedRevision');
  const values = { expectedRevision: revision === null ? undefined : Number(revision) };
  deleteMediaJob(jobForMutation(params.id!, values));
  return { ok: true };
});

route.get('/api/media/jobs/:id/variations', ({ params }) =>
  mediaDraftJobs(requireMediaJob(params.id!)).map(mediaJobDto),
);

for (const action of ['select', 'accept', 'discard'] as const) {
  route.post(`/api/media/jobs/:id/${action}`, ({ params, body }) => {
    const values = objectBody(body);
    const row = jobForMutation(params.id!, values);
    if (action === 'select') return selectMediaVariation(row, values);
    if (action === 'accept') return acceptMediaVariation(row, values);
    discardMediaDraft(row, values);
    queueMicrotask(tickMediaWorker);
    return { ok: true };
  });
}
