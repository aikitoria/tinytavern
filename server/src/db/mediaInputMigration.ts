import {
  normalizeMediaWorkflowInputs,
  type MediaWorkflow,
  type Settings,
} from '@tinytavern/shared';
import { stmt } from './db.ts';

/** Schema 73 prompt macros followed input order, even for names such as input5. */
export function migrateMediaInputs(): void {
  const settings = JSON.parse(
    String(stmt("SELECT value FROM settings WHERE key = 'app'").get()!.value),
  ) as Settings;
  const workflows = new Map(
    settings.mediaRendering.workflows.map((workflow) => [workflow.id, workflow]),
  );
  settings.mediaRendering.workflows = settings.mediaRendering.workflows.map(
    (workflow) => normalizeMediaWorkflowInputs(workflow, true).workflow,
  );
  settings.revision++;
  stmt("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(settings));

  const drafts = new Set<number>();
  for (const table of ['media_jobs', 'media_recipes'] as const) {
    const ownerType = table === 'media_jobs' ? 'job' : 'recipe';
    for (const row of stmt(`SELECT * FROM ${table}`).all()) {
      const config = row.configuration_json
        ? (JSON.parse(String(row.configuration_json)) as { workflow: MediaWorkflow })
        : null;
      const original = config?.workflow ?? workflows.get(String(row.workflow_id));
      if (!original) continue;
      const { workflow, slots } = normalizeMediaWorkflowInputs(original, true);
      if (workflow === original) continue;
      if (config) config.workflow = workflow;
      const inputs = (JSON.parse(String(row.inputs_json)) as { slot: string }[]).map((input) => ({
        ...input,
        slot: slots.get(input.slot) ?? input.slot,
      }));
      stmt(
        `UPDATE ${table} SET configuration_json = ?, inputs_json = ?${ownerType === 'job' ? ', revision = revision + 1' : ''} WHERE id = ?`,
      ).run(config ? JSON.stringify(config) : null, JSON.stringify(inputs), row.id!);
      // Remove all old keys before inserting new ones: names can exchange numbers.
      // Preserve only existing pins; deleted references must not regain ownership.
      const owners = stmt(
        'SELECT asset_id, slot FROM media_owners WHERE owner_type = ? AND owner_id = ?',
      ).all(ownerType, row.id!);
      const remapped = owners.filter(
        (owner) => ownerType === 'recipe' || String(owner.slot).startsWith('input:'),
      );
      for (const owner of remapped)
        stmt('DELETE FROM media_owners WHERE owner_type = ? AND owner_id = ? AND slot = ?').run(
          ownerType,
          row.id!,
          owner.slot!,
        );
      for (const owner of remapped) {
        const prefix = ownerType === 'job' ? 'input:' : '';
        const oldSlot = String(owner.slot).slice(prefix.length);
        stmt(
          'INSERT INTO media_owners(asset_id, owner_type, owner_id, slot) VALUES (?, ?, ?, ?)',
        ).run(owner.asset_id!, ownerType, row.id!, prefix + (slots.get(oldSlot) ?? oldSlot));
      }
      if (row.draft_id != null) drafts.add(Number(row.draft_id));
    }
  }
  for (const id of drafts)
    stmt('UPDATE media_drafts SET revision = revision + 1 WHERE id = ?').run(id);
}
