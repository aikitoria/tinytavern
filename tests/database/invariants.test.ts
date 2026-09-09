import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { testApi } from '../support/http.ts';
import { conversationFixture, messageFixture } from '../support/fixtures.ts';

test('deep tree delete', async () => {
  const { existsSync } = await import('node:fs');

  const { basename, join } = await import('node:path');

  const { requireTestIsolation } = await import('../support/isolation.ts');

  requireTestIsolation();
  const { stmt, transaction, deleteMessageSubtrees, IMAGES_DIR } =
    await import('../../server/src/db/db.ts');
  const { deleteMessage, spliceMessage, getMessage, getActiveLeafId, setActiveLeaf } =
    await import('../../server/src/conversations/tree.ts');
  const { saveImage } = await import('../../server/src/media/images.ts');
  const { makePlaceholderPng } = await import('../../server/src/characters/pngCard.ts');
  await import('../../server/src/routes/conversations.ts');
  const { server, request: send } = await testApi();
  const conversation = () => conversationFixture({ title: 'Deep' });
  function chain(
    cid: number,
    depth: number,
    parent: number | null = null,
    reverseIds = false,
  ): number[] {
    return transaction(() => {
      const ids: number[] = [];
      for (let i = 0; i < depth; i++) {
        ids.push(messageFixture(cid, { content: 'deepdeletiontoken' }));
      }
      if (reverseIds) ids.reverse();
      for (let i = 0; i < ids.length; i++) {
        stmt('UPDATE messages SET parent_id=?, active_child_id=? WHERE id=?').run(
          ids[i - 1] ?? parent,
          ids[i + 1] ?? null,
          ids[i]!,
        );
      }
      if (parent !== null)
        stmt('UPDATE messages SET active_child_id=? WHERE id=?').run(ids[0]!, parent);
      stmt('UPDATE conversations SET active_leaf_id=? WHERE id=?').run(ids.at(-1)!, cid);
      return ids;
    });
  }
  function remaining(cid: number): number {
    return Number(stmt('SELECT count(*) AS n FROM messages WHERE conversation_id=?').get(cid)!.n);
  }
  const request = (method: string, path: string, body?: unknown) =>
    send(method, path, body, method === 'DELETE' && path !== '/api/conversations' ? 204 : 200);

  try {
    // Reverse numeric order models trees changed by rotations, without assuming ID topology.
    const cid = conversation();
    const parent = chain(cid, 1)[0]!;
    const doomed = chain(cid, 1100, parent, true);
    const survivor = chain(cid, 1, parent)[0]!;
    setActiveLeaf(cid, doomed.at(-1)!);
    const image = saveImage('.png', makePlaceholderPng());
    stmt('UPDATE messages SET images_json=? WHERE id=?').run(
      JSON.stringify([image]),
      doomed.at(-1)!,
    );
    stmt(`INSERT INTO media_jobs(id,operation,state,destination,context_conversation_id,message_id,created_at,updated_at)
    VALUES (9001,'image','queued','chat',?,?,1,1)`).run(cid, doomed.at(-1)!);
    deleteMessage(doomed[0]!);
    assert.equal(remaining(cid), 2);
    assert.equal(getActiveLeafId(cid), survivor);
    assert(!existsSync(join(IMAGES_DIR, basename(image))));
    const job = stmt('SELECT state,message_id FROM media_jobs WHERE id=9001').get()!;
    assert.equal(job.state, 'cancelling');
    assert.equal(job.message_id, null);

    // Detachment and deletion must roll back together if the surrounding operation fails.
    const rollbackCid = conversation();
    const rollbackIds = chain(rollbackCid, 1100);
    assert.throws(
      () =>
        transaction(() => {
          deleteMessageSubtrees([rollbackIds[0]!, rollbackIds[500]!]);
          throw new Error('outer rollback');
        }),
      /outer rollback/,
    );
    assert.equal(remaining(rollbackCid), 1100);
    assert.equal(getMessage(rollbackIds[500]!)!.parentId, rollbackIds[499]);
    deleteMessageSubtrees([rollbackIds[0]!, rollbackIds[500]!]);
    assert.equal(remaining(rollbackCid), 0);

    const spliceCid = conversation();
    const kept = chain(spliceCid, 1101);
    const removedSwipe = chain(spliceCid, 1100, null, true);
    setActiveLeaf(spliceCid, kept.at(-1)!);
    spliceMessage(kept[0]!);
    assert.equal(remaining(spliceCid), 1100);
    assert.equal(getMessage(kept[1]!)!.parentId, null);
    assert.equal(getMessage(removedSwipe[0]!), undefined);
    assert.equal(getActiveLeafId(spliceCid), kept.at(-1));

    const tailCid = conversation();
    const tailParent = chain(tailCid, 1)[0]!;
    const tail = chain(tailCid, 1100, tailParent);
    chain(tailCid, 1100, tailParent, true);
    setActiveLeaf(tailCid, tail.at(-1)!);
    const tailResult = await request('POST', `/api/conversations/${tailCid}/delete-tail`, {
      count: 1100,
      expectedMutationRevision: Number(
        stmt('SELECT mutation_revision FROM conversations WHERE id=?').get(tailCid)!
          .mutation_revision,
      ),
      expectedActiveLeafId: tail.at(-1),
    });
    assert.equal(tailResult.deletedSiblingRoots, 2);
    assert.equal(remaining(tailCid), 1);
    assert.equal(getActiveLeafId(tailCid), tailParent);

    const deleteCid = conversation();
    const deleteIds = chain(deleteCid, 1100);
    await request(
      'DELETE',
      `/api/conversations/${deleteCid}?expectedActiveLeafId=${deleteIds.at(-1)}&expectedMutationRevision=0`,
    );
    assert.equal(remaining(deleteCid), 0);

    chain(conversation(), 1100, null, true);
    await request('DELETE', '/api/conversations');
    assert.equal(stmt('SELECT count(*) AS n FROM messages').get()!.n, 0);
    assert.equal(
      stmt(
        "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'deepdeletiontoken'",
      ).get()!.n,
      0,
    );
    stmt("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)").run();
    assert.deepEqual(stmt('PRAGMA foreign_key_check').all(), []);
  } finally {
    await server.stop(true);
  }
});

// These plans guard linear work on unrelated rows during deletion and list reads.
test('foreign-key actions and ordered lists stay indexed', async () => {
  const { Database } = await import('bun:sqlite');
  using plans = new Database(process.env.DB_PATH!, { readonly: true });
  const plan = (sql: string) => {
    // Finalize EXPLAIN statements for writes; retaining them can hold an implicit transaction.
    using statement = plans.prepare<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`);
    return statement
      .all()
      .map((row) => row.detail)
      .join('\n');
  };
  for (const table of [
    'messages',
    'conversations',
    'media_assets',
    'characters',
    'personas',
    'endpoints',
    'presets',
    'templates',
    'character_folders',
  ]) {
    assert.doesNotMatch(
      plan(`DELETE FROM ${table} WHERE id=1`),
      /SCAN (?:messages|gallery_items|media_jobs|media_drafts|characters|conversations)\b/,
      table,
    );
  }
  assert.doesNotMatch(
    plan('SELECT * FROM gallery_items ORDER BY updated_at DESC,id DESC'),
    /TEMP B-TREE/,
  );
  assert.doesNotMatch(plan('SELECT * FROM conversations ORDER BY updated_at DESC'), /TEMP B-TREE/);
  assert.match(
    plan(
      'SELECT id FROM messages WHERE parent_id IS NULL AND conversation_id=1 ORDER BY id DESC LIMIT 1',
    ),
    /COVERING INDEX.*parent_id=\? AND conversation_id=\?/,
  );
  assert.match(
    plan("SELECT id FROM media_jobs WHERE state='failed' AND retention_deadline<=100"),
    /SEARCH.*state=\? AND retention_deadline</,
  );
});

test('online backup preserves committed state and refuses replacement', async () => {
  const { Database } = await import('bun:sqlite');
  const { spawnSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { readFileSync, statSync } = await import('node:fs');
  const { db, stmt, DATA_DIR } = await import('../../server/src/db/db.ts');
  const binary = new Uint8Array([0, 255, 128, 13]);
  const roundTrip = stmt('SELECT ? AS bytes').get(binary)!.bytes;
  assert(roundTrip instanceof Uint8Array);
  assert.deepEqual([...roundTrip], [...binary]);
  const cid = conversationFixture({ title: 'Backup' });
  const mid = messageFixture(cid, { role: 'user', content: 'backupftsprobe' });
  const target = join(DATA_DIR, 'backup.db');
  const run = () =>
    spawnSync(process.execPath, ['server/src/db/backup.ts', target], { encoding: 'utf8' });
  db.exec('BEGIN');
  try {
    stmt("UPDATE messages SET content='uncommitted' WHERE id=?").run(mid);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
  } finally {
    db.exec('ROLLBACK');
  }
  using copy = new Database(target, { readonly: true });
  assert.deepEqual(copy.query('PRAGMA integrity_check').get(), { integrity_check: 'ok' });
  assert.deepEqual(copy.query('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(copy.query('PRAGMA user_version').get(), { user_version: 68 });
  assert.deepEqual(copy.query('SELECT content FROM messages WHERE id=?').get(mid), {
    content: 'backupftsprobe',
  });
  assert.deepEqual(
    copy.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'backupftsprobe'").get(),
    { rowid: mid },
  );
  assert.equal(statSync(target).mode & 0o777, 0o600);
  const before = readFileSync(target);
  const again = run();
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /Refusing to overwrite/);
  assert.deepEqual(readFileSync(target), before);
});
