import { createServer } from 'node:http';
import { once } from 'node:events';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { stmt } = await import('../server/src/db.ts');
const { startImageRender } = await import('../server/src/comfy.ts');
const { getMessage } = await import('../server/src/tree.ts');

let passed = 0;
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`ASSERT FAILED: ${label}`);
  passed++;
  console.log(`  ok: ${label}`);
}

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
let failSubmission = false;
const mock = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/prompt') {
    if (failSubmission) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"intentional failure"}');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"prompt_id":"recency-test-job"}');
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/history/recency-test-job') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        'recency-test-job': {
          status: { completed: true },
          outputs: {
            output: { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] },
          },
        },
      }),
    );
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/view?')) {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    res.end(png);
    return;
  }
  if (req.method === 'DELETE' && req.url?.startsWith('/view?')) {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});
// Reject optional progress sockets immediately to avoid waiting for the fallback.
mock.on('upgrade', (_req, socket) => socket.destroy());
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
const address = mock.address();
if (address == null || typeof address === 'string') throw new Error('mock failed to listen');
const comfyUrl = `http://127.0.0.1:${address.port}`;
const workflow = '{"node":{"inputs":{"text":"{{prompt}}","seed":{{seed}}}}}';

function createConversation(updatedAt: number): number {
  return Number(
    stmt(
      `INSERT INTO conversations (title, speaker_name, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run('Image recency test', 'Assistant', updatedAt - 1, updatedAt).lastInsertRowid,
  );
}

function createPendingMessage(conversationId: number): number {
  return Number(
    stmt(
      `INSERT INTO messages
         (conversation_id, parent_id, role, content, status, created_at, generation_kind,
          images_json, active_image, image_pending, image_render_json)
       VALUES (?, NULL, 'tool', 'a tiny test image', 'done', ?, 'normal', '[]', 0, 1, ?)`,
    ).run(conversationId, Date.now(), JSON.stringify({ workflow, comfyUrl })).lastInsertRowid,
  );
}

async function waitUntilFinished(mid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (getMessage(mid)?.imagePending) {
    if (Date.now() >= deadline) throw new Error(`render ${mid} did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

try {
  const oldTimestamp = Date.now() - 60_000;
  const successConversation = createConversation(oldTimestamp);
  const successMessage = createPendingMessage(successConversation);
  startImageRender({
    conversationId: successConversation,
    mid: successMessage,
    comfyUrl,
    workflow,
    description: 'a tiny test image',
  });
  await waitUntilFinished(successMessage);
  const successUpdatedAt = (
    stmt('SELECT updated_at FROM conversations WHERE id = ?').get(successConversation) as {
      updated_at: number;
    }
  ).updated_at;
  assert(successUpdatedAt > oldTimestamp, 'successful render advances conversation recency');
  assert(getMessage(successMessage)?.images.length === 1, 'successful render stores its image');

  failSubmission = true;
  const failedTimestamp = Date.now() - 30_000;
  const failedConversation = createConversation(failedTimestamp);
  const failedMessage = createPendingMessage(failedConversation);
  startImageRender({
    conversationId: failedConversation,
    mid: failedMessage,
    comfyUrl,
    workflow,
    description: 'an intentionally failed image',
  });
  await waitUntilFinished(failedMessage);
  const failureUpdatedAt = (
    stmt('SELECT updated_at FROM conversations WHERE id = ?').get(failedConversation) as {
      updated_at: number;
    }
  ).updated_at;
  assert(
    failureUpdatedAt === failedTimestamp,
    'failed render does not advance conversation recency',
  );
  assert(
    Boolean(getMessage(failedMessage)?.genMeta?.imageError),
    'failed render records its error',
  );

  const cancelledTimestamp = Date.now() - 15_000;
  const cancelledConversation = createConversation(cancelledTimestamp);
  const cancelledMessage = createPendingMessage(cancelledConversation);
  const abort = new AbortController();
  abort.abort(new Error('intentional cancellation'));
  startImageRender({
    conversationId: cancelledConversation,
    mid: cancelledMessage,
    comfyUrl,
    workflow,
    description: 'a cancelled image',
    signal: abort.signal,
  });
  await waitUntilFinished(cancelledMessage);
  const cancellationUpdatedAt = (
    stmt('SELECT updated_at FROM conversations WHERE id = ?').get(cancelledConversation) as {
      updated_at: number;
    }
  ).updated_at;
  assert(
    cancellationUpdatedAt === cancelledTimestamp,
    'cancelled render does not advance conversation recency',
  );

  console.log(`\n${passed} image-recency assertions passed`);
} finally {
  mock.close();
}
