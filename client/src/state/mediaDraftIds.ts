import type { Settings, MediaSettingsTable } from '@tinytavern/shared';
import { mergeRemoteDraft, sameValue } from './editorSync.ts';

type Draft = Pick<Settings, 'mediaRendering' | 'mediaFavorites' | 'imageGeneration'>;
/** IDs assigned during a bulk import must also reach edits made while its save was in flight. */
type AssignedIds = Partial<Record<MediaSettingsTable, Record<string, string>>>;
function adoptMediaDraftIds(draft: Draft, ids: AssignedIds): Draft {
  const next = structuredClone(draft);
  const workflows = ids.media_workflows ?? {};
  const folders = ids.media_workflow_folders ?? {};
  const shortcuts = ids.media_shortcuts ?? {};
  const favorites = ids.media_favorites ?? {};
  const resolve = (map: Record<string, string>, value: string | null) => (value == null ? null : (map[value] ?? value));
  for (const workflow of next.mediaRendering.workflows) {
    workflow.id = resolve(workflows, workflow.id)!;
    if (workflow.folderId !== undefined) {
      workflow.folderId = resolve(folders, workflow.folderId);
    }
  }
  for (const folder of next.mediaRendering.folders) {
    folder.id = resolve(folders, folder.id)!;
  }
  for (const key of ['defaultWorkflowId', 'avatarWorkflowId', 'descriptionWorkflowId'] as const) {
    next.mediaRendering[key] = resolve(workflows, next.mediaRendering[key]);
  }
  for (const item of next.mediaRendering.shortcuts) {
    item.id = resolve(shortcuts, item.id)!;
    item.workflowId = resolve(workflows, item.workflowId)!;
  }
  for (const item of next.mediaFavorites) {
    item.id = resolve(favorites, item.id)!;
    item.workflowId = resolve(workflows, item.workflowId)!;
  }
  const avatar = next.imageGeneration.promptPresets?.avatar;
  if (avatar) {
    const map = ids.avatar_prompts ?? {};
    for (const item of avatar.presets) if (item.id) item.id = resolve(map, item.id)!;
    if (avatar.activeId != null) avatar.activeId = resolve(map, avatar.activeId);
  }
  return next;
}

/** Apply only edits made during the request, retaining canonical row metadata and ordering. */
function mergeSavedCollection<T extends { id?: string; name: string }>(submitted: T[], current: T[], saved: T[]): T[] {
  const submittedItems = new Map(submitted.map((item) => [item.id, item]));
  const savedItems = new Map(saved.map((item) => [item.id, item]));
  const merged = current.map((item) => {
    const before = submittedItems.get(item.id);
    const after = savedItems.get(item.id);
    if (!before || !after) {
      return item;
    }
    return mergeRemoteDraft({ ...before }, { ...item }, { ...after }, true).draft;
  });
  const membershipUnchanged = sameValue(
    submitted.map((item) => item.id),
    current.map((item) => item.id),
  );
  if (!membershipUnchanged) {
    return merged;
  }
  const mergedItems = new Map(merged.map((item) => [item.id, item]));
  return saved.map((item) => mergedItems.get(item.id) ?? item);
}

/** A successful save becomes the baseline; local edits made during it are reapplied by ID. */
export function reconcileMediaDraft(draft: Draft, submitted: Draft, saved: Draft, ids: AssignedIds = {}): Draft {
  const before = adoptMediaDraftIds(submitted, ids);
  const current = adoptMediaDraftIds(draft, ids);
  const merged = mergeRemoteDraft(before, current, saved, true).draft;
  merged.mediaRendering.workflows = mergeSavedCollection(
    before.mediaRendering.workflows,
    current.mediaRendering.workflows,
    saved.mediaRendering.workflows,
  );
  merged.mediaRendering.folders = mergeSavedCollection(
    before.mediaRendering.folders,
    current.mediaRendering.folders,
    saved.mediaRendering.folders,
  );
  merged.mediaRendering.shortcuts = mergeSavedCollection(
    before.mediaRendering.shortcuts,
    current.mediaRendering.shortcuts,
    saved.mediaRendering.shortcuts,
  );
  merged.mediaFavorites = mergeSavedCollection(before.mediaFavorites, current.mediaFavorites, saved.mediaFavorites);
  const beforeAvatar = before.imageGeneration.promptPresets?.avatar;
  const currentAvatar = current.imageGeneration.promptPresets?.avatar;
  const savedAvatar = saved.imageGeneration.promptPresets?.avatar;
  const mergedAvatar = merged.imageGeneration.promptPresets?.avatar;
  if (beforeAvatar && currentAvatar && savedAvatar && mergedAvatar) {
    mergedAvatar.presets = mergeSavedCollection(beforeAvatar.presets, currentAvatar.presets, savedAvatar.presets);
  }
  return structuredClone(merged);
}
