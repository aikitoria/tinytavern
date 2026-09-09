import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireTestIsolation } from './isolation.ts';

/** A small deterministic raster or AV1 WebM fixture, written only in isolated test data. */
export async function renderMediaFixture(
  file: string,
  width: number,
  height: number,
  video = false,
  duration = 0.2,
  threads = 1,
) {
  requireTestIsolation();
  await promisify(execFile)('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=blue:s=${width}x${height}:r=5:d=${duration}`,
    ...(video ? ['-c:v', 'libaom-av1', '-cpu-used', '8'] : ['-frames:v', '1']),
    '-threads',
    String(threads),
    '-y',
    file,
  ]);
}
