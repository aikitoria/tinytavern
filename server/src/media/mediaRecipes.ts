import type { MediaAssetInput, MediaImageConfig, MediaResultDetails } from '@tinytavern/shared';
import type { MediaJobInput, Message } from '@tinytavern/shared';
import { stmt, toMediaAsset } from '../db/db.ts';
import { getSettings } from '../settings/settingsStore.ts';
import { HttpError } from '../http/router.ts';
import type { MediaJobConfiguration } from './mediaJobStore.ts';

export interface MediaRecipeInput {
  slot: MediaJobInput['slot'];
  assetId: number | null;
  prompt: string;
}

export interface MediaRecipe {
  id: number;
  prompt: string;
  instruction: string;
  configuration: MediaJobConfiguration & { seed?: number | null };
  inputs: MediaRecipeInput[];
}

export function saveMediaRecipe(
  configuration: MediaJobConfiguration,
  inputs: MediaRecipeInput[],
  prompt: string,
  options: { id?: number; instruction?: string; seed?: number | null } = {},
): number {
  const instruction = options.instruction ?? '';
  inputs = inputs.map((input) => ({
    ...input,
    assetId:
      input.assetId !== null &&
      stmt('SELECT id FROM media_assets WHERE id = ? AND reference_deleted = 0').get(input.assetId)
        ? input.assetId
        : null,
  }));
  const { comfyUrl, workflow, timeoutSeconds, workflowValues, characterIds } = configuration;
  const inserted = stmt(`
    INSERT INTO media_recipes(id, prompt, instruction, configuration_json, inputs_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET prompt = excluded.prompt, instruction = excluded.instruction,
      configuration_json = excluded.configuration_json, inputs_json = excluded.inputs_json
  `).run(
    options.id ?? null,
    prompt,
    instruction,
    JSON.stringify({
      comfyUrl,
      workflow,
      timeoutSeconds,
      workflowValues,
      characterIds,
      seed: options.seed ?? null,
    }),
    JSON.stringify(inputs),
    Date.now(),
  );
  const id = options.id ?? Number(inserted.lastInsertRowid);
  stmt("DELETE FROM media_owners WHERE owner_type = 'recipe' AND owner_id = ?").run(id);
  for (const input of inputs) {
    if (input.assetId === null) continue;
    stmt(`INSERT OR IGNORE INTO media_owners(asset_id, owner_type, owner_id, slot)
      VALUES (?, 'recipe', ?, ?)`).run(input.assetId, id, input.slot);
  }
  return id;
}

/** Image prompt commands capture the selected complete workflow before text generation. */
export function imageRenderConfiguration(config: MediaImageConfig): MediaJobConfiguration {
  return {
    comfyUrl: config.comfyUrl,
    workflow: config.workflow,
    timeoutSeconds: getSettings().mediaRendering.jobTimeoutSeconds,
  };
}

export function createImageRecipe(config: MediaImageConfig, prompt: string): number {
  return saveMediaRecipe(imageRenderConfiguration(config), [], prompt);
}

export function getMediaRecipe(id: number): MediaRecipe {
  const row = stmt('SELECT * FROM media_recipes WHERE id = ?').get(id);
  if (!row) {
    throw new HttpError(404, 'The rendering recipe is unavailable');
  }
  return {
    id,
    prompt: String(row.prompt),
    instruction: String(row.instruction),
    configuration: JSON.parse(String(row.configuration_json)),
    inputs: JSON.parse(String(row.inputs_json)),
  };
}

export function getMediaAssetResultDetails(assetId: number): MediaResultDetails {
  const asset = stmt(`SELECT recipe_id FROM media_assets a
    WHERE id = ? AND EXISTS (SELECT 1 FROM media_owners o WHERE o.asset_id = a.id)`).get(assetId);
  if (!asset) throw new HttpError(404, 'Media asset not found');
  if (!asset.recipe_id) throw new HttpError(404, 'The rendering recipe is unavailable');
  const recipe = getMediaRecipe(Number(asset.recipe_id));
  // Older recipes can recover their seed while their original job still exists.
  const seed =
    recipe.configuration.seed ??
    (stmt('SELECT seed FROM media_jobs WHERE recipe_id = ?').get(recipe.id)?.seed as
      number | null | undefined) ??
    null;
  return {
    instruction: recipe.instruction,
    prompt: recipe.prompt,
    workflowSnapshot: recipe.configuration.workflow ?? null,
    workflowValues: recipe.configuration.workflowValues ?? {},
    seed,
  };
}

/** Keep the original slot visible when its source image has been deleted. */
export function getMediaAssetInputs(assetId: number): MediaAssetInput[] {
  const asset = stmt(`SELECT recipe_id FROM media_assets a
    WHERE id = ? AND EXISTS (SELECT 1 FROM media_owners o WHERE o.asset_id = a.id)`).get(assetId);
  if (!asset) throw new HttpError(404, 'Media asset not found');
  if (!asset.recipe_id) return [];
  return stmt(`
    SELECT a.*, json_extract(input.value, '$.slot') AS input_slot
    FROM media_recipes r, json_each(r.inputs_json) input
    LEFT JOIN media_assets a ON a.id = json_extract(input.value, '$.assetId')
      AND a.reference_deleted = 0
    WHERE r.id = ? ORDER BY CAST(input.key AS INTEGER)
  `)
    .all(asset.recipe_id)
    .map((row) => ({
      slot: row.input_slot as MediaAssetInput['slot'],
      asset: row.id === null ? null : toMediaAsset(row),
    }));
}

export function messageRecipeId(message: Message): number | null {
  const asset = message.media[Math.min(message.activeImage, message.media.length - 1)];
  if (asset?.recipeId) {
    return asset.recipeId;
  }
  return (
    (stmt('SELECT render_recipe_id FROM messages WHERE id = ?').get(message.id)
      ?.render_recipe_id as number | null) ?? null
  );
}
