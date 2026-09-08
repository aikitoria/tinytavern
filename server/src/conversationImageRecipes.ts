import { setMediaCharacters } from './mediaCharacters.ts';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import {
  DEFAULT_MEDIA_RENDERING,
  namedItem,
  mediaInputSlots,
  compileMediaWorkflow,
  validateWorkflowValues,
  type MediaWorkflowValues,
  type MediaInputSlot,
  type MediaWorkflow,
} from '@tinytavern/shared';
import { invalidateMediaAsset, mediaAssetForPath, stmt } from './db.ts';
import { copyImage, saveImage } from './images.ts';
import { HttpError } from './router.ts';
import { parseMediaRendering } from './mediaSettings.ts';
import { getSettings } from './settingsStore.ts';
import type { MediaJobConfiguration } from './mediaJobStore.ts';
import type { MediaRecipeInput } from './mediaRecipes.ts';

export interface TransferImageRecipe {
  workflowValues?: MediaWorkflowValues;
  id: string;
  prompt: string;
  instruction: string;
  workflow: MediaWorkflow;
  inputs: { slot: MediaInputSlot; assetId: string | null; prompt?: string }[];
}

export interface DecodedTransferImage {
  characterNames: string[];
  data: Buffer;
  ext: string;
  recipeId: string | null;
}

/** Follow local recipe inputs iteratively: addImage may append to the asset path map. */
export function exportImageRecipes(
  paths: Map<string, string>,
  addImage: (path: string) => string,
  messageRecipes: Iterable<string> = [],
) {
  const recipes = new Map<string, TransferImageRecipe>();
  const assetRecipes = new Map<string, string>();
  const addRecipe = (recipeId: string) => {
    let recipe = recipes.get(recipeId);
    if (!recipe) {
      const row = stmt('SELECT * FROM media_recipes WHERE id = ?').get(recipeId);
      if (!row) {
        throw new HttpError(409, 'Cannot export a missing image recipe');
      }
      const configuration = JSON.parse(String(row.configuration_json)) as MediaJobConfiguration;
      const workflow = configuration.workflow;
      const inputs = JSON.parse(String(row.inputs_json)) as MediaRecipeInput[];
      recipe = {
        workflowValues: configuration.workflowValues,
        id: `recipe-${recipes.size + 1}`,
        prompt: String(row.prompt),
        instruction: String(row.instruction),
        // Carry the rendering graph, without connection settings, execution IDs or presets.
        workflow: {
          id: workflow.id,
          name: workflow.name,
          operation: workflow.operation,
          referenceCount: workflow.referenceCount,
          json: workflow.json,
          galleryPromptPresetId: null,
          chatPromptPresetId: null,
        },
        inputs: mediaInputSlots(workflow.operation, workflow.referenceCount).map((slot) => {
          const input = inputs.find((candidate) => candidate.slot === slot);
          if (!input) {
            throw new HttpError(409, 'Cannot export an incomplete image recipe');
          }
          if (input.assetId === null) return { slot, assetId: null, prompt: input.prompt };
          const source = stmt('SELECT path, kind FROM media_assets WHERE id = ?').get(
            input.assetId,
          );
          if (!source || source.kind !== 'image') {
            throw new HttpError(409, 'Cannot export a missing image recipe reference');
          }
          return {
            slot: input.slot,
            assetId: addImage(String(source.path)),
            prompt: input.prompt,
          };
        }),
      };
      recipes.set(recipeId, recipe);
    }
    return recipe.id;
  };
  for (const recipeId of messageRecipes) {
    addRecipe(recipeId);
  }
  for (const [path, assetId] of paths) {
    const recipeId = mediaAssetForPath(path)?.recipeId;
    if (recipeId) assetRecipes.set(assetId, addRecipe(recipeId));
  }
  const recipeIds = new Map([...recipes].map(([id, recipe]) => [id, recipe.id]));
  return { recipes: [...recipes.values()], assetRecipes, recipeIds };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Invalid image recipe');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 200_000): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, `Image recipe ${label} must be a string`);
  }
  if (value.length > max) {
    throw new HttpError(400, `Image recipe ${label} is too long`);
  }
  return value;
}

export function parseImageRecipes(raw: unknown): Map<string, TransferImageRecipe> {
  if (raw === undefined) {
    return new Map();
  }
  if (!Array.isArray(raw) || raw.length > 1000) {
    throw new HttpError(400, 'Invalid image recipes');
  }
  const recipes = new Map<string, TransferImageRecipe>();
  for (const value of raw) {
    const source = object(value);
    const id = text(source.id, 'ID');
    if (!id || id.length > 200 || recipes.has(id)) {
      throw new HttpError(400, 'Image recipe IDs must be nonempty and unique');
    }
    const rendering = parseMediaRendering({
      ...DEFAULT_MEDIA_RENDERING,
      defaults: {},
      workflows: [
        { ...object(source.workflow), galleryPromptPresetId: null, chatPromptPresetId: null },
      ],
    })!;
    const workflow = rendering.workflows[0]!;
    if (
      workflow.operation === 'image-describe' ||
      workflow.operation.startsWith('video') ||
      !workflow.json.trim()
    ) {
      throw new HttpError(400, 'Image recipes require an image workflow');
    }
    const slots = mediaInputSlots(workflow.operation, workflow.referenceCount);
    if (!Array.isArray(source.inputs) || source.inputs.length !== slots.length) {
      throw new HttpError(400, 'Image recipe references do not match the workflow');
    }
    const inputs = source.inputs.map((rawInput, index) => {
      const input = object(rawInput);
      const slot = slots[index]!;
      if (input.slot !== slot) {
        throw new HttpError(400, 'Image recipe references must follow workflow slot order');
      }
      return {
        slot,
        assetId: input.assetId === null ? null : text(input.assetId, 'reference asset ID', 200),
        prompt: input.prompt === undefined ? undefined : text(input.prompt, 'reference prompt'),
      };
    });
    let workflowValues: MediaWorkflowValues | undefined;
    if (source.workflowValues !== undefined) {
      try {
        workflowValues = validateWorkflowValues(
          compileMediaWorkflow(workflow.json).controls,
          source.workflowValues,
        );
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }
    recipes.set(id, {
      id,
      prompt: text(source.prompt, 'prompt'),
      instruction: source.instruction === undefined ? '' : text(source.instruction, 'instruction'),
      workflow,
      inputs,
      workflowValues,
    });
  }
  return recipes;
}

/** Reject orphan pins and reference cycles before creating any files or rows. */
export function validateImageRecipeOwnership(
  assets: ReadonlyMap<string, DecodedTransferImage>,
  recipes: ReadonlyMap<string, TransferImageRecipe>,
  attached: ReadonlySet<string>,
  attachedRecipes: Iterable<string> = [],
): void {
  const visited = new Map<string, 'visiting' | 'done'>();
  const usedRecipes = new Set<string>();
  function visit(assetId: string): void {
    if (visited.get(assetId) === 'visiting') {
      throw new HttpError(400, 'Image recipes contain a reference cycle');
    }
    if (visited.get(assetId) === 'done') {
      return;
    }
    const asset = assets.get(assetId);
    if (!asset) {
      throw new HttpError(400, `Unknown recipe image asset ${assetId}`);
    }
    visited.set(assetId, 'visiting');
    if (asset.recipeId !== null) {
      const recipe = recipes.get(asset.recipeId);
      if (!recipe) {
        throw new HttpError(400, `Unknown image recipe ${asset.recipeId}`);
      }
      usedRecipes.add(recipe.id);
      for (const input of recipe.inputs) {
        if (input.assetId !== null) visit(input.assetId);
      }
    }
    visited.set(assetId, 'done');
  }
  for (const id of attached) {
    visit(id);
  }
  for (const id of attachedRecipes) {
    const recipe = recipes.get(id);
    if (!recipe) throw new HttpError(400, `Unknown message recipe ${id}`);
    usedRecipes.add(id);
    for (const input of recipe.inputs) {
      if (input.assetId !== null) visit(input.assetId);
    }
  }
  if (visited.size !== assets.size || usedRecipes.size !== recipes.size) {
    throw new HttpError(400, 'Export contains unused image assets or recipes');
  }
}

/** Called inside the import transaction, after the complete JSON has been validated. */
export function importRecipeImages(
  assets: ReadonlyMap<string, DecodedTransferImage>,
  recipes: ReadonlyMap<string, TransferImageRecipe>,
  writtenImages: string[],
): { imagePath: (assetId: string) => string; recipeIds: Map<string, string> } {
  const characters = stmt('SELECT id, name FROM characters')
    .all()
    .map((row) => ({ id: Number(row.id), name: String(row.name) }));
  const paths = new Map<string, string>();
  const assetIds = new Map<string, number>();
  for (const [id, asset] of assets) {
    const path = saveImage(`msg-import-${randomUUID()}${asset.ext}`, asset.data);
    writtenImages.push(path);
    paths.set(id, path);
    const assetId = mediaAssetForPath(path)!.id;
    assetIds.set(id, assetId);
    setMediaCharacters(
      assetId,
      asset.characterNames.flatMap((name) => {
        const character = namedItem(characters, name);
        return character ? [character.id] : [];
      }),
    );
  }
  const rendering = getSettings().mediaRendering;
  const recipeIds = new Map<string, string>();
  for (const recipe of recipes.values()) {
    const id = randomUUID();
    recipeIds.set(recipe.id, id);
    const inputs = recipe.inputs.map((input) => ({
      ...input,
      assetId: input.assetId === null ? null : assetIds.get(input.assetId)!,
      // Older exports already contain the source recipe, so imports can capture its prompt.
      prompt:
        input.prompt ??
        (input.assetId === null
          ? ''
          : (recipes.get(assets.get(input.assetId)?.recipeId ?? '')?.prompt ?? '')),
    }));
    stmt(`INSERT INTO media_recipes(id, prompt, instruction, configuration_json, inputs_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      id,
      recipe.prompt,
      recipe.instruction,
      JSON.stringify({
        comfyUrl: rendering.comfyUrl,
        timeoutSeconds: rendering.jobTimeoutSeconds,
        workflow: recipe.workflow,
        workflowValues: recipe.workflowValues,
      }),
      JSON.stringify(inputs),
      Date.now(),
    );
    for (const input of inputs) {
      if (input.assetId === null) continue;
      stmt(`INSERT INTO media_owners(asset_id, owner_type, owner_id, slot)
        VALUES (?, 'recipe', ?, ?)`).run(input.assetId, id, input.slot);
    }
  }
  for (const [id, asset] of assets) {
    if (asset.recipeId !== null) {
      stmt('UPDATE media_assets SET recipe_id = ? WHERE id = ?').run(
        recipeIds.get(asset.recipeId)!,
        assetIds.get(id)!,
      );
      invalidateMediaAsset(paths.get(id)!);
    }
  }
  const attached = new Set<string>();
  const imagePath = (assetId: string) => {
    const path = paths.get(assetId)!;
    if (!attached.has(assetId)) {
      attached.add(assetId);
      return path;
    }
    // Each message alternative retains independent deletion ownership, as in legacy imports.
    const copy = copyImage(path, `msg-import-${randomUUID()}${extname(path)}`);
    if (!copy) {
      throw new Error('Imported image disappeared before attachment');
    }
    writtenImages.push(copy);
    return copy;
  };
  return { imagePath, recipeIds };
}
