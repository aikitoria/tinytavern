import { createWriteStream } from 'node:fs';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { IMAGES_DIR } from './db.ts';
import { rasterImageFormat } from './images.ts';
import { imageDimensions } from './imageDimensions.ts';
import type { MediaKind } from '@tinytavern/shared';

const runFile = promisify(execFile);

export class InvalidMediaOutput extends Error {}

interface VideoProbe {
  streams?: {
    codec_name?: string;
    width?: number;
    height?: number;
  }[];
  format?: {
    format_name?: string;
    duration?: string;
  };
}

export interface DownloadedMedia {
  path: string;
  kind: MediaKind;
  mime: string;
  byteSize: number;
  width: number;
  height: number;
  duration: number | null;
}

async function syncFile(path: string): Promise<void> {
  const file = await open(path, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** FFprobe uses the same demuxer name for Matroska and WebM; read the EBML DocType. */
async function hasWebmHeader(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  let header: Buffer;
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    header = buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
  if (header.length < 5 || header.readUInt32BE(0) !== 0x1a45dfa3) {
    return false;
  }
  let offset = 4;
  function readNumber(isId: boolean): number | null {
    const first = header[offset++];
    if (!first) {
      return null;
    }
    let marker = 0x80;
    let length = 1;
    while ((first & marker) === 0) {
      marker >>= 1;
      length++;
    }
    if (offset + length - 1 > header.length || (isId && length > 4)) {
      return null;
    }
    let value = isId ? first : first & (marker - 1);
    for (let index = 1; index < length; index++) {
      value = value * 256 + header[offset++]!;
      if (!isId && value > header.length) {
        return null;
      }
    }
    return value;
  }
  const length = readNumber(false);
  if (length === null || offset + length > header.length) {
    return false;
  }
  const end = offset + length;
  let docType: string | undefined;
  while (offset < end) {
    const id = readNumber(true);
    const size = readNumber(false);
    if (id === null || size === null || offset + size > end) {
      return false;
    }
    if (id === 0x4282) {
      if (docType !== undefined) {
        return false;
      }
      docType = header.toString('latin1', offset, offset + size);
    }
    offset += size;
  }
  return docType === 'webm';
}

async function readVideoMetadata(path: string, signal: AbortSignal) {
  if (!(await hasWebmHeader(path))) {
    throw new InvalidMediaOutput('Comfy must return AV1 video in a WebM container');
  }
  const args = [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name,width,height:format=format_name,duration',
    '-of',
    'json',
    path,
  ];
  const { stdout } = await runFile('ffprobe', args, {
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    signal,
  });
  const probe = JSON.parse(stdout) as VideoProbe;
  const video = probe.streams?.[0];
  const isWebm = probe.format?.format_name?.split(',').includes('webm');
  if (!isWebm || video?.codec_name !== 'av1' || !video.width || !video.height) {
    throw new InvalidMediaOutput('Comfy must return AV1 video in a WebM container');
  }

  const seconds = Number(probe.format?.duration);
  return {
    width: video.width,
    height: video.height,
    duration: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
  };
}

/** Stream originals to disk; only raster validation uses a bounded memory buffer. */
export async function downloadMedia(
  response: Response,
  name: string,
  kind: MediaKind,
  signal: AbortSignal,
): Promise<DownloadedMedia> {
  if (!response.ok || !response.body) {
    throw new Error(`Comfy download failed (${response.status})`);
  }
  const stem = basename(name);
  const temporary = join(IMAGES_DIR, `${stem}.part`);
  const limit = kind === 'video' ? 1024 * 1024 * 1024 : 64 * 1024 * 1024;
  let byteSize = 0;
  let finalized: string | undefined;
  try {
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body.cancel();
      throw new InvalidMediaOutput('Generated media exceeds the file size limit');
    }
    const source = Readable.fromWeb(response.body as ReadableStream);
    const sizeLimiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += chunk.length;
        if (byteSize > limit) {
          callback(new InvalidMediaOutput('Generated media exceeds the file size limit'));
          return;
        }
        callback(null, chunk);
      },
    });
    const destination = createWriteStream(temporary, { flags: 'wx' });
    await pipeline(source, sizeLimiter, destination, { signal });

    let ext: string;
    let mime: string;
    let width: number;
    let height: number;
    let duration: number | null = null;
    if (kind === 'image') {
      const data = await readFile(temporary);
      const format = rasterImageFormat(data);
      const size = format && imageDimensions(data);
      if (!format || !size) {
        throw new InvalidMediaOutput('Comfy returned an unsupported or invalid raster image');
      }
      ext = format.ext;
      mime = format.mime;
      width = size.width;
      height = size.height;
    } else {
      const metadata = await readVideoMetadata(temporary, signal);
      width = metadata.width;
      height = metadata.height;
      duration = metadata.duration;
      ext = '.webm';
      mime = 'video/webm';
    }
    await syncFile(temporary);
    finalized = join(IMAGES_DIR, `${stem}${ext}`);
    await rename(temporary, finalized);
    await syncFile(IMAGES_DIR);
    return {
      path: `/images/${basename(finalized)}`,
      kind,
      mime,
      byteSize,
      width,
      height,
      duration,
    };
  } catch (err) {
    const discardPaths = [temporary];
    if (finalized) {
      discardPaths.push(finalized);
    }
    await Promise.all(discardPaths.map((path) => rm(path, { force: true })));
    throw err;
  }
}
