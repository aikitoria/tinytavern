// Separate process used by media/recovery.test.ts; all paths and endpoints are isolated.
import { requireTestIsolation } from './isolation.ts';
requireTestIsolation();
const { initMediaWorker } = await import('../../server/src/media/mediaWorker.ts');
const { sweepOrphanedImages } = await import('../../server/src/media/images.ts');
const { mediaLive, observeMediaJob } = await import('../../server/src/media/mediaJobStore.ts');
initMediaWorker();
sweepOrphanedImages();
process.send?.('ready');
// The IPC channel keeps the worker alive until the parent deliberately crashes it.
process.on('message', (id) => {
  if (typeof id !== 'number') return;
  const sendPreview = () => process.send?.({ id, progress: mediaLive.get(id)?.progress });
  observeMediaJob(id, sendPreview);
  sendPreview();
});
