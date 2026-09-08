import { imageConfig } from './imageConfig.ts';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { MessageRow } from '../server/src/routes/conversationCopies.ts';
import { requireTestIsolation } from './isolation.ts';

requireTestIsolation();
const { IMAGES_DIR, stmt, toConversation, toMessage } = await import('../server/src/db.ts');
const { saveImage, deleteImageFiles } = await import('../server/src/images.ts');
const { copyConversation, copyMessageImages, insertCopiedMessage } =
  await import('../server/src/routes/conversationCopies.ts');
const { createImageRecipe } = await import('../server/src/mediaRecipes.ts');
const { makePlaceholderPng } = await import('../server/src/pngCard.ts');

const png = makePlaceholderPng();
const images = ['/images/missing.png', saveImage('.png', png), saveImage('.png', png)];
const now = Date.now();
const id = Number(
  stmt('INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)').run(
    'Source',
    now,
    now,
  ).lastInsertRowid,
);
const messageId = Number(
  stmt(`INSERT INTO messages
  (conversation_id, role, content, reasoning, status, model, gen_meta_json, created_at, images_json, active_image, image_pending, render_recipe_id)
  VALUES (?, 'assistant', 'persisted', 'persisted reasoning', 'streaming', 'model', '{"test":true}', ?, ?, 1, 1, ?)`).run(
    id,
    now,
    JSON.stringify(images),
    createImageRecipe(
      imageConfig('{"1":{"inputs":{"text":"{{prompt}}"}}}', 'http://comfy.invalid'),
      'persisted',
    ),
  ).lastInsertRowid,
);
const source = toConversation(stmt('SELECT * FROM conversations WHERE id = ?').get(id)!);
const row = stmt('SELECT * FROM messages WHERE id = ?').get(messageId)!;
const live = { ...toMessage(row), content: 'live content', reasoning: 'live reasoning' };
assert.deepEqual(
  live.media.map((asset) => asset.url),
  images,
  'Attachment order includes a missing file rather than shifting the selected asset',
);
assert.equal(live.media[live.activeImage]!.url, images[1]);
assert.equal('images' in live, false, 'The live DTO has one ordered attachment representation');
let copiedMessageId = 0;
const copiedConversationId = copyConversation(source, ' (copy)', (conversationId, written) => {
  copiedMessageId = insertCopiedMessage(
    conversationId,
    null,
    row as unknown as MessageRow,
    live,
    written,
  );
});
const copiedRow = stmt('SELECT * FROM messages WHERE id = ?').get(copiedMessageId)!;
const copied = toMessage(copiedRow);
assert.equal(copied.conversationId, copiedConversationId);
assert.equal(copied.content, live.content);
assert.equal(copied.reasoning, live.reasoning);
assert.equal(copied.status, 'stopped');
assert.equal(copied.imagePending, false);
assert.equal(copiedRow.render_recipe_id, row.render_recipe_id);
assert.equal(copiedRow.gen_meta_json, row.gen_meta_json);
assert.equal(copied.media.length, 2);
for (const asset of copied.media) {
  assert.match(
    asset.url,
    new RegExp(`^/images/media-${asset.id}\\.(png|jpe?g|webp|webm)$`),
    'Copies of legacy paths use ownership-neutral original names',
  );
}
assert.equal(
  copied.activeImage,
  0,
  'selected A retains its identity after the preceding missing file is skipped',
);
assert.notEqual(copied.media[0]!.url, images[1]);
assert.deepEqual(readFileSync(join(IMAGES_DIR, basename(copied.media[0]!.url))), png);

for (const [selected, expected] of [
  [0, 0],
  [1, 0],
  [2, 1],
]) {
  const written: string[] = [];
  const result = copyMessageImages({ media: live.media, activeImage: selected! }, written);
  assert.equal(result.activeImage, expected);
  deleteImageFiles(written);
}
const filesBefore = readdirSync(IMAGES_DIR).sort();
const countBefore = stmt('SELECT COUNT(*) AS n FROM conversations').get()!.n;
assert.throws(
  () =>
    copyConversation(source, ' (failed)', (conversationId, written) => {
      insertCopiedMessage(conversationId, null, row as unknown as MessageRow, live, written);
      throw new Error('injected after copy');
    }),
  /injected after copy/,
);
assert.equal(stmt('SELECT COUNT(*) AS n FROM conversations').get()!.n, countBefore);
assert.deepEqual(readdirSync(IMAGES_DIR).sort(), filesBefore, 'rolled-back copies leave no files');

deleteImageFiles(images);
for (const asset of copied.media)
  assert.ok(existsSync(join(IMAGES_DIR, basename(asset.url))), 'copy owns files independently');
console.log(
  'Conversation copies: missing-file selection, snapshots, independent ownership and rollback passed.',
);
