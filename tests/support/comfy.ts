import assert from 'node:assert/strict';
import type { ServerWebSocket } from 'bun';

export interface ComfyPrompt {
  prompt_id: string;
  client_id: string;
  prompt: Record<string, { inputs: Record<string, unknown> }>;
  extra_data: {
    preview_method: string;
    tinytavern_job_id: number;
    extra_pnginfo: { workflow: { extra: Record<string, unknown> } };
  };
}
export interface ComfyExecution {
  id: string;
  state: 'queued' | 'running' | 'done' | 'cancelled';
  prompt: ComfyPrompt['prompt'];
  extra: ComfyPrompt['extra_data'];
  outputs: unknown;
}
export interface ComfyUpload {
  name: string;
  subfolder: string;
  data: Buffer;
}
type Reply = Response | Promise<Response>;

/** Protocol state stays local to one test; callbacks control acceptance and execution races. */
export function mockComfy(options: {
  submit: (body: ComfyPrompt, job: ComfyExecution) => Reply | void;
  upload?: (file: ComfyUpload) => void;
  view?: (url: URL, request: Request) => Reply;
}) {
  const jobs = new Map<string, ComfyExecution>();
  const uploads: ComfyUpload[] = [];
  const cancellations: string[] = [];
  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/upload/image') {
      const form = await request.formData();
      const image = form.get('image') as File;
      const file = {
        name: image.name,
        subfolder: String(form.get('subfolder')),
        data: Buffer.from(await image.arrayBuffer()),
      };
      uploads.push(file);
      options.upload?.(file);
      return Response.json({ name: file.name, subfolder: file.subfolder, type: 'input' });
    }
    if (url.pathname === '/prompt') {
      const body = (await request.json()) as ComfyPrompt;
      assert(!jobs.has(body.prompt_id), 'A Comfy prompt is submitted at most once');
      const job: ComfyExecution = {
        id: body.prompt_id,
        state: 'queued',
        prompt: body.prompt,
        extra: body.extra_data,
        outputs: {},
      };
      jobs.set(job.id, job);
      return (await options.submit(body, job)) ?? Response.json({ prompt_id: job.id });
    }
    if (url.pathname === '/queue') {
      const queue = (state: ComfyExecution['state']) =>
        [...jobs.values()].filter((job) => job.state === state).map((job) => [1, job.id]);
      return Response.json({ queue_running: queue('running'), queue_pending: queue('queued') });
    }
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.slice('/history/'.length);
      const job = jobs.get(id);
      return Response.json(
        job?.state === 'done'
          ? {
              [id]: { status: { completed: true, status_str: 'success' }, outputs: job.outputs },
            }
          : {},
      );
    }
    if (url.pathname.endsWith('/cancel')) {
      const id = url.pathname.split('/')[3]!;
      const job = jobs.get(id);
      if (job) job.state = 'cancelled';
      cancellations.push(id);
      return Response.json({ cancelled: Boolean(job) });
    }
    if (url.pathname === '/view' && options.view) return options.view(url, request);
    throw new Error(`Unexpected mock Comfy request: ${url.pathname}`);
  }
  return { jobs, uploads, cancellations, fetch };
}

export function serveComfy(fetch: (request: Request) => Reply, connectDelay = 0) {
  const sockets = new Map<string, ServerWebSocket<{ client: string }>>();
  const errors: unknown[] = [];
  const server = Bun.serve<{ client: string }>({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    websocket: {
      open(socket) {
        sockets.set(socket.data.client, socket);
      },
      message() {},
      close(socket) {
        sockets.delete(socket.data.client);
      },
    },
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === '/ws') {
        if (connectDelay) await Bun.sleep(connectDelay);
        if (server.upgrade(request, { data: { client: url.searchParams.get('clientId')! } }))
          return;
        return new Response(null, { status: 400 });
      }
      try {
        return await fetch(request);
      } catch (error) {
        errors.push(error);
        return new Response(null, { status: 500 });
      }
    },
  });
  return {
    sockets,
    errors,
    url: `http://127.0.0.1:${server.port}`,
    stop() {
      for (const socket of sockets.values()) socket.close();
      return server.stop(true);
    },
  };
}

export function comfyEvent(
  socket: ServerWebSocket<{ client: string }> | undefined,
  type: string,
  promptId: string,
  data: Record<string, unknown> = {},
) {
  socket?.send(JSON.stringify({ type, data: { prompt_id: promptId, ...data } }));
}
