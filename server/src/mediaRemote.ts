import { stmt, transaction } from './db.ts';
import { publishMediaJob } from './mediaJobStore.ts';

export interface ComfyFile {
  filename: string;
  subfolder: string;
  type: 'input' | 'output' | 'temp';
}
export interface RemoteFileRow extends ComfyFile {
  id: number;
  job_id: number;
  endpoint: string;
  purpose: string;
  state: 'owned' | 'pending' | 'deleted';
  retries: number;
  retry_at: number;
  error: string | null;
}

export function comfyFile(value: unknown): ComfyFile | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.filename !== 'string' ||
    !item.filename ||
    item.filename.includes('..') ||
    /[/\\\x00]/.test(item.filename)
  ) {
    return null;
  }
  if (
    typeof item.subfolder !== 'string' ||
    item.subfolder.split(/[/\\]/).includes('..') ||
    /^[/\\]/.test(item.subfolder) ||
    item.subfolder.includes('\0')
  ) {
    return null;
  }
  if (item.type !== 'input' && item.type !== 'output' && item.type !== 'temp') {
    return null;
  }
  return {
    filename: item.filename,
    subfolder: item.subfolder,
    type: item.type,
  };
}
export function comfyFileParams(file: ComfyFile): URLSearchParams {
  return new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder,
    type: file.type,
  });
}

/** Walk only job-scoped output metadata, including custom video-node arrays. */
export function comfyOutputFiles(value: unknown): ComfyFile[] {
  const result = new Map<string, ComfyFile>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 20 || !node || typeof node !== 'object') {
      return;
    }
    const file = comfyFile(node);
    if (file) {
      const identity = comfyFileParams(file).toString();
      result.set(identity, file);
      return;
    }
    for (const child of Object.values(node)) {
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
  return [...result.values()];
}

/** Persist before an upload, or immediately upon observing job output metadata. */
export function ownRemoteFile(
  jobId: number,
  endpoint: string,
  file: ComfyFile,
  purpose: string,
): RemoteFileRow {
  stmt(`INSERT INTO media_remote_files(job_id, endpoint, filename, subfolder, type, purpose)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(job_id, endpoint, filename, subfolder, type) DO NOTHING`).run(
    jobId,
    endpoint,
    file.filename,
    file.subfolder,
    file.type,
    purpose,
  );
  return stmt(
    `SELECT * FROM media_remote_files WHERE job_id = ? AND endpoint = ? AND filename = ? AND subfolder = ? AND type = ?`,
  ).get(jobId, endpoint, file.filename, file.subfolder, file.type) as unknown as RemoteFileRow;
}

export function releaseRemoteFiles(jobId: number, delayMs = 0): void {
  stmt(
    "UPDATE media_remote_files SET state = 'pending', retry_at = ? WHERE job_id = ? AND state = 'owned'",
  ).run(Date.now() + delayMs, jobId);
}
export function releaseRemoteFile(id: number): void {
  stmt(
    "UPDATE media_remote_files SET state = 'pending', retry_at = 0 WHERE id = ? AND state = 'owned'",
  ).run(id);
}

const cleaning = new Set<number>();

async function deleteRemoteFile(file: RemoteFileRow, signal?: AbortSignal): Promise<void> {
  if (cleaning.has(file.id)) {
    return;
  }
  cleaning.add(file.id);

  try {
    const timeout = AbortSignal.timeout(10_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(`${file.endpoint}/view?${comfyFileParams(file)}`, {
      method: 'DELETE',
      signal: requestSignal,
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) {
      throw new Error(`Comfy file deletion failed (${response.status})`);
    }

    // All pending owners of this exact file are satisfied by the same deletion.
    const owners = stmt(`
      SELECT DISTINCT job_id FROM media_remote_files
      WHERE endpoint = ? AND filename = ? AND subfolder = ? AND type = ?
        AND state = 'pending'
    `).all(file.endpoint, file.filename, file.subfolder, file.type);
    transaction(() => {
      stmt(`
        UPDATE media_remote_files
        SET state = 'deleted', error = NULL
        WHERE endpoint = ? AND filename = ? AND subfolder = ? AND type = ?
          AND state = 'pending'
      `).run(file.endpoint, file.filename, file.subfolder, file.type);
      stmt(`DELETE FROM media_remote_files
        WHERE endpoint = ? AND filename = ? AND subfolder = ? AND type = ?
          AND state = 'deleted'
          AND NOT EXISTS (SELECT 1 FROM media_jobs WHERE id = media_remote_files.job_id)
      `).run(file.endpoint, file.filename, file.subfolder, file.type);
    });
    for (const owner of owners) {
      publishMediaJob(Number(owner.job_id));
    }
  } catch (err) {
    if (signal?.aborted) {
      return;
    }
    const retryDelay = Math.min(3600_000, 1000 * 2 ** Math.min(file.retries, 12));
    const message = err instanceof Error ? err.message : String(err);
    stmt(`
      UPDATE media_remote_files
      SET retries = retries + 1, retry_at = ?, error = ?
      WHERE id = ? AND state = 'pending'
    `).run(Date.now() + retryDelay, message, file.id);
  } finally {
    cleaning.delete(file.id);
  }
}

/** Bounded cleanup is independent of visible job history and never blocks results. */
export async function drainRemoteCleanup(signal?: AbortSignal): Promise<void> {
  const rows = stmt(`
    SELECT * FROM media_remote_files f
    WHERE state = 'pending' AND retry_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM media_remote_files other
        WHERE other.endpoint = f.endpoint AND other.filename = f.filename
          AND other.subfolder = f.subfolder AND other.type = f.type
          AND other.state = 'owned'
      )
    ORDER BY retry_at, id
    LIMIT 4
  `).all(Date.now()) as unknown as RemoteFileRow[];

  await Promise.all(rows.map((file) => deleteRemoteFile(file, signal)));
}
