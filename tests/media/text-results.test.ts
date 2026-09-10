import assert from 'node:assert/strict';
import { newRequestId } from '@tinytavern/shared';
import { databaseCase } from '../support/database.ts';
import { conversationFixture } from '../support/fixtures.ts';
import { stmt } from '../../server/src/db/db.ts';
import { createMediaJob, startMediaJob } from '../../server/src/media/mediaJobs.ts';
import {
  requireMediaJob,
  updateMediaJob,
  mediaDraft,
} from '../../server/src/media/mediaJobStore.ts';
import { acceptMediaVariation, discardMediaDraft } from '../../server/src/media/mediaDrafts.ts';
import { finishMediaJob } from '../../server/src/media/mediaJobResults.ts';
import { appendMessage, getMessage, spliceMessages } from '../../server/src/conversations/tree.ts';
import { getSettings, putSettings } from '../../server/src/settings/settingsStore.ts';

databaseCase(
  'text results use guarded, idempotent chat acceptance and survive finishing',
  async () => {
    const workflow = {
      id: 'text',
      name: 'Text',
      textOutputNodeId: 'output',
      json: '{"output":{"inputs":{}}}',
      inputBindings: {},
      chatPromptPresetId: null,
      standalonePromptPresetId: null,
    };
    putSettings({
      ...getSettings(),
      mediaRendering: {
        ...getSettings().mediaRendering,
        workflows: [workflow],
      },
    });
    const conversationId = conversationFixture();
    appendMessage(conversationId, 'user', 'Describe this scene', null);
    const branch = () => {
      const row = stmt(
        'SELECT active_leaf_id, mutation_revision FROM conversations WHERE id = ?',
      ).get(conversationId)!;
      return {
        expectedActiveLeafId: row.active_leaf_id,
        expectedMutationRevision: row.mutation_revision,
      };
    };
    const job = createMediaJob({
      requestKey: newRequestId(),
      workflowId: workflow.id,
      contextConversationId: conversationId,
      destination: 'chat',
      reviewBeforeSave: true,
    });
    const accept = (body: Record<string, unknown> = {}) =>
      acceptMediaVariation(requireMediaJob(job.id), {
        assetId: null,
        expectedDraftRevision: mediaDraft(job.draft!.id).revision,
        ...branch(),
        ...body,
      });
    startMediaJob(requireMediaJob(job.id), {}, false);
    assert.throws(() => accept(), { status: 409 }, 'Incomplete text cannot be saved');
    updateMediaJob(job.id, { result_text: '  The complete description.\nSecond line.  ' });
    finishMediaJob(job.id, 'succeeded');
    const count = () => Number(stmt('SELECT count(*) AS n FROM messages').get()!.n);
    const before = count();
    const originalBranch = branch();
    assert.throws(() => accept({ expectedDraftRevision: -1 }), { status: 409 });
    assert.throws(() => accept({ expectedActiveLeafId: null }), { status: 409 });
    assert.throws(
      () =>
        accept({ expectedMutationRevision: Number(originalBranch.expectedMutationRevision) + 1 }),
      { status: 409 },
    );
    assert.equal(count(), before);
    const accepted = accept();
    assert.equal(count(), before + 1);
    const saved = getMessage(accepted.messageId!)!;
    assert.equal(saved.content, 'The complete description.\nSecond line.');
    const repeated = accept(originalBranch);
    assert.equal(repeated.messageId, saved.id);
    assert.equal(repeated.draft!.revision, accepted.draft!.revision);
    assert.equal(count(), before + 1);
    spliceMessages([saved.id]);
    assert.equal(requireMediaJob(job.id).message_id, null);
    const replacement = accept();
    assert.notEqual(replacement.messageId, saved.id);
    discardMediaDraft(requireMediaJob(job.id), {
      expectedDraftRevision: replacement.draft!.revision,
    });
    assert.equal(getMessage(replacement.messageId!)!.content, saved.content);
    assert.equal(stmt('SELECT id FROM media_jobs WHERE id = ?').get(job.id), null);

    const standalone = createMediaJob({
      requestKey: newRequestId(),
      workflowId: workflow.id,
      reviewBeforeSave: true,
    });
    updateMediaJob(standalone.id, { state: 'succeeded', result_text: 'A text result' });
    assert.throws(
      () =>
        acceptMediaVariation(requireMediaJob(standalone.id), {
          assetId: null,
          expectedDraftRevision: standalone.draft!.revision,
        }),
      { status: 400 },
      'The gallery cannot own a text-only result',
    );
  },
);
