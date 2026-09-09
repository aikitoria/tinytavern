// Separate process used by media/recovery.test.ts; all paths and endpoints are isolated.
import { requireTestIsolation } from './isolation.ts';
requireTestIsolation();
const { initMediaWorker } = await import('../../server/src/mediaWorker.ts');
const { sweepOrphanedImages } = await import('../../server/src/images.ts');
initMediaWorker();
sweepOrphanedImages();
process.send?.('ready');
// The IPC channel keeps the worker alive until the parent deliberately crashes it.
process.on('message', () => {});
