import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BASE, assert, req, patchConversation } from './helpers.ts';
import type { TemplatesFixture } from './templates.ts';
import type { SetupFixture } from './setup.ts';

export async function testSearch(
  fixture: Pick<TemplatesFixture, 'conv2'> & Pick<SetupFixture, 'dataDir'>,
) {
  const { conv2, dataDir } = fixture;

  console.log('== conversation search ==');
  const found = await req<{ conversation: { id: number }; snippet: string | null }[]>(
    'GET',
    `/api/search?q=${encodeURIComponent('prefix check')}`,
  );
  assert(
    found.some((r) => r.conversation.id === conv2.id && r.snippet?.includes('prefix check')),
    'search finds conversation by message content with snippet',
  );
  const prefixFound = await req<{ conversation: { id: number } }[]>(
    'GET',
    `/api/search?q=${encodeURIComponent('prefi')}`,
  );
  assert(
    prefixFound.some((r) => r.conversation.id === conv2.id),
    'content search matches word prefixes',
  );
  const pctConv = await req<{ id: number }>('POST', '/api/conversations', {});
  const pctConv2 = await req<{ id: number }>('POST', '/api/conversations', {});
  await patchConversation(pctConv.id, { title: 'pct 100% marker' });
  await patchConversation(pctConv2.id, { title: 'pct 100x marker' });
  const pctFound = await req<{ conversation: { id: number } }[]>(
    'GET',
    `/api/search?q=${encodeURIComponent('100%')}`,
  );
  assert(
    pctFound.some((r) => r.conversation.id === pctConv.id) &&
      !pctFound.some((r) => r.conversation.id === pctConv2.id),
    'title search treats LIKE wildcards as literals',
  );

  const searchSeed = new DatabaseSync(join(dataDir, 'minitavern.db'));
  searchSeed.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN');
  let crowdedSearchId: number;
  let otherSearchId: number;
  try {
    const insertConversation = searchSeed.prepare(
      `INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)`,
    );
    const now = Date.now();
    crowdedSearchId = Number(
      insertConversation.run('crowded search fixture', now, now).lastInsertRowid,
    );
    otherSearchId = Number(
      insertConversation.run('other search fixture', now, now + 1).lastInsertRowid,
    );
    const insertMessage = searchSeed.prepare(
      `INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', ?, ?)`,
    );
    for (let i = 0; i < 501; i++) {
      insertMessage.run(crowdedSearchId, 'starvationneedle starvationneedle', now + i);
    }
    insertMessage.run(otherSearchId, 'starvationneedle', now + 502);
    searchSeed.exec('COMMIT');
  } catch (err) {
    searchSeed.exec('ROLLBACK');
    searchSeed.close();
    throw err;
  }
  try {
    const completeSearch = await req<{ conversation: { id: number } }[]>(
      'GET',
      `/api/search?q=starvationneedle`,
    );
    assert(
      completeSearch.some((result) => result.conversation.id === crowdedSearchId) &&
        completeSearch.some((result) => result.conversation.id === otherSearchId),
      'content search dedupes before limiting so one conversation cannot starve another',
    );
    const controlSearch = await fetch(`${BASE}/api/search?q=%00`);
    assert(controlSearch.status === 400, 'content search rejects unsupported control characters');
  } finally {
    searchSeed
      .prepare('DELETE FROM conversations WHERE id IN (?, ?)')
      .run(crowdedSearchId, otherSearchId);
    searchSeed.close();
  }
}
