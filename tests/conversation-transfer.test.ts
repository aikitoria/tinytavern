// Run through npm test for isolated data; this script is destructive.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { IMAGES_DIR, stmt } = await import('../server/src/db.ts');
const { deleteImageFiles, saveImage } = await import('../server/src/images.ts');
const { exportPortableConversation, importPortableConversation } =
  await import('../server/src/routes/conversationTransfer.ts');
const { getPathToMessage } = await import('../server/src/tree.ts');

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
const sourceImages = [
  saveImage('transfer-source-a.png', png),
  saveImage('transfer-source-b.png', png),
];
const now = Date.now();
const convResult = stmt(
  `INSERT INTO conversations (title, speaker_name, scenario_override, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?)`,
).run('Portable tree', 'Narrator', 'A portable scenario', now - 1000, now);
const sourceConversationId = Number(convResult.lastInsertRowid);
const insert = stmt(
  `INSERT INTO messages
     (conversation_id, parent_id, role, content, reasoning, status, active_child_id,
      model, gen_meta_json, created_at, name, generation_kind, images_json,
      active_image, image_pending, image_render_json)
   VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
);
const root = Number(
  insert.run(
    sourceConversationId,
    null,
    'user',
    'Root prompt',
    null,
    'done',
    null,
    null,
    now - 900,
    null,
    'normal',
    '[]',
    0,
    null,
  ).lastInsertRowid,
);
// Middle splices can give parents greater IDs than their children.
const continuation = Number(
  insert.run(
    sourceConversationId,
    null,
    'assistant',
    'Older continuation',
    'reasoning',
    'done',
    'model-a',
    JSON.stringify({ note: 'kept' }),
    now - 800,
    'Narrator',
    'normal',
    '[]',
    0,
    null,
  ).lastInsertRowid,
);
const imagePrompt = Number(
  insert.run(
    sourceConversationId,
    root,
    'tool',
    'Long silver hair like the previous portrait',
    null,
    'done',
    null,
    null,
    now - 700,
    'Image',
    'normal',
    JSON.stringify(sourceImages),
    1,
    JSON.stringify({
      workflow: '{"node":{"inputs":{"text":"{{prompt}}","seed":{{seed}}}}}',
      comfyUrl: 'http://comfy:8588',
    }),
  ).lastInsertRowid,
);
const alternate = Number(
  insert.run(
    sourceConversationId,
    root,
    'tool',
    'Short red hair',
    null,
    'done',
    null,
    null,
    now - 600,
    'Image',
    'normal',
    JSON.stringify([sourceImages[0]]),
    0,
    null,
  ).lastInsertRowid,
);
stmt('UPDATE messages SET parent_id = ? WHERE id = ?').run(imagePrompt, continuation);
stmt('UPDATE messages SET active_child_id = ? WHERE id = ?').run(imagePrompt, root);
stmt('UPDATE messages SET active_child_id = ? WHERE id = ?').run(continuation, imagePrompt);
stmt('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run(
  continuation,
  sourceConversationId,
);

const portable = exportPortableConversation(sourceConversationId);
assert(
  portable.format === 'minitavern-conversation' && portable.version === 1,
  'schema is versioned',
);
assert(
  portable.conversation.scenarioOverride === 'A portable scenario',
  'conversation scenario override is exported',
);
assert(portable.assets.length === 2, 'all image alternatives are embedded');
assert(
  portable.messages
    .find((message) => message.id === imagePrompt)
    ?.imageRender?.workflow.includes('{{prompt}}'),
  'image prompt and render configuration are exported',
);

const countBeforeInvalid = (stmt('SELECT count(*) AS n FROM conversations').get() as { n: number })
  .n;
const invalid = structuredClone(portable);
invalid.messages.find((message) => message.id === root)!.parentId = continuation;
let rejected = false;
try {
  importPortableConversation(invalid);
} catch {
  rejected = true;
}
assert(rejected, 'cyclic trees are rejected');
assert(
  (stmt('SELECT count(*) AS n FROM conversations').get() as { n: number }).n === countBeforeInvalid,
  'invalid imports leave no conversation behind',
);

stmt('DELETE FROM conversations WHERE id = ?').run(sourceConversationId);
deleteImageFiles(sourceImages);
assert(
  sourceImages.every((path) => !existsSync(join(IMAGES_DIR, path.slice('/images/'.length)))),
  'source-server image files are absent before import',
);

const imported = importPortableConversation(portable);
assert(
  imported.scenarioOverride === 'A portable scenario',
  'conversation scenario override is imported',
);
const importedRows = stmt('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(
  imported.id,
) as Record<string, unknown>[];
assert(importedRows.length === 4, 'all branches import');
const importedLeaf = imported.activeLeafId!;
const path = getPathToMessage(importedLeaf);
assert(
  path.map((message) => message.content).join('|') ===
    'Root prompt|Long silver hair like the previous portrait|Older continuation',
  'parent links and selected deep branch round-trip',
);
const importedRoot = path[0]!;
const importedPrompt = path[1]!;
assert(importedRoot.activeChildId === importedPrompt.id, 'selected alternative is preserved');
assert(importedPrompt.activeChildId === importedLeaf, 'deep active-child link is preserved');
assert(
  importedPrompt.images.length === 2 && importedPrompt.activeImage === 1,
  'selected image alternative round-trips',
);
assert(
  importedPrompt.images.every(
    (path) =>
      !sourceImages.includes(path) &&
      existsSync(join(IMAGES_DIR, path.slice('/images/'.length))) &&
      readFileSync(join(IMAGES_DIR, path.slice('/images/'.length))).equals(png),
  ),
  'import writes independent, byte-identical image files',
);
const importedPromptRow = stmt('SELECT image_render_json FROM messages WHERE id = ?').get(
  importedPrompt.id,
) as { image_render_json: string };
assert(
  JSON.parse(importedPromptRow.image_render_json).workflow.includes('{{seed}}'),
  'stored render configuration still supports rerendering',
);
const sibling = importedRows.find((row) => row.content === 'Short red hair');
assert(sibling?.parent_id === importedRoot.id, 'inactive sibling branch round-trips');
const siblingImages = JSON.parse(sibling!.images_json as string) as string[];
assert(
  siblingImages.length === 1 &&
    siblingImages[0] !== importedPrompt.images[0] &&
    existsSync(join(IMAGES_DIR, siblingImages[0]!.slice('/images/'.length))),
  'a reused embedded asset gets per-message files with independent deletion ownership',
);

console.log(`\n${passed} conversation-transfer assertions passed`);
